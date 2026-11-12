/**
 * Журнал программ на сервере: приём пачек с компьютеров, просмотр, уборка.
 *
 * Решает сервер, а не окно: кто видит (владелец и администратор — всё, с
 * именами; разработчик — только свои программы и без людей, как счётчики
 * сбоев), сколько принимать (предел частоты и размера пачки), как долго
 * хранить (срок и общее число строк). Содержимого вызовов и данных проектов в
 * записях нет: форму проверяет `validEntry`, а не доверие к клиенту.
 */
import type { Express, Request, Response } from 'express';
import { JOURNAL_CATEGORIES, JOURNAL_LEVELS, JOURNAL_LIMITS, anonymize, validEntry, type JournalEntry } from '../modules/journal/model.js';
import { parseReleaseClaim } from '../modules/trust/claims.js';
import { openEnvelope } from '../modules/trust/envelope.js';
import { loadTrust, MODULE_ROOT_KEY_HEX } from './moduleStore.js';
import { positionsOf } from './moduleChannels.js';

export interface JournalDeps {
  getPrisma: () => any;
  can?: (user: any, feature: string) => boolean;
  rootHex: () => string;
}

const userOf = (req: Request) => (req as any).authUser || {};
const isAdmin = (req: Request) => ['OWNER', 'ADMIN'].includes(userOf(req).role);
const fail = (res: Response, status: number, error: string) => res.status(status).json({ error });
const DAY = 86_400_000;

/** Приём: не больше 30 пачек в минуту от человека; окно ограничено памятью, а не базой */
const windows = new Map<string, { at: number; n: number }>();
export const BATCHES_PER_MINUTE = 30;
function allowBatch(userId: string, now: number): boolean {
  const w = windows.get(userId);
  if (!w || now - w.at >= 60_000) { windows.set(userId, { at: now, n: 1 }); if (windows.size > 5000) windows.clear(); return true; }
  return ++w.n <= BATCHES_PER_MINUTE;
}

/** Программы, выпущенные по сертификату этого человека: только их журнал он видит */
const developerCache = new Map<string, { at: number; modules: Set<string> }>();
/** Список своих программ разработчика читает все выпуски и проверяет подписи: минуту он держится в памяти */
export const DEVELOPER_CACHE_MS = 60_000;
export async function modulesOfDeveloper(db: any, userId: string, rootHex: string, now = Date.now()): Promise<Set<string>> {
  const hit = developerCache.get(userId);
  if (hit && now - hit.at < DEVELOPER_CACHE_MS) return hit.modules;
  const modules = await loadDeveloperModules(db, userId, rootHex);
  if (developerCache.size > 2000) developerCache.clear();
  developerCache.set(userId, { at: now, modules });
  return modules;
}
async function loadDeveloperModules(db: any, userId: string, rootHex: string): Promise<Set<string>> {
  const [releases, trust] = await Promise.all([db.moduleRelease.findMany({ select: { moduleId: true, signature: true }, take: 20000 }), loadTrust(db, rootHex)]);
  const out = new Set<string>();
  for (const r of releases) {
    const claim = parseReleaseClaim(openEnvelope('release', r.signature, rootHex));
    if (claim && trust.certificates.get(claim.author)?.userId === userId) out.add(claim.moduleId);
  }
  return out;
}

export async function acceptJournal(db: any, user: any, raw: unknown, now = Date.now()): Promise<{ accepted: number; rejected: number }> {
  const list = Array.isArray((raw as any)?.entries) ? (raw as any).entries.slice(0, JOURNAL_LIMITS.batch) : [];
  const valid: JournalEntry[] = list.filter((e: unknown) => validEntry({ ...(e as object), userId: String(user.id) }) && String((e as JournalEntry).id).length <= 100)
    .map((e: JournalEntry) => ({ ...e, userId: String(user.id) }))
    .filter((e: JournalEntry) => e.at <= now + 3_600_000 && e.at >= now - JOURNAL_LIMITS.serverDays * DAY);
  if (!valid.length) return { accepted: 0, rejected: list.length };
  // Записи неизвестных программ не принимаются: журнал не место для чужого мусора
  const known = new Set((await db.moduleRelease.findMany({ where: { moduleId: { in: [...new Set(valid.map(e => e.moduleId))] } }, select: { moduleId: true } })).map((r: any) => r.moduleId));
  const fresh = valid.filter(e => known.has(e.moduleId));
  // Ключ строки привязан к человеку: чужой номер записи занять нельзя, а повтор своей пачки не даёт дублей
  const keyOf = (e: JournalEntry) => `${e.userId.slice(0, 40)}:${e.id}`;
  const existing = new Set((await db.moduleJournal.findMany({ where: { id: { in: fresh.map(keyOf) } }, select: { id: true } })).map((r: any) => r.id));
  // Предел приёма на человека за сутки: сверх него записи не принимаются, остальных людей это не вытесняет
  const today = await db.moduleJournal.count({ where: { userId: String(user.id), receivedAt: { gte: new Date(now - DAY) } } });
  const room = Math.max(0, JOURNAL_LIMITS.userPerDay - today);
  const candidates = fresh.filter(e => !existing.has(keyOf(e)));
  const rows = candidates.slice(0, room).map(e => ({
    id: keyOf(e), userId: e.userId, userName: String(user.name || '').slice(0, 120), moduleId: e.moduleId, version: e.version, category: e.category, level: e.level,
    event: e.event, detail: e.detail, outcome: e.outcome, ms: Math.min(e.ms, 2 ** 31 - 1), bytesIn: Math.min(e.bytesIn, 2 ** 31 - 1), bytesOut: Math.min(e.bytesOut, 2 ** 31 - 1), at: new Date(e.at),
  }));
  if (rows.length) {
    try { await db.moduleJournal.createMany({ data: rows }); }
    catch {
      // Гонка двух отправок одной пачки: дубликат не должен ронять приём, остальное записывается построчно
      for (const row of rows) await db.moduleJournal.create({ data: row }).catch(() => undefined);
    }
  }
  // Повторная отправка той же пачки считается принятой: клиент не должен слать её бесконечно
  const accepted = fresh.length - (candidates.length - rows.length);
  return { accepted, rejected: list.length - accepted };
}

/** Срок и предел: старше срока — удаляется; сверх числа строк — самые старые */
export async function expireJournal(db: any, now = Date.now()): Promise<number> {
  const old = await db.moduleJournal.deleteMany({ where: { at: { lt: new Date(now - JOURNAL_LIMITS.serverDays * DAY) } } });
  let removed = old.count;
  const total = await db.moduleJournal.count();
  if (total > JOURNAL_LIMITS.serverRows) {
    const cut = await db.moduleJournal.findMany({ orderBy: { at: 'asc' }, take: total - JOURNAL_LIMITS.serverRows, select: { id: true } });
    for (let i = 0; i < cut.length; i += 500) removed += (await db.moduleJournal.deleteMany({ where: { id: { in: cut.slice(i, i + 500).map((r: any) => r.id) } } })).count;
  }
  return removed;
}

const csvCell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""').replace(/^[=+\-@]/, "'$&")}"`;

export function registerJournalRoutes(app: Express, deps: JournalDeps): void {
  const can = (req: Request, feature: string) => ['OWNER'].includes(userOf(req).role) || (deps.can ? deps.can(userOf(req), feature) : false);

  app.post('/api/modules/journal', async (req: Request, res: Response) => {
    const user = userOf(req);
    if (!user.id) return fail(res, 401, 'Нужен вход');
    if (!allowBatch(String(user.id), Date.now())) return fail(res, 429, 'Слишком много пачек журнала подряд');
    try { res.json({ ok: true, ...(await acceptJournal(deps.getPrisma(), user, req.body)) }); }
    catch (e: any) { fail(res, 503, e?.message || 'Журнал недоступен'); }
  });

  /** Просмотр: владелец и администратор видят всё; разработчик — только свои программы и без людей */
  app.get('/api/modules/journal', async (req: Request, res: Response) => {
    const db = deps.getPrisma(), user = userOf(req), admin = isAdmin(req);
    const developer = !admin && can(req, 'module.develop');
    if (!admin && !developer) return fail(res, 403, 'Журнал программ доступен владельцу, администратору и разработчику');
    const q = req.query as Record<string, string>;
    const where: any = {};
    if (developer) {
      const own = [...await modulesOfDeveloper(db, String(user.id), deps.rootHex())];
      where.moduleId = { in: own };
      if (q.moduleId && !own.includes(q.moduleId)) return res.json({ entries: [], modules: own });
    }
    if (q.moduleId) where.moduleId = q.moduleId;
    if (q.version) where.version = String(q.version).slice(0, 40);
    // Разработчик не может отобрать по человеку: иначе обезличивание обходится перебором
    if (q.userId && admin) where.userId = String(q.userId).slice(0, 160);
    if (JOURNAL_LEVELS.includes(q.level as any)) where.level = q.level;
    if (JOURNAL_CATEGORIES.includes(q.category as any)) where.category = q.category;
    const at: any = {};
    if (Number(q.from) > 0) at.gte = new Date(Number(q.from));
    if (Number(q.to) > 0) at.lte = new Date(Number(q.to));
    if (Object.keys(at).length) where.at = at;
    const csv = q.format === 'csv';
    const rows = await db.moduleJournal.findMany({ where, orderBy: { at: 'desc' }, take: csv ? 5000 : Math.min(500, Number(q.limit) || 200) });
    const view = (r: any) => {
      const row = { id: r.id, userId: r.userId, userName: r.userName, moduleId: r.moduleId, version: r.version, category: r.category, level: r.level, event: r.event,
        detail: r.detail, outcome: r.outcome, ms: r.ms, bytesIn: r.bytesIn, bytesOut: r.bytesOut, at: r.at };
      if (admin) return row;
      const { userName: _name, ...rest } = anonymize(row) as any;
      // Текст flux.log пишет сама программа и может содержать что угодно: разработчику в общем журнале — только факт, уровень и время;
      // текст он увидит, лишь если человек сам приложил журнал к обращению
      return row.category === 'log' ? { ...rest, detail: '' } : rest;
    };
    const out = rows.map(view);
    if (csv) {
      const cols = ['at', ...(admin ? ['userName'] : []), 'moduleId', 'version', 'category', 'level', 'event', 'detail', 'outcome', 'ms', 'bytesIn', 'bytesOut'];
      res.type('text/csv; charset=utf-8').send(`﻿${cols.join(',')}\n${out.map((r: any) => cols.map(c => csvCell(c === 'at' ? new Date(r.at).toISOString() : r[c])).join(',')).join('\n')}\n`);
      return;
    }
    res.json({ entries: out, role: admin ? 'admin' : 'developer' });
  });

  // ── Политика подключений: администратор запрещает подключение роли, сильнее выбора человека ──
  const KEY = 'modules.connectionPolicy';
  interface Rule { moduleId: string; connection: string; roles: string[] }
  const readRules = async (db: any): Promise<Rule[]> => {
    const row = await db.appSetting.findFirst({ where: { key: KEY, userId: null } }).catch(() => null);
    try {
      const list = JSON.parse(row?.value || '[]');
      return Array.isArray(list) ? list.filter((r: any) => typeof r?.moduleId === 'string' && typeof r?.connection === 'string' && Array.isArray(r.roles)).slice(0, 1000) : [];
    } catch { return []; }
  };
  app.get('/api/modules/connection-policy', async (req: Request, res: Response) => {
    const db = deps.getPrisma(), mine = positionsOf(userOf(req));
    const rules = await readRules(db);
    // Правило с пустым списком ролей касается всех
    res.json({ denied: rules.filter(r => r.roles.length === 0 || r.roles.some(role => mine.includes(role))).map(r => ({ moduleId: r.moduleId, connection: r.connection })) });
  });
  app.get('/api/modules/connection-policy/rules', async (req: Request, res: Response) => {
    if (!isAdmin(req)) return fail(res, 403, 'Доступно администратору');
    res.json({ rules: await readRules(deps.getPrisma()) });
  });
  app.put('/api/modules/connection-policy/rules', async (req: Request, res: Response) => {
    if (!isAdmin(req)) return fail(res, 403, 'Доступно администратору');
    const db = deps.getPrisma();
    const raw = Array.isArray(req.body?.rules) ? req.body.rules.slice(0, 1000) : null;
    if (!raw) return fail(res, 400, 'Нужен список правил');
    const rules: Rule[] = [];
    for (const r of raw) {
      if (typeof r?.moduleId !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(r.moduleId) || typeof r?.connection !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(r.connection)) return fail(res, 400, 'Неверное правило');
      rules.push({ moduleId: r.moduleId, connection: r.connection, roles: Array.isArray(r.roles) ? r.roles.filter((x: unknown) => typeof x === 'string' && x.length <= 64).slice(0, 30) : [] });
    }
    const value = JSON.stringify(rules);
    const row = await db.appSetting.findFirst({ where: { key: KEY, userId: null } });
    if (row) await db.appSetting.update({ where: { id: row.id }, data: { value } });
    else await db.appSetting.create({ data: { key: KEY, userId: null, value } });
    res.json({ ok: true, rules });
  });
}

export { MODULE_ROOT_KEY_HEX };
