/**
 * Каталог типовых решений E3.series (docs/e3-integration.md, раздел 5).
 *
 * Устройство то же, что у справочника атрибутов (e3Attributes.ts): весь каталог
 * — одна настройка (`e3_solutions`) с версией; запись идёт «по старому
 * значению», чтобы одновременная правка не стёрла чужую; каждая запись
 * оставляет в CatalogRevision снимок «до», по нему откат возвращает книгу
 * целиком. Решения, признаки, правила, словарь и связь типов с классами лежат в
 * одной книге: они меняются вместе (признак без решений бессмыслен), а откат
 * загрузки должен вернуть всё сразу.
 *
 * Профиль автоматизации проекта (5.6) — отдельная настройка на проект
 * (`e3_profile:<проект>`): его правит участник проекта, а не администратор
 * каталога, и версия у него своя.
 *
 * Загрузка файла двухшаговая (flux-data-safety): `plan` ничего не пишет,
 * `apply` пишет одной партией. Разбор листов — в окне; сюда приходят уже
 * разобранные записи и проверяются как чужой ввод.
 */
import type { Express, Request, Response } from 'express';
import { getPrisma, sendError } from '../context.js';
import { isPrivilegedUser } from '../accessPolicy.js';
import { catalogAllowed, catalogFailure, catalogSetting, catalogSettingRaw, claimCatalogSetting } from '../catalogWorkspace.js';
import { ensureCatalog } from './catalog.js';
import { canSeeProject } from './members.js';
import {
  applyMissingDefaults, applySolutionPlan, emptySolutionBook, mergeDictionary, mergeIoTable, planMissingDefaults, planSolutions, sanitizeClassMap, sanitizeDictionary,
  sanitizeFeature, sanitizeFeatureAnswers, sanitizeIoRow, sanitizeIoRule, sanitizeProfile, sanitizeRecipeLines, sanitizeRule, suggestFeatures, validateIoRows,
  validateSolutions, IO_FILE_FIELDS, SOLUTION_FILE_FIELDS,
  type E3IoRow, type E3Profile, type E3Solution, type E3SolutionBook,
} from '../../e3/solutions.js';

const KEY = 'e3_solutions';
const ENTITY = 'e3solutions';
const ENTITY_ID = 'book';
const CONFLICT = 'Каталог типовых решений изменён коллегой. Обновите';
const PROFILE_CONFLICT = 'Профиль проекта изменён коллегой. Обновите';
const actor = (req: Request) => (req as any).authUser;

type Loaded = { book: E3SolutionBook; raw: string | null };
type Action = 'import' | 'update' | 'restore';
export interface ProfileDoc { version: number; answers: E3Profile; updatedAt: string; updatedById?: string }

/** Книга из базы; чего в старой записи нет (список правил, связь типов), берётся из стартовых настроек */
async function load(db: any): Promise<Loaded> {
  const raw = await catalogSettingRaw(db, KEY);
  const base = emptySolutionBook();
  return { raw, book: raw ? { ...base, ...JSON.parse(raw) } : base };
}

function checkVersion(expected: unknown, version: number, message = CONFLICT): void {
  if (!Number.isInteger(expected)) catalogFailure(400, 'Не указана версия каталога типовых решений');
  if (expected !== version) catalogFailure(409, message);
}

async function write(db: any, user: any, before: Loaded, next: Partial<E3SolutionBook>, action: Action): Promise<{ book: E3SolutionBook; revisionId: string }> {
  const book: E3SolutionBook = { ...before.book, ...next, version: before.book.version + 1, updatedAt: new Date().toISOString(), updatedById: user.id };
  const revisionId = await db.$transaction(async (tx: any) => {
    await claimCatalogSetting(tx, KEY, before.raw, book, CONFLICT);
    const rev = await tx.catalogRevision.create({ data: { entity: ENTITY, entityId: ENTITY_ID, action, snapshotJson: JSON.stringify(before.book), userId: user.id } });
    return rev.id as string;
  });
  return { book, revisionId };
}

/** Входные решения из файла: проверенные, без пометок «правлено» и «снято» и без ручного состава — их знает только каталог */
function incoming(raw: unknown): E3Solution[] {
  const checked = validateSolutions(raw);
  if ('error' in checked) return catalogFailure(400, checked.error);
  return checked.items.map(({ edited: _e, removed: _r, recipeOverride: _o, ...s }) => s);
}
/** Строки «Таблицы IO» из файла: без имени изделия E3 и пометки «правлено» */
function incomingIo(raw: unknown): E3IoRow[] {
  const checked = validateIoRows(raw);
  if ('error' in checked) return catalogFailure(400, checked.error);
  return checked.rows;
}
function incomingDictionary(raw: unknown) {
  if (raw === undefined) return {};
  const d = sanitizeDictionary(raw);
  return d || catalogFailure(400, 'Словарь обозначений: ожидается набор «код → описание»');
}

const PATCH_TEXT = ['mainClass', 'subclass', 'short', 'name', 'description', 'pdf', 'e3p', 'items', 'symbols', 'note'];
const PATCH_KEYS = [...SOLUTION_FILE_FIELDS, 'features', 'featuresConfirmed', 'removed', 'recipeOverride'];

function checkPatch(raw: any): Partial<E3Solution> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return catalogFailure(400, 'Не указано, что менять');
  const keys = Object.keys(raw);
  if (!keys.length) return catalogFailure(400, 'Не указано, что менять');
  const bad = keys.find((k) => !PATCH_KEYS.includes(k as any));
  if (bad) return catalogFailure(400, `Поле «${bad}» здесь менять нельзя`);
  const patch: any = {};
  for (const k of keys) {
    if (PATCH_TEXT.includes(k)) {
      if (typeof raw[k] !== 'string' || raw[k].length > 1000) catalogFailure(400, `Поле «${k}» — строка не длиннее 1000 знаков`);
      patch[k] = raw[k].trim();
    } else if (k === 'features') {
      const f = sanitizeFeatureAnswers(raw.features);
      if (!f) catalogFailure(400, 'Признаки — набор «id → значение»');
      patch.features = f;
    } else if (k === 'recipeOverride') {
      const lines = sanitizeRecipeLines(raw.recipeOverride);
      if (!lines) catalogFailure(400, 'Ручной состав — до 40 строк «роль, строка IO, число от 1 до 50»');
      patch.recipeOverride = lines;
    } else {
      if (typeof raw[k] !== 'boolean') catalogFailure(400, `Поле «${k}» — да или нет`);
      patch[k] = raw[k];
    }
  }
  if ('name' in patch && !patch.name) catalogFailure(400, 'У решения должно быть название схемы');
  if ('mainClass' in patch && !patch.mainClass) catalogFailure(400, 'У решения должен быть основной класс');
  return patch;
}

/**
 * `ensure` и `canUseProject` подменяются только в проверке: у неё нет настоящей
 * базы, чтобы создавать таблицы каталога и состав проектов.
 */
export function registerE3SolutionRoutes(
  app: Express, can: (user: any, feature: string) => boolean,
  deps: { ensure?: (db: any) => Promise<void>; canUseProject?: (user: any, projectId: string) => Promise<boolean> } = {},
): void {
  const ensure = deps.ensure || ensureCatalog;
  const canUseProject = deps.canUseProject || (async (user: any, projectId: string) => canSeeProject(String(user?.id || ''), projectId, isPrivilegedUser(user)));
  const handle = (right: 'read' | 'import' | 'edit', fn: (req: Request, res: Response, db: any, user: any) => Promise<any>) => async (req: Request, res: Response) => {
    try {
      const user = actor(req);
      if (!user?.id) return res.status(401).json({ error: 'Нужно войти в программу' });
      const db = getPrisma();
      await ensure(db);
      if (right !== 'read' && !(await catalogAllowed(db, user, right, {}, can))) {
        return res.status(403).json({ error: right === 'import' ? 'Нет права загружать справочники каталога' : 'Нет права править каталог типовых решений' });
      }
      await fn(req, res, db, user);
    } catch (e: any) { sendError(res, e, e?.status || (e?.code === 'P2002' ? 409 : 500)); }
  };
  const BASE = '/api/catalog/e3-solutions';

  app.get(BASE, handle('read', async (_req, res, db) => { res.json((await load(db)).book); }));

  app.post(`${BASE}/plan`, handle('import', async (req, res, db) => {
    const { book } = await load(db);
    res.json(planSolutions(book.solutions, incoming(req.body?.items), { current: book.dictionary, incoming: incomingDictionary(req.body?.dictionary) },
      { current: book.ioTable || [], incoming: incomingIo(req.body?.ioTable) }));
  }));

  app.post(`${BASE}/apply`, handle('import', async (req, res, db, user) => {
    const missing = req.body?.missing === undefined ? 'keep' : req.body.missing;
    if (missing !== 'keep' && missing !== 'remove') catalogFailure(400, 'Для решений, которых нет в файле, выберите «оставить» или «снять»');
    const items = incoming(req.body?.items);
    const dictionary = incomingDictionary(req.body?.dictionary);
    const io = incomingIo(req.body?.ioTable);
    const before = await load(db);
    checkVersion(req.body?.expectedVersion, before.book.version);
    res.json(await write(db, user, before, {
      solutions: applySolutionPlan(before.book.solutions, items, { missing }), dictionary: mergeDictionary(before.book.dictionary, dictionary),
      // Лист «Таблица IO» есть не в каждом файле: без него таблица каталога остаётся как есть
      ...(io.length ? { ioTable: mergeIoTable(before.book.ioTable || [], io) } : {}),
    }, 'import'));
  }));

  /** Одно решение: правка или (create) добавление вручную */
  app.put(`${BASE}/solution`, handle('edit', async (req, res, db, user) => {
    const id = typeof req.body?.id === 'string' ? req.body.id.trim() : '';
    if (!id) catalogFailure(400, 'Не указан ID решения');
    const patch = checkPatch(req.body?.patch);
    const before = await load(db);
    checkVersion(req.body?.expectedVersion, before.book.version);
    const at = before.book.solutions.findIndex((s) => s.id === id);
    let solutions: E3Solution[];
    if (req.body?.create === true) {
      if (at >= 0) catalogFailure(409, `Решение с ID «${id}» уже есть в каталоге`);
      const made = incoming([{
        id, mainClass: '', subclass: '', short: '', name: '', description: '', pdf: '', e3p: '', items: '', symbols: '', note: '',
        twoLevel: false, inCad: false, features: {}, featuresConfirmed: false, ...patch,
      }]);
      const sol = made[0];
      if (!sol.name || !sol.mainClass) catalogFailure(400, 'У нового решения нужны основной класс и название схемы');
      if (patch.recipeOverride?.length) sol.recipeOverride = patch.recipeOverride;
      // Признаки из названия — предложение: подтверждает человек
      if (!patch.features) {
        const s = suggestFeatures(sol, { features: before.book.features, dictionary: before.book.dictionary });
        sol.features = s.features;
        if (patch.featuresConfirmed === undefined) sol.featuresConfirmed = s.confirmed;
      }
      solutions = [...before.book.solutions, { ...sol, edited: true }];
    } else {
      if (at < 0) catalogFailure(404, `Решения «${id}» нет в каталоге`);
      // От перезаписи файлом закрывает только правка полей из файла; признаки и
      // «снято» — настройки Flux, их файл не трогает вовсе
      const touchesFile = Object.keys(patch).some((k) => (SOLUTION_FILE_FIELDS as readonly string[]).includes(k));
      const cur = before.book.solutions[at];
      const { features, ...rest } = patch;
      solutions = before.book.solutions.map((s, i) => (i === at
        ? { ...cur, ...rest, ...(features ? { features: { ...cur.features, ...features } } : {}), ...(touchesFile ? { edited: true } : {}) }
        : s));
      if (patch.removed === false) delete solutions[at].removed;
      // Пустой ручной состав — «состав по правилам»: пустой список не храним
      if (patch.recipeOverride && !patch.recipeOverride.length) delete solutions[at].recipeOverride;
    }
    res.json(await write(db, user, before, { solutions }, 'update'));
  }));

  app.put(`${BASE}/feature`, handle('edit', async (req, res, db, user) => {
    const before = await load(db);
    checkVersion(req.body?.expectedVersion, before.book.version);
    if (req.body?.delete === true) {
      const id = typeof req.body?.id === 'string' ? req.body.id : '';
      if (!before.book.features.some((f) => f.id === id)) catalogFailure(404, `Признака «${id}» нет`);
      res.json(await write(db, user, before, { features: before.book.features.filter((f) => f.id !== id), rules: before.book.rules.filter((r) => r.featureId !== id) }, 'update'));
      return;
    }
    const feature = sanitizeFeature(req.body?.feature);
    if (!feature) return catalogFailure(400, 'Признак не распознан: нужны id, класс, название, варианты ответа и вид');
    const at = before.book.features.findIndex((f) => f.id === feature.id);
    const features = at >= 0 ? before.book.features.map((f, i) => (i === at ? feature : f)) : [...before.book.features, feature];
    res.json(await write(db, user, before, { features }, 'update'));
  }));

  app.put(`${BASE}/rule`, handle('edit', async (req, res, db, user) => {
    const before = await load(db);
    checkVersion(req.body?.expectedVersion, before.book.version);
    const rule = sanitizeRule(req.body?.rule);
    if (!rule) return catalogFailure(400, 'Правило не распознано: нужны класс, признак, источник и таблица ответов');
    const same = (r: { mainClass: string; featureId: string }) => r.mainClass === rule.mainClass && r.featureId === rule.featureId;
    const rest = before.book.rules.filter((r) => !same(r));
    const at = before.book.rules.findIndex(same);
    if (req.body?.delete === true) {
      if (at < 0) catalogFailure(404, 'Такого правила нет');
      res.json(await write(db, user, before, { rules: rest }, 'update'));
      return;
    }
    const rules = at >= 0 ? before.book.rules.map((r, i) => (i === at ? rule : r)) : [...before.book.rules, rule];
    res.json(await write(db, user, before, { rules }, 'update'));
  }));

  /** Строка «Таблицы IO»: правка, добавление (create) или удаление. Поля файла после правки закрыты от перезаписи, имя изделия E3 файл не трогает вовсе */
  app.put(`${BASE}/io-row`, handle('edit', async (req, res, db, user) => {
    const before = await load(db);
    checkVersion(req.body?.expectedVersion, before.book.version);
    const table = before.book.ioTable || [];
    if (req.body?.delete === true) {
      const id = typeof req.body?.id === 'string' ? req.body.id : '';
      if (!table.some((r) => r.id === id)) catalogFailure(404, 'Такой строки в таблице IO нет');
      res.json(await write(db, user, before, { ioTable: table.filter((r) => r.id !== id) }, 'update'));
      return;
    }
    const row = sanitizeIoRow(req.body?.row);
    if (!row) return catalogFailure(400, 'Строка IO не распознана: нужны ключ, наименование и целые числа DI, DO, AI, AO');
    const at = table.findIndex((r) => r.id === row.id);
    if (req.body?.create === true) {
      if (at >= 0) catalogFailure(409, 'Такая строка (группа и наименование) в таблице IO уже есть');
      res.json(await write(db, user, before, { ioTable: [...table, { ...row, edited: true }] }, 'update'));
      return;
    }
    if (at < 0) catalogFailure(404, 'Такой строки в таблице IO нет');
    const cur = table[at];
    const touchesFile = IO_FILE_FIELDS.some((f) => JSON.stringify((row as any)[f]) !== JSON.stringify((cur as any)[f]));
    const { component, ...fileFields } = row;
    const next: E3IoRow = { ...cur, ...fileFields, ...(touchesFile || cur.edited ? { edited: true } : {}) };
    if (component) next.component = component; else delete next.component;
    res.json(await write(db, user, before, { ioTable: table.map((r, i) => (i === at ? next : r)) }, 'update'));
  }));

  /** Правило связи «решение и признаки → строка IO» — по образцу правил признаков */
  app.put(`${BASE}/io-rule`, handle('edit', async (req, res, db, user) => {
    const before = await load(db);
    checkVersion(req.body?.expectedVersion, before.book.version);
    const rules = before.book.ioRules || [];
    if (req.body?.delete === true) {
      const id = typeof req.body?.id === 'string' ? req.body.id : '';
      if (!rules.some((r) => r.id === id)) catalogFailure(404, 'Такого правила состава нет');
      res.json(await write(db, user, before, { ioRules: rules.filter((r) => r.id !== id) }, 'update'));
      return;
    }
    const rule = sanitizeIoRule(req.body?.rule);
    if (!rule) return catalogFailure(400, 'Правило состава не распознано: нужны название, класс, роль изделия, строка IO и число изделий');
    const at = rules.findIndex((r) => r.id === rule.id);
    if (req.body?.create === true && at >= 0) catalogFailure(409, `Правило с ключом «${rule.id}» уже есть`);
    res.json(await write(db, user, before, { ioRules: at >= 0 ? rules.map((r, i) => (i === at ? rule : r)) : [...rules, rule] }, 'update'));
  }));

  /** «Добавить недостающее»: что дописалось бы в книгу (ничего не пишет) и сама запись */
  app.post(`${BASE}/defaults/plan`, handle('edit', async (_req, res, db) => { res.json(planMissingDefaults((await load(db)).book)); }));
  app.post(`${BASE}/defaults/apply`, handle('edit', async (req, res, db, user) => {
    const before = await load(db);
    checkVersion(req.body?.expectedVersion, before.book.version);
    res.json(await write(db, user, before, applyMissingDefaults(before.book), 'update'));
  }));

  app.put(`${BASE}/dictionary`, handle('edit', async (req, res, db, user) => {
    const dictionary = sanitizeDictionary(req.body?.dictionary);
    if (!dictionary) return catalogFailure(400, 'Словарь обозначений: ожидается набор «код → описание»');
    const before = await load(db);
    checkVersion(req.body?.expectedVersion, before.book.version);
    res.json(await write(db, user, before, { dictionary }, 'update'));
  }));

  app.put(`${BASE}/classmap`, handle('edit', async (req, res, db, user) => {
    const classMap = sanitizeClassMap(req.body?.classMap);
    if (!classMap) return catalogFailure(400, 'Связь типов с классами: неизвестный тип оборудования или неверный список классов');
    const before = await load(db);
    checkVersion(req.body?.expectedVersion, before.book.version);
    res.json(await write(db, user, before, { classMap }, 'update'));
  }));

  app.get(`${BASE}/revisions`, handle('read', async (_req, res, db) => {
    const rows = await db.catalogRevision.findMany({ where: { entity: ENTITY, entityId: ENTITY_ID }, orderBy: { createdAt: 'desc' }, take: 20 });
    res.json(rows.map((r: any) => {
      let count = 0;
      try { count = (JSON.parse(r.snapshotJson)?.solutions || []).length; } catch (_) { /* снимок повреждён — число неизвестно */ }
      return { id: r.id, action: r.action, createdAt: r.createdAt, userId: r.userId, count };
    }));
  }));

  app.post(`${BASE}/undo`, handle('import', async (req, res, db, user) => {
    const id = typeof req.body?.revisionId === 'string' ? req.body.revisionId : '';
    if (!id) catalogFailure(400, 'Не указана запись истории');
    const rev = await db.catalogRevision.findFirst({ where: { id, entity: ENTITY, entityId: ENTITY_ID } });
    if (!rev) catalogFailure(404, 'Записи истории нет');
    const before = await load(db);
    checkVersion(req.body?.expectedVersion, before.book.version);
    let snapshot: any;
    try { snapshot = JSON.parse(rev.snapshotJson); } catch (_) { snapshot = null; }
    if (!snapshot || !Array.isArray(snapshot.solutions)) catalogFailure(409, 'Снимок записи истории повреждён — откатить нельзя');
    const { version: _v, updatedAt: _u, updatedById: _b, ...content } = snapshot;
    // Версия растёт и при откате: экран с открытой книгой должен увидеть, что она менялась
    const { book } = await write(db, user, before, { ...emptySolutionBook(), ...content }, 'restore');
    res.json({ book });
  }));

  // ── Профиль автоматизации проекта ─────────────────────────────────────────
  const profileKey = (projectId: string) => `e3_profile:${projectId}`;
  const emptyProfile = (): ProfileDoc => ({ version: 0, answers: {}, updatedAt: '' });
  const memberOnly = async (req: Request, res: Response, user: any): Promise<string | null> => {
    const projectId = String(req.params?.projectId || '');
    if (!projectId || projectId.length > 100) { res.status(400).json({ error: 'Не указан проект' }); return null; }
    if (!(await canUseProject(user, projectId))) { res.status(403).json({ error: 'Нет доступа к проекту. Попросите добавить вас в состав.' }); return null; }
    return projectId;
  };

  app.get('/api/projects/:projectId/e3-profile', handle('read', async (req, res, db, user) => {
    const projectId = await memberOnly(req, res, user);
    if (projectId) res.json(await catalogSetting(db, profileKey(projectId), emptyProfile()) as ProfileDoc);
  }));

  /** Профиль и раскладку ведёт инженер КИП: право `e3.export` (раздел 11), а не право каталога */
  const kipOnly = (res: Response, user: any): boolean => {
    if (can(user, 'e3.export')) return true;
    res.status(403).json({ error: 'Нет права вести профиль и раскладку E3: нужно право «Выгрузка в E3.series»' });
    return false;
  };

  app.put('/api/projects/:projectId/e3-profile', handle('read', async (req, res, db, user) => {
    if (!kipOnly(res, user)) return;
    const projectId = await memberOnly(req, res, user);
    if (!projectId) return;
    const answers = sanitizeProfile(req.body?.answers);
    if (!answers) return catalogFailure(400, 'Профиль: ожидается набор «признак → ответ»');
    const raw = await catalogSettingRaw(db, profileKey(projectId));
    const current: ProfileDoc = raw ? JSON.parse(raw) : emptyProfile();
    checkVersion(req.body?.expectedVersion, current.version, PROFILE_CONFLICT);
    const doc: ProfileDoc = { version: current.version + 1, answers, updatedAt: new Date().toISOString(), updatedById: user.id };
    await claimCatalogSetting(db, profileKey(projectId), raw, doc, PROFILE_CONFLICT);
    res.json(doc);
  }));

  // ── Раскладка схемы за проектом ──────────────────────────────────────────
  // Где стоят блоки на холсте, формат листа и снятые флажки. Отдельной модели не нужно: это
  // настройка проекта, как профиль, со своей версией; общая для всех, кто работает над схемой
  const layoutKey = (projectId: string) => `e3_layout:${projectId}`;
  const LAYOUT_CONFLICT = 'Раскладка схемы изменена коллегой. Обновите';
  const emptyLayout = () => ({ version: 0, format: '', placed: {} as Record<string, unknown>, off: {} as Record<string, true>, updatedAt: '' });

  app.get('/api/projects/:projectId/e3-layout', handle('read', async (req, res, db, user) => {
    const projectId = await memberOnly(req, res, user);
    if (projectId) res.json(await catalogSetting(db, layoutKey(projectId), emptyLayout()));
  }));

  app.put('/api/projects/:projectId/e3-layout', handle('read', async (req, res, db, user) => {
    if (!kipOnly(res, user)) return;
    const projectId = await memberOnly(req, res, user);
    if (!projectId) return;
    const b = req.body || {};
    const placed = b.placed && typeof b.placed === 'object' && !Array.isArray(b.placed) ? b.placed : null;
    const off = b.off && typeof b.off === 'object' && !Array.isArray(b.off) ? b.off : null;
    if (!placed || !off || Object.keys(placed).length > 5000 || Object.keys(off).length > 5000) return catalogFailure(400, 'Раскладка: ожидаются положения блоков и снятые флажки, не больше 5000');
    for (const [id, p] of Object.entries<any>(placed)) {
      const r = p?.rect;
      if (id.length > 120 || !r || ![r.x, r.y, r.w, r.h].every((n: unknown) => typeof n === 'number' && Number.isFinite(n)) || typeof p.manual !== 'boolean') return catalogFailure(400, 'Раскладка: положение блока — числа x, y, w, h и признак «вручную»');
    }
    const format = typeof b.format === 'string' && b.format.length <= 10 ? b.format : '';
    const raw = await catalogSettingRaw(db, layoutKey(projectId));
    const current: any = raw ? JSON.parse(raw) : emptyLayout();
    checkVersion(b.expectedVersion, current.version, LAYOUT_CONFLICT);
    const doc = { version: current.version + 1, format, placed, off, updatedAt: new Date().toISOString(), updatedById: user.id };
    await claimCatalogSetting(db, layoutKey(projectId), raw, doc, LAYOUT_CONFLICT);
    res.json(doc);
  }));
}
