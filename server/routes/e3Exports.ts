/**
 * Связь с проектами E3 и журнал выгрузок (docs/e3-integration.md, 8.2 и 9.1).
 *
 * Сервер к E3 не подключается: E3 стоит на компьютере инженера, и все вызовы
 * делает мост из окна. Серверу окно присылает ход дела — план, результат каждого
 * шага, итоговые связи — а он держит порядок: состояния выгрузки идут только
 * вперёд (PLANNED → RUNNING → DONE / INTERRUPTED → UNDONE), «выполнено» не
 * принимается, пока в журнале не сделаны все шаги плана, а откат снимает только
 * то, что поставила эта выгрузка и к чему после неё не притрагивалась другая.
 *
 * Две выгрузки в один проект E3 одновременно не идут (С18): вторая получает
 * 409 с признаком `busy` и ждёт. Зависшая RUNNING (окно закрыли без записи)
 * считается прерванной через `STALE_MS`.
 *
 * Право `e3.export` проверяется на каждом маршруте записи; читать связи может
 * участник проекта.
 */
import type { Express, Request, Response } from 'express';
import { getPrisma, onDatabaseSwapped, sendError } from '../context.js';
import { ensureTables } from '../ddl.js';
import { isPrivilegedUser } from '../accessPolicy.js';
import { canSeeProject } from './members.js';
import { E3_TABLES, memoryStore, prismaStore, type E3ExportRow, type E3Store } from '../e3ExportStore.js';
import { isComplete, type JournalEntry } from '../../e3/exportRun.js';
import type { Binding } from '../../e3/exportTypes.js';

/** Через сколько без записей о шагах RUNNING считается брошенной */
export const STALE_MS = 10 * 60_000;
const STEP_KINDS = ['place', 'designation', 'attribute', 'link', 'remove'];

class Fail extends Error { constructor(public status: number, message: string, public extra: Record<string, unknown> = {}) { super(message); } }
const fail = (status: number, message: string, extra?: Record<string, unknown>): never => { throw new Fail(status, message, extra); };
const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length <= max ? v : null);

/** План приходит из окна: форма проверяется как чужой ввод, большое не принимается */
function checkPlan(raw: any): { steps: any[]; summary: any; actions: Record<string, unknown>[]; runId: string } {
  // План только из «отвязать» обходится без шагов: связь меняется сразу, но действие в плане должно быть
  if (!raw || !Array.isArray(raw.steps) || (!raw.steps.length && !(Array.isArray(raw.actions) && raw.actions.length))) fail(400, 'В плане нет шагов');
  if (raw.steps.length > 5000) fail(400, 'В плане слишком много шагов: не больше 5000');
  const steps = raw.steps.map((s: any, i: number) => {
    if (!s || !STEP_KINDS.includes(s.kind) || !str(s.positionId, 100) || !str(s.detail ?? '', 500)) fail(400, `Шаг ${i + 1} плана не распознан`);
    return s;
  });
  // Действия хранятся целиком (что и куда писать): по ним продолжение собирает итоговые связи, не пересчитывая подбор заново
  const actions = Array.isArray(raw.actions) ? raw.actions.slice(0, 5000).map((a: any) => ({
    elementId: String(a?.elementId || '').slice(0, 100), kind: String(a?.kind || '').slice(0, 20),
    attrs: Array.isArray(a?.attrs) ? a.attrs.slice(0, 500) : [], ...(typeof a?.designation === 'string' ? { designation: a.designation.slice(0, 200) } : {}),
    ...(a?.rect && typeof a.rect === 'object' ? { rect: a.rect } : {}), keptE3: [],
  })) : [];
  // Идентификатор запуска на метках блоков: по нему продолжение и «убрать» находят блоки, у которых ещё нет атрибутов связи
  return { runId: str(raw.runId ?? '', 100) ?? '', steps, summary: raw.summary && typeof raw.summary === 'object' ? raw.summary : {}, actions };
}

function checkJournal(raw: any, total: number): JournalEntry[] {
  if (!Array.isArray(raw) || !raw.length || raw.length > 5000) fail(400, 'Нужен непустой список результатов шагов');
  return raw.map((r: any) => {
    if (!r || !Number.isInteger(r.i) || r.i < 0 || r.i >= total || typeof r.ok !== 'boolean') fail(400, 'Результат шага не распознан');
    const message = r.message === undefined ? undefined : str(r.message, 500);
    if (message === null) fail(400, 'Сообщение шага длиннее 500 знаков');
    return { i: r.i, ok: r.ok, ...(message ? { message } : {}) };
  });
}

function checkBinding(b: any): Binding {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : fail(400, 'Координата связи должна быть числом'));
  if (!b || !str(b.elementId, 100) || !b.elementId) fail(400, 'У связи нет ID узла');
  if (!['PLACED', 'REMOVED_IN_FLUX', 'DELETED_IN_E3', 'DETACHED'].includes(b.state)) fail(400, 'Состояние связи не распознано');
  const attrs = b.sentAttrs && typeof b.sentAttrs === 'object' && !Array.isArray(b.sentAttrs) ? b.sentAttrs : fail(400, 'Записанные значения — набор «ключ → значение»');
  if (Object.keys(attrs).length > 2000 || Object.values(attrs).some((v) => typeof v !== 'string')) fail(400, 'Записанные значения: слишком много или не строки');
  return {
    elementId: b.elementId, solutionId: str(b.solutionId ?? '', 80) ?? fail(400, 'ID решения слишком длинный'), designation: str(b.designation ?? '', 200) ?? fail(400, 'Обозначение слишком длинное'),
    sheet: str(b.sheet ?? '', 200) ?? '', x: num(b.x), y: num(b.y), rotation: typeof b.rotation === 'number' ? b.rotation : 0, sentVersion: str(b.sentVersion ?? '', 200) ?? '',
    sentAttrs: attrs, state: b.state, lastExportId: str(b.lastExportId ?? '', 100) ?? '',
  };
}

let devStore: E3Store | null = null;
onDatabaseSwapped(() => { devStore = null; });

export interface E3ExportDeps {
  ensure?: (db: any) => Promise<void>;
  store?: (db: any) => E3Store;
  canUseProject?: (user: any, projectId: string) => Promise<boolean>;
  now?: () => number;
}

export function registerE3ExportRoutes(app: Express, can: (user: any, feature: string) => boolean, deps: E3ExportDeps = {}): void {
  const ensure = deps.ensure || (async (db: any) => { const err = await ensureTables(db, E3_TABLES); if (err) throw new Error(err); });
  const canUseProject = deps.canUseProject || (async (user: any, projectId: string) => canSeeProject(String(user?.id || ''), projectId, isPrivilegedUser(user)));
  const now = deps.now || (() => Date.now());
  const storeOf = deps.store || ((db: any): E3Store => {
    if (db.e3Export) return prismaStore(db);
    // Клиент Prisma собран до появления моделей E3: в dev-режиме работаем в памяти, иначе просим собрать клиент
    if (process.env.FLUX_E3_FAKE === '1') return (devStore = devStore || memoryStore());
    return fail(503, 'Клиент базы собран без моделей E3: выполните prisma generate');
  });

  const handle = (write: boolean, fn: (req: Request, res: Response, store: E3Store, user: any, db: any) => Promise<any>) => async (req: Request, res: Response) => {
    try {
      const user = (req as any).authUser;
      if (!user?.id) return res.status(401).json({ error: 'Нужно войти в программу' });
      if (write && !can(user, 'e3.export')) return res.status(403).json({ error: 'Нет права выгружать в E3.series' });
      const db = getPrisma();
      await ensure(db);
      await fn(req, res, storeOf(db), user, db);
    } catch (e: any) {
      if (e instanceof Fail) return res.status(e.status).json({ error: e.message, ...e.extra });
      sendError(res, e, e?.status || (e?.code === 'P2002' ? 409 : 500));
    }
  };
  const member = async (req: Request, user: any): Promise<string> => {
    const projectId = String(req.params?.projectId || '');
    if (!projectId || projectId.length > 100) return fail(400, 'Не указан проект');
    if (!(await canUseProject(user, projectId))) return fail(403, 'Нет доступа к проекту. Попросите добавить вас в состав.');
    return projectId;
  };
  /** Проект E3 из адреса: он должен принадлежать проекту Flux, к которому у человека есть доступ */
  const e3ProjectOf = async (req: Request, store: E3Store, user: any) => {
    const projectId = await member(req, user);
    const p = await store.getProject(String(req.params.e3ProjectId || ''));
    if (!p || p.fluxProjectId !== projectId) return fail(404, 'Проекта E3 нет среди связей этого проекта');
    return p;
  };
  /** Выгрузка по ID: доступ — через проект Flux, к которому привязан её проект E3 */
  const exportOf = async (req: Request, store: E3Store, user: any): Promise<E3ExportRow> => {
    const e = await store.getExport(String(req.params.id || ''));
    if (!e) return fail(404, 'Записи выгрузки нет');
    const p = await store.getProject(e.e3ProjectId);
    if (!p || !(await canUseProject(user, p.fluxProjectId))) return fail(403, 'Нет доступа к проекту. Попросите добавить вас в состав.');
    return e;
  };
  /** С18: идёт ли в этот проект E3 другая выгрузка. Брошенную закрываем как прерванную */
  const claim = async (store: E3Store, e: E3ExportRow): Promise<void> => {
    for (const other of await store.runningExports(e.e3ProjectId)) {
      if (other.id === e.id) continue;
      if (now() - Date.parse(other.updatedAt) > STALE_MS) { await store.saveExport(other.id, { state: 'INTERRUPTED' }); continue; }
      fail(409, 'В этот проект E3 уже идёт другая выгрузка. Дождитесь её окончания.', { busy: true, exportId: other.id });
    }
  };
  /** Строка списка выгрузок: без плана и журнала целиком — они большие, а окну нужны счётчики */
  const light = (e: E3ExportRow) => {
    const steps = (e.plan?.steps || []) as unknown[];
    return { id: e.id, e3ProjectId: e.e3ProjectId, sheet: e.sheet, by: e.by, at: e.at, updatedAt: e.updatedAt, state: e.state, classifierVersion: e.classifierVersion, profile: e.profile,
      summary: e.plan?.summary || {}, steps: steps.length, done: steps.filter((_, i) => e.journal.some((j) => j.i === i && j.ok)).length };
  };

  /**
   * После выгрузки (8.3): строка в журнале действий и строка в истории каждой
   * позиции — «Выгружена в E3: проект, лист, обозначение». Выгрузка уже записана,
   * поэтому сбой журнала её не откатывает: он пишется в консоль сервера.
   */
  const afterExport = async (db: any, e: E3ExportRow, bindings: Binding[], user: any): Promise<void> => {
    const project = await storeOf(db).getProject(e.e3ProjectId);
    const placed = bindings.filter((b) => b.state === 'PLACED');
    try {
      await db.actionLog?.create({ data: { userId: String(user.id), userName: String(user.name || user.symbol || 'Сотрудник'), what: 'Выгрузка в E3', target: `${project?.name || 'проект E3'} · ${e.sheet} · узлов: ${placed.length}`.slice(0, 180), route: '/e3flux' } });
    } catch (err: any) { console.error('[E3] Журнал действий не записан:', err?.message || err); }
    for (const b of placed) {
      try {
        await db.equipmentHistory?.create({ data: { elementId: b.elementId, version: Number(b.sentVersion) || 1, oldSpecs: null, newSpecs: JSON.stringify({ e3: { project: project?.name || '', sheet: e.sheet, designation: b.designation, exportId: e.id } }), changeType: 'E3_EXPORT', batchId: e.id } });
      } catch (err: any) { console.error('[E3] История позиции не записана:', err?.message || err); }
    }
  };

  const P = '/api/projects/:projectId/e3';
  app.get(`${P}/projects`, handle(false, async (req, res, store, user) => { res.json(await store.listProjects(await member(req, user))); }));

  /** Связать проект E3 с проектом Flux (или обновить сведения о нём) */
  app.put(`${P}/link`, handle(true, async (req, res, store, user) => {
    const projectId = await member(req, user);
    const b = req.body || {};
    const key = str(b.key, 100);
    if (!key || !/^[\w-]{8,100}$/.test(key)) return fail(400, 'Ключ связи — uuid проекта E3 (FLUX_PROJECT)');
    const row = { fluxProjectId: projectId, key, name: str(b.name ?? '', 300) ?? '', path: str(b.path ?? '', 1000) ?? '', e3Version: str(b.e3Version ?? '', 50) ?? '', partsDb: str(b.partsDb ?? '', 300) ?? '' };
    // С13: «это новый проект» — у копии проекта E3 свой ключ, а связи прежнего проекта переносятся в неё как есть
    const from = b.copyFrom === undefined ? null : await store.getProject(String(b.copyFrom));
    if (b.copyFrom !== undefined && (!from || from.fluxProjectId !== projectId)) return fail(404, 'Проекта E3, откуда копировать связи, нет среди связей этого проекта');
    res.json(await store.tx(async (tx) => {
      const created = await tx.upsertProject(row);
      if (from && from.id !== created.id) for (const bd of await tx.listBindings(from.id)) await tx.saveBinding(created.id, bd);
      return created;
    }));
  }));

  /** Что из проекта Flux стоит в схемах E3: для строки «В схеме E3» в Оборудовании */
  app.get(`${P}/summary`, handle(false, async (req, res, store, user) => {
    const projectId = await member(req, user);
    const out: Record<string, unknown>[] = [];
    for (const p of await store.listProjects(projectId)) {
      for (const b of await store.listBindings(p.id)) {
        if (b.state === 'DETACHED') continue;
        out.push({ elementId: b.elementId, project: p.name, e3ProjectId: p.id, sheet: b.sheet, designation: b.designation, sentVersion: b.sentVersion, state: b.state });
      }
    }
    res.json(out);
  }));

  app.get(`${P}/projects/:e3ProjectId/bindings`, handle(false, async (req, res, store, user) => { res.json(await store.listBindings((await e3ProjectOf(req, store, user)).id)); }));

  app.get(`${P}/projects/:e3ProjectId/exports`, handle(false, async (req, res, store, user) => {
    const p = await e3ProjectOf(req, store, user);
    res.json((await store.listExports(p.id, 20)).map(light));
  }));

  /** Новая запись выгрузки: план сохраняется до первого шага — по нему продолжают и откатывают */
  app.post(`${P}/projects/:e3ProjectId/exports`, handle(true, async (req, res, store, user) => {
    const p = await e3ProjectOf(req, store, user);
    const plan = checkPlan(req.body?.plan);
    const sheet = str(req.body?.sheet ?? '', 200) ?? fail(400, 'Название листа слишком длинное');
    const version = Number.isInteger(req.body?.classifierVersion) ? req.body.classifierVersion : 0;
    res.json(await store.createExport({ e3ProjectId: p.id, sheet, by: user.id, state: 'PLANNED', classifierVersion: version, profile: req.body?.profile ?? {}, plan, journal: [], report: {} }));
  }));

  app.get('/api/e3-exports/:id', handle(false, async (req, res, store, user) => { res.json(await exportOf(req, store, user)); }));

  /** PLANNED → RUNNING. Занятый проект E3 — 409 с `busy`: окно ждёт и пробует снова */
  app.post('/api/e3-exports/:id/start', handle(true, async (req, res, store, user) => {
    const e = await exportOf(req, store, user);
    if (e.state !== 'PLANNED') return fail(409, `Выгрузка уже в состоянии «${e.state}» — запустить её с начала нельзя`);
    await claim(store, e);
    res.json(await store.saveExport(e.id, { state: 'RUNNING' }));
  }));

  /** INTERRUPTED → RUNNING: отвечает номерами невыполненных шагов плана */
  app.post('/api/e3-exports/:id/resume', handle(true, async (req, res, store, user) => {
    const e = await exportOf(req, store, user);
    if (e.state !== 'INTERRUPTED') return fail(409, 'Продолжить можно только прерванную выгрузку');
    await claim(store, e);
    const done = new Set(e.journal.filter((j) => j.ok).map((j) => j.i));
    const remaining = (e.plan.steps as unknown[]).map((_, i) => i).filter((i) => !done.has(i));
    res.json({ export: await store.saveExport(e.id, { state: 'RUNNING' }), remaining });
  }));

  /** Результаты шагов в журнал. Повторная запись того же шага заменяет прежнюю: журнал не пухнет от повторов */
  app.post('/api/e3-exports/:id/steps', handle(true, async (req, res, store, user) => {
    const e = await exportOf(req, store, user);
    if (e.state !== 'RUNNING') return fail(409, 'Шаги пишутся только в идущую выгрузку');
    const add = checkJournal(req.body?.results, e.plan.steps.length);
    const byStep = new Map(e.journal.map((j) => [j.i, j]));
    for (const j of add) byStep.set(j.i, j);
    res.json(await store.saveExport(e.id, { journal: [...byStep.values()].sort((a, b) => a.i - b.i) }));
  }));

  /**
   * Итог. DONE принимается, только если сделаны все шаги плана; связи пишутся
   * вместе с итогом одной транзакцией — «выгружено» без связей не бывает.
   * INTERRUPTED связей не пишет: узел без последнего шага (атрибутов связи)
   * для Flux ещё не выгружен.
   */
  app.post('/api/e3-exports/:id/finish', handle(true, async (req, res, store, user, db) => {
    const e = await exportOf(req, store, user);
    if (e.state !== 'RUNNING') return fail(409, 'Закончить можно только идущую выгрузку');
    const state = req.body?.state;
    if (state !== 'DONE' && state !== 'INTERRUPTED') return fail(400, 'Итог — DONE или INTERRUPTED');
    const report = req.body?.report && typeof req.body.report === 'object' ? req.body.report : {};
    if (state === 'INTERRUPTED') return res.json(await store.saveExport(e.id, { state, report }));
    if (!isComplete(e.plan.steps, e.journal)) return fail(409, 'Не все шаги плана выполнены — выгрузка не может быть закончена');
    const bindings = (Array.isArray(req.body?.bindings) ? req.body.bindings : []).slice(0, 5000).map(checkBinding);
    // Связь пишется только по узлам этого плана: чужие узлы окно записать не может
    const inPlan = new Set([...(e.plan.steps as { positionId: string }[]).map((s) => s.positionId), ...((e.plan.actions || []) as { elementId: string }[]).map((a) => a.elementId)]);
    if (bindings.some((b: Binding) => !inPlan.has(b.elementId))) return fail(400, 'Связь по узлу, которого нет в плане выгрузки');
    const done = await store.tx(async (tx) => {
      for (const b of bindings) await tx.saveBinding(e.e3ProjectId, { ...b, lastExportId: e.id });
      return tx.saveExport(e.id, { state: 'DONE', report });
    });
    await afterExport(db, e, bindings, user);
    res.json(done);
  }));

  /**
   * «Убрать сделанное»: окно присылает, что мост убрал из E3 и что оставил. Снять
   * связи можно только у узлов, которые поставила эта выгрузка, и только если их
   * связь по-прежнему от неё (позже узел мог обновить другая выгрузка).
   */
  app.post('/api/e3-exports/:id/undo', handle(true, async (req, res, store, user) => {
    const e = await exportOf(req, store, user);
    if (e.state !== 'DONE' && e.state !== 'INTERRUPTED') return fail(409, 'Убрать можно выполненную или прерванную выгрузку');
    const removed: string[] = Array.isArray(req.body?.removed) ? req.body.removed.filter((x: unknown) => typeof x === 'string') : fail(400, 'Не указано, что убрано из E3');
    const kept = Array.isArray(req.body?.kept) ? req.body.kept.slice(0, 5000).map((k: any) => ({ positionId: String(k?.positionId || '').slice(0, 100), reason: String(k?.reason || '').slice(0, 300) })) : [];
    const ok = new Set(e.journal.filter((j) => j.ok).map((j) => j.i));
    const placed = new Set((e.plan.steps as { kind: string; positionId: string }[]).filter((s, i) => s.kind === 'place' && ok.has(i)).map((s) => s.positionId));
    if (removed.some((id) => !placed.has(id))) return fail(400, 'Можно снять только то, что поставила эта выгрузка');
    res.json(await store.tx(async (tx) => {
      const bindings = new Map((await tx.listBindings(e.e3ProjectId)).map((b) => [b.elementId, b]));
      const later: { positionId: string; reason: string }[] = [];
      for (const id of removed) {
        const b = bindings.get(id);
        if (b && b.lastExportId !== e.id) { later.push({ positionId: id, reason: 'позже узел обновила другая выгрузка' }); continue; }
        if (b) await tx.deleteBinding(e.e3ProjectId, id);
      }
      return tx.saveExport(e.id, { state: 'UNDONE', report: { removed: removed.filter((id) => !later.some((l) => l.positionId === id)), kept: [...kept, ...later] } });
    }));
  }));
}
