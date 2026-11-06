/**
 * Flux Store: витрина, установки человека, отзывы, решения администратора, журнал.
 *
 * Здесь политика, а не доверие: сервер решает, что показывать и что
 * записывать в «установлено у человека», но запускает подпрограмму только
 * Flux на компьютере — после проверки подписи владельца. Поэтому ни одна
 * запись этих таблиц не позволяет запустить непроверенный код.
 */
import type { Express, Request, Response } from 'express';
import { unpackBundle } from '../../modules/trust/bundle.js';
import { compareVersions } from '../../shared/versionCompare.js';
import { queueModuleFixNotices } from '../feedback/moduleSignals.js';
import { buildListings, entryOf } from '../moduleListings.js';
import { readBundle } from '../moduleStore.js';
import { STORE_STATUSES, type StoreListing } from '../../modules/store/model.js';

export interface ModuleStoreDeps {
  getPrisma: () => any;
  broadcast: (event: string, payload: unknown) => void;
  rootHex: () => string;
}

const fail = (res: Response, status: number, error: string) => res.status(status).json({ error });
const userOf = (req: Request) => (req as any).authUser || {};
const isAdmin = (req: Request) => ['OWNER', 'ADMIN'].includes(userOf(req).role);
const clip = (v: unknown, max: number) => String(v ?? '').slice(0, max);
const MODULE_ID = /^[a-z][a-z0-9-]{0,63}$/;
const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

export async function logStore(db: any, user: any, moduleId: string, action: string, from = '', to = '', detail = '') {
  await db.moduleStoreLog.create({ data: { userId: String(user?.id || ''), userName: clip(user?.name, 120), moduleId, action, fromVersion: from, toVersion: to, detail: clip(detail, 4000) } })
    .catch(() => { /* журнал не должен ронять действие */ });
}

export function registerModuleStoreRoutes(app: Express, deps: ModuleStoreDeps): void {
  const find = async (db: any, req: Request, res: Response): Promise<{ listing: StoreListing; all: StoreListing[] } | null> => {
    const moduleId = String(req.params.id || '');
    if (!MODULE_ID.test(moduleId)) { fail(res, 404, 'Подпрограмма не найдена'); return null; }
    const { listings } = await buildListings(db, userOf(req), deps.rootHex());
    const listing = listings.find((l) => l.moduleId === moduleId);
    if (!listing) { fail(res, 404, 'Подпрограмма не найдена'); return null; }
    return { listing, all: listings };
  };

  app.get('/api/modules/store', async (req: Request, res: Response) => {
    try {
      const db = deps.getPrisma(), user = userOf(req);
      const built = await buildListings(db, user, deps.rootHex());
      await queueModuleFixNotices(db, user.id, built.listings);
      res.json(built);
    }
    catch (e: any) { fail(res, 503, e?.message || 'Store недоступен'); }
  });

  /** Снимок из пакета выпуска: тип по расширению, только картинки */
  app.get('/api/modules/releases/:id/file', async (req: Request, res: Response) => {
    const db = deps.getPrisma(), path = String(req.query.path || '');
    const type = IMAGE_TYPES[path.split('.').pop() || ''];
    if (!type || !/^store\/[A-Za-z0-9_-]{1,40}\.[a-z]{3,4}$/.test(path)) return fail(res, 404, 'Нет такого файла');
    const row = await db.moduleRelease.findUnique({ where: { id: String(req.params.id) } });
    if (!row) return fail(res, 404, 'Выпуск не найден');
    try {
      const data = unpackBundle(await readBundle(db, row.blobId, row.chunkCount))[path];
      if (!data) return fail(res, 404, 'Нет такого файла');
      res.set({ 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'private, max-age=3600' });
      res.send(Buffer.from(data));
    } catch (e: any) { fail(res, 409, e.message); }
  });

  // ── Установки человека ────────────────────────────────────────────────────

  app.get('/api/modules/installs', async (req: Request, res: Response) => {
    const rows = await deps.getPrisma().moduleInstall.findMany({ where: { userId: String(userOf(req).id) }, orderBy: { installedAt: 'asc' }, take: 500 });
    res.json({ installs: rows.map((r: any) => ({ moduleId: r.moduleId, version: r.version, source: r.source, auto: r.autoUpdate || '', installedAt: r.installedAt })) });
  });

  /** Общий переключатель автообновления — у каждого человека свой, по умолчанию выключен */
  app.put('/api/modules/installs/auto', async (req: Request, res: Response) => {
    const db = deps.getPrisma(), userId = String(userOf(req).id), value = req.body?.enabled === true ? '1' : '0';
    const row = await db.appSetting.findFirst({ where: { key: 'modules.autoupdate', userId } });
    if (row) await db.appSetting.update({ where: { id: row.id }, data: { value } });
    else await db.appSetting.create({ data: { key: 'modules.autoupdate', userId, value } });
    await logStore(db, userOf(req), '*', value === '1' ? 'auto-on' : 'auto-off');
    res.json({ autoUpdate: value === '1' });
  });

  app.put('/api/modules/installs/:id', async (req: Request, res: Response) => {
    const db = deps.getPrisma(), user = userOf(req), moduleId = String(req.params.id);
    const version = String(req.body?.version || '');
    const found = await find(db, req, res);
    if (!found) return;
    const { listing, all } = found;
    const target = listing.versions.find((v) => v.version === version && !v.revoked);
    if (!target) return fail(res, 409, `Версия ${version || '?'} недоступна: выпуска нет, он отозван или не виден вам`);
    const current = await db.moduleInstall.findUnique({ where: { userId_moduleId: { userId: String(user.id), moduleId } } });
    if (!current) {
      if (listing.status !== 'admitted') return fail(res, 409, 'Подпрограмма не допущена в Store администратором');
      if (listing.deprecated) return fail(res, 409, 'Подпрограмма устарела: новым пользователям она не ставится');
    }
    if (listing.status === 'banned') return fail(res, 409, 'Подпрограмма запрещена администратором');
    if ((!current || compareVersions(version, current.version) > 0) && listing.pinned && compareVersions(version, listing.pinned) > 0) {
      return fail(res, 409, `Администратор закрепил версию ${listing.pinned}: выше ставить нельзя`);
    }
    // Зависимости: общие данные модуля — без поставщика эта подпрограмма не заработает
    const missing = listing.dependsOn.filter((id) => !all.find((l) => l.moduleId === id)?.mine);
    if (missing.length) return fail(res, 409, `Сначала установите: ${missing.join(', ')}`);
    const source = ['user', 'required', 'dependency'].includes(req.body?.source) ? req.body.source : current?.source || 'user';
    const auto = req.body?.auto === 'on' || req.body?.auto === 'off' ? req.body.auto : req.body?.auto === '' ? '' : current?.autoUpdate || '';
    const data = { version, source, autoUpdate: auto };
    if (current) await db.moduleInstall.update({ where: { id: current.id }, data });
    else await db.moduleInstall.create({ data: { userId: String(user.id), moduleId, ...data } });
    const action = !current ? 'install' : compareVersions(version, current.version) > 0 ? 'update' : compareVersions(version, current.version) < 0 ? 'rollback' : 'keep';
    if (action !== 'keep') await logStore(db, user, moduleId, action, current?.version || '', version, source === 'required' ? 'обязательная для должности' : '');
    deps.broadcast('modules:installs', { moduleId });
    res.json({ ok: true, action });
  });

  app.delete('/api/modules/installs/:id', async (req: Request, res: Response) => {
    const db = deps.getPrisma(), user = userOf(req), moduleId = String(req.params.id);
    if (!MODULE_ID.test(moduleId)) return fail(res, 404, 'Подпрограмма не найдена');
    const { listings } = await buildListings(db, user, deps.rootHex());
    const listing = listings.find((l) => l.moduleId === moduleId);
    if (listing?.required && listing.status !== 'banned') return fail(res, 409, 'Подпрограмма обязательна для вашей должности: удалить её может только администратор');
    const dependants = listings.filter((l) => l.mine && l.dependsOn.includes(moduleId)).map((l) => l.name);
    if (dependants.length) return fail(res, 409, `Без неё не заработают: ${dependants.join(', ')}. Сначала удалите их`);
    const current = await db.moduleInstall.findUnique({ where: { userId_moduleId: { userId: String(user.id), moduleId } } });
    if (!current) return res.json({ ok: true });
    await db.moduleInstall.delete({ where: { id: current.id } });
    await logStore(db, user, moduleId, 'uninstall', current.version, '', req.body?.keepData === false ? 'данные модуля удалены' : 'данные модуля сохранены');
    deps.broadcast('modules:installs', { moduleId });
    res.json({ ok: true });
  });

  // ── Отзывы ────────────────────────────────────────────────────────────────

  app.get('/api/modules/store/:id/reviews', async (req: Request, res: Response) => {
    const db = deps.getPrisma(), moduleId = String(req.params.id), me = String(userOf(req).id);
    const rows = await db.moduleReview.findMany({ where: { moduleId, ...(isAdmin(req) ? {} : { hidden: false }) }, orderBy: { updatedAt: 'desc' }, take: 200 });
    const view = (r: any) => ({ id: r.id, userName: r.userName, rating: r.rating, text: r.text, version: r.version, hidden: r.hidden, reports: isAdmin(req) ? r.reports : undefined,
      mine: r.userId === me, createdAt: r.createdAt, updatedAt: r.updatedAt });
    res.json({ reviews: rows.map(view) });
  });

  app.put('/api/modules/store/:id/review', async (req: Request, res: Response) => {
    const db = deps.getPrisma(), user = userOf(req), moduleId = String(req.params.id);
    const rating = Number(req.body?.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return fail(res, 400, 'Оценка — от 1 до 5');
    // Оценивает тот, у кого подпрограмма стоит: отзыв «со стороны» ничего не говорит о её работе
    const install = await db.moduleInstall.findUnique({ where: { userId_moduleId: { userId: String(user.id), moduleId } } });
    if (!install) return fail(res, 409, 'Оценить можно подпрограмму, которая у вас установлена');
    const data = { rating, text: clip(req.body?.text, 4000), version: install.version, userName: clip(user.name, 120), hidden: false };
    await db.moduleReview.upsert({ where: { moduleId_userId: { moduleId, userId: String(user.id) } }, create: { moduleId, userId: String(user.id), ...data }, update: data });
    res.json({ ok: true });
  });

  app.post('/api/modules/store/reviews/:rid/report', async (req: Request, res: Response) => {
    const db = deps.getPrisma();
    const changed = await db.moduleReview.updateMany({ where: { id: String(req.params.rid) }, data: { reports: { increment: 1 } } });
    res.json({ ok: changed.count === 1 });
  });

  // ── Администратор ─────────────────────────────────────────────────────────

  const admin = (req: Request, res: Response, next: () => void) => (isAdmin(req) ? next() : fail(res, 403, 'Доступно администратору'));

  app.get('/api/modules/store-admin', admin, async (req: Request, res: Response) => {
    const db = deps.getPrisma();
    const [{ listings }, entries, installs, logs] = await Promise.all([
      buildListings(db, userOf(req), deps.rootHex()),
      db.moduleStoreEntry.findMany({ take: 2000 }),
      db.moduleInstall.findMany({ select: { userId: true, moduleId: true, version: true, source: true }, take: 100000 }),
      db.moduleStoreLog.findMany({ orderBy: { createdAt: 'desc' }, take: 300 }),
    ]);
    const spread: Record<string, Record<string, number>> = {};
    for (const i of installs) { const m = (spread[i.moduleId] ||= {}); m[i.version] = (m[i.version] || 0) + 1; }
    res.json({ listings, entries, spread, logs });
  });

  app.post('/api/modules/store/:id/admission', admin, async (req: Request, res: Response) => {
    const db = deps.getPrisma(), moduleId = String(req.params.id), user = userOf(req);
    if (!MODULE_ID.test(moduleId)) return fail(res, 404, 'Подпрограмма не найдена');
    const status = String(req.body?.status || '');
    if (!(STORE_STATUSES as readonly string[]).includes(status)) return fail(res, 400, 'Неизвестное состояние допуска');
    if (!(await db.moduleRelease.findFirst({ where: { moduleId } }))) return fail(res, 404, 'У подпрограммы нет выпусков');
    const prev = await entryOf(db, moduleId);
    const data = { status, deprecated: typeof req.body?.deprecated === 'boolean' ? req.body.deprecated : !!prev.deprecated, note: clip(req.body?.note ?? prev.note, 2000), updatedBy: String(user.id) };
    await db.moduleStoreEntry.upsert({ where: { moduleId }, create: { moduleId, ...data }, update: data });
    // Запрет — удаление у всех; данные модуля остаются у администратора, поэтому строки установок убираются, а не копии данных
    if (status === 'banned') await db.moduleInstall.deleteMany({ where: { moduleId } });
    await logStore(db, user, moduleId, status === prev.status && data.deprecated !== !!prev.deprecated ? (data.deprecated ? 'deprecate' : 'undeprecate') : `admission-${status}`, '', '', data.note);
    deps.broadcast('modules:installs', { moduleId });
    res.json({ ok: true });
  });

  const rolesOf = (v: unknown) => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 64))].slice(0, 30) : []);

  app.post('/api/modules/store/:id/pin', admin, async (req: Request, res: Response) => {
    const db = deps.getPrisma(), moduleId = String(req.params.id), user = userOf(req);
    const version = req.body?.version ? String(req.body.version) : '';
    if (version && !(await db.moduleRelease.findUnique({ where: { moduleId_version: { moduleId, version } } }))) return fail(res, 404, 'Такого выпуска нет');
    const data = { pinVersion: version, pinRoles: JSON.stringify(rolesOf(req.body?.roles)), updatedBy: String(user.id) };
    const prev = await entryOf(db, moduleId);
    await db.moduleStoreEntry.upsert({ where: { moduleId }, create: { moduleId, status: prev.status, ...data }, update: data });
    await logStore(db, user, moduleId, version ? 'pin' : 'unpin', '', version, data.pinRoles);
    res.json({ ok: true });
  });

  app.post('/api/modules/store/:id/required', admin, async (req: Request, res: Response) => {
    const db = deps.getPrisma(), moduleId = String(req.params.id), user = userOf(req);
    const roles = rolesOf(req.body?.roles), version = roles.length ? String(req.body?.version || '') : '';
    if (roles.length && !(await db.moduleRelease.findUnique({ where: { moduleId_version: { moduleId, version } } }))) return fail(res, 404, 'Выберите существующую версию');
    const data = { requiredRoles: JSON.stringify(roles), requiredVersion: version, updatedBy: String(user.id) };
    const prev = await entryOf(db, moduleId);
    await db.moduleStoreEntry.upsert({ where: { moduleId }, create: { moduleId, status: prev.status, ...data }, update: data });
    await logStore(db, user, moduleId, roles.length ? 'required' : 'unrequired', '', version, JSON.stringify(roles));
    deps.broadcast('modules:installs', { moduleId });
    res.json({ ok: true });
  });

  app.post('/api/modules/store/reviews/:rid/hide', admin, async (req: Request, res: Response) => {
    const changed = await deps.getPrisma().moduleReview.updateMany({ where: { id: String(req.params.rid) }, data: { hidden: req.body?.hidden !== false } });
    res.json({ ok: changed.count === 1 });
  });

  /** Кому ставить обязательные: людей с нужной должностью выбирает окно человека, сервер лишь отдаёт перечень */
  app.get('/api/modules/store-roles', admin, async (_req: Request, res: Response) => {
    const roles = await deps.getPrisma().role.findMany({ select: { code: true, name: true }, orderBy: { sortOrder: 'asc' }, take: 200 });
    res.json({ roles: roles.filter((r: any) => !['OWNER', 'ADMIN'].includes(r.code)) });
  });
}
