import type { Express, Request, Response } from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import { getPrisma, notifyUser } from '../context.js';
import { canSeeProject } from './members.js';
import { handleFRequest } from '../services/guideF.js';
import { backfillGuideReplies, sanitizeGuideReplies, UNKNOWN_SCOPE } from '../services/guideReplies.js';
import { isAdminActor, isRealProjectId } from '../projectAccess.js';

/**
 * Проектные данные для Flux Guide — чтение, навигация и обучающие сценарии.
 *
 * Правила (ТЗ §11, §19, §20):
 *  - проект приходит ТОЛЬКО явно: никакого скрытого выбора первого проекта базы;
 *  - сервер сам проверяет доступ к проекту, не доверяя фронту;
 *  - парсер вопроса не имеет доступа к Prisma: он присылает структурированный
 *    запрос, а здесь валидируются тип, поля, projectId и права;
 *  - никаких изменений данных: только чтение и счётчики.
 */

const FOLD = (s: string): string => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

interface GuideError { error: string; code: string }

const fail = (res: Response, status: number, code: string, error: string): void => {
  res.status(status).json({ error, code } as GuideError);
};

/** Проект запроса: явно названный и доступный этому человеку. */
async function requireProject(req: Request, res: Response): Promise<string | null> {
  const projectId = String(req.params.projectId || '').trim();
  if (!isRealProjectId(projectId)) {
    fail(res, 400, 'NO_PROJECT', 'Не указан проект. Выберите проект в шапке Flux Guide.');
    return null;
  }
  const user = (req as any).authUser;
  const exists = await getPrisma().project.findUnique({ where: { id: projectId }, select: { id: true } });
  if (!exists) {
    fail(res, 403, 'FORBIDDEN', 'Нет доступа к этому проекту.');
    return null;
  }
  const allowed = await canSeeProject(String(user?.id || ''), projectId, isAdminActor(user));
  if (!allowed) {
    // Не раскрываем существование закрытого проекта: ответ одинаков и для
    // несуществующего, и для чужого (ТЗ §15.8)
    fail(res, 403, 'FORBIDDEN', 'Нет доступа к этому проекту.');
    return null;
  }
  return projectId;
}

// ── Разбор specs (JSON: { groups: [{ title, params: [{key,value,unit}] }] }) ──

interface SpecParam { key: string; value: string; unit: string; group: string }
interface SpecList { list: SpecParam[]; total: number }

export function flattenSpecs(raw: string | null, limit = 0): SpecList {
  if (!raw) return { list: [], total: 0 };
  try {
    const parsed = JSON.parse(raw);
    const groups = Array.isArray(parsed?.groups) ? parsed.groups : [];
    const out: SpecParam[] = [];
    let total = 0;
    for (const g of groups) {
      for (const p of (g?.params || [])) {
        if (!p?.key || p?.value === undefined) continue;
        total++;
        if (!limit || out.length < limit) {
          out.push({ key: String(p.key), value: String(p.value ?? ''), unit: String(p.unit ?? ''), group: String(g.title || '') });
        }
      }
    }
    return { list: out, total };
  } catch { return { list: [], total: 0 }; }
}

/** Адресный поиск характеристики: точное нормализованное имя приоритетнее
 *  нечётного. Двухпроходно НА ВСЕХ позициях сразу: иначе у позиции А найдётся
 *  точное «Полное давление», а у Б нечётно совпадёт «Давление» — и фильтр
 *  смешает разные параметры (нашёл QA NUM-07). */
export function findSpecExact(specs: SpecParam[], f: string): SpecParam | null {
  return specs.find((p) => FOLD(p.key) === f) || null;
}
export function findSpecFuzzy(specs: SpecParam[], f: string): SpecParam | null {
  return specs.find((p) => FOLD(p.key).includes(f) || f.includes(FOLD(p.key))) || null;
}

// ── Числовой фильтр по характеристике с пересчётом единиц ──
// Пересчёт разрешён только для известного типа величины (ТЗ §11.5).
// База — единица сида: расход м³/ч, давление Па, мощность Вт.
// Коэффициенты: 1 л/с = 3.6 м³/ч; 1 кПа = 1000 Па; 1 кВт = 1000 Вт.

const UNIT_TO_BASE: Record<string, { factor: number; quantity: string }> = {
  'м³/ч': { factor: 1, quantity: 'airflow' }, 'м3/ч': { factor: 1, quantity: 'airflow' },
  'л/с': { factor: 3.6, quantity: 'airflow' },
  'Па': { factor: 1, quantity: 'pressure' }, 'кПа': { factor: 1000, quantity: 'pressure' },
  'Вт': { factor: 1, quantity: 'power' }, 'кВт': { factor: 1000, quantity: 'power' },
};

function quantityForField(field: string): string | null {
  const key = FOLD(field);
  if (key.includes('расход') || key.includes('производительн')) return 'airflow';
  if (key.includes('давлен') || key.includes('напор')) return 'pressure';
  if (key.includes('мощност')) return 'power';
  return null;
}

export function toNumber(v: string): number | null {
  // «—», «нет данных», пусто — НЕ ноль: после очистки не должно остаться ни
  // одной цифры, иначе Number('') === 0 протащит пустое значение в фильтр
  const cleaned = String(v).replace(',', '.').replace(/\s/g, '').replace(/[^\d.\-+eE]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Значение характеристики, приведённое к базовой единице величины. */
function specValueInBase(p: SpecParam): number | null {
  const n = toNumber(p.value);
  if (n === null) return null;
  const meta = UNIT_TO_BASE[String(p.unit || '').trim()];
  return meta ? n * meta.factor : n;
}

/** Сравнение: значение строки и порог фильтра приводятся к одной базовой
 *  единице величины. Порог конвертируется по единице ФИЛЬТРА, а не строки. */
export function matchNumeric(p: SpecParam, op: string, value: number, filterUnit: string): boolean {
  const base = specValueInBase(p);
  if (base === null) return false;
  const metaFilter = UNIT_TO_BASE[String(filterUnit || '').trim()];
  const metaSpec = UNIT_TO_BASE[String(p.unit || '').trim()];
  if (metaFilter && metaSpec && metaFilter.quantity !== metaSpec.quantity) return false;
  const target = metaFilter ? value * metaFilter.factor : value;
  switch (op) {
    case '>': return base > target;
    case '<': return base < target;
    case '>=': return base >= target;
    case '<=': return base <= target;
    default: return Math.abs(base - target) < 1e-9;
  }
}

/** Оба предела сравниваются в базовой единице характеристики. */
export function matchNumericRange(p: SpecParam, min: number, max: number, filterUnit: string): boolean {
  return matchNumeric(p, '>=', min, filterUnit) && matchNumeric(p, '<=', max, filterUnit);
}

/** Сравнение ревизий: какие параметры изменились между oldSpecs и newSpecs. */
export function diffSpecs(oldRaw: string | null, newRaw: string | null): Array<{ key: string; group: string; old: string; new: string }> {
  const oldList = flattenSpecs(oldRaw).list;
  const newList = flattenSpecs(newRaw).list;
  const keyOf = (p: SpecParam) => `${FOLD(p.group)}|${FOLD(p.key)}`;
  const oldMap = new Map(oldList.map((p) => [keyOf(p), p]));
  const newMap = new Map(newList.map((p) => [keyOf(p), p]));
  const out: Array<{ key: string; group: string; old: string; new: string }> = [];
  for (const [k, p] of newMap) {
    const before = oldMap.get(k);
    if (!before) out.push({ key: p.key, group: p.group, old: '—', new: p.value });
    else if (before.value !== p.value || before.unit !== p.unit) out.push({ key: p.key, group: p.group, old: `${before.value}${before.unit ? ' ' + before.unit : ''}`, new: `${p.value}${p.unit ? ' ' + p.unit : ''}` });
  }
  for (const [k, p] of oldMap) if (!newMap.has(k)) out.push({ key: p.key, group: p.group, old: p.value, new: '—' });
  return out;
}

// ── Метаданные тега: актуальность и этап закупки ──

const parseTagMeta = (t: any): any => { try { return t.metadata ? JSON.parse(t.metadata) : {}; } catch { return {}; } };

const actualityOf = (meta: any): string => {
  const d = Array.isArray(meta?.descriptions) ? meta.descriptions : [];
  if (d.length === 0) return 'draft';
  if (d.some((x: any) => x.status === 'critical')) return 'critical';
  if (d.some((x: any) => x.status === 'warning')) return 'warning';
  if (d.some((x: any) => x.status === 'info')) return 'info';
  if (d.some((x: any) => x.status === 'actual')) return 'actual';
  return 'draft';
};

export async function procurementStages(): Promise<Array<{ id: string; label: string }>> {
  let stages = [
    { id: 'added', label: 'Добавлен' }, { id: 'ordered', label: 'Заказан' },
    { id: 'approved', label: 'Утверждён' }, { id: 'purchased', label: 'Куплен' },
  ];
  try {
    const st = await getPrisma().appSetting.findFirst({ where: { key: 'procurement_stages', userId: null } });
    if (st?.value) {
      const parsed = JSON.parse(st.value);
      if (Array.isArray(parsed) && parsed.length) stages = parsed.map((s: any) => ({ id: s.id, label: s.label }));
    }
  } catch (_) {}
  return stages;
}

interface EnrichedTag {
  id: string; identifier: string; brand: string | null; department: string | null;
  fluid: string | null; mainName: string; actuality: string;
  stageId: string; stageLabel: string; stageSince: string | null; stageIsFinal: boolean;
  supplier: string; qty: string; components: Array<{ id: string; name: string; itemCode: string }>;
}

export function enrichTags(rows: any[], stages: Array<{ id: string; label: string }>): EnrichedTag[] {
  const stageIds = stages.map((s) => s.id);
  return rows.map((t: any) => {
    const meta = parseTagMeta(t);
    const proc = meta.procurement || {};
    let stageIdx = proc.stage ? stageIds.indexOf(proc.stage) : 0;
    if (stageIdx < 0) stageIdx = 0;
    const curStageId = stages[stageIdx]?.id;
    const stageRec = curStageId ? (proc.stageLog || {})[curStageId] : null;
    return {
      id: t.id, identifier: t.identifier, brand: t.brand, department: t.department,
      fluid: t.fluid, mainName: meta.mainName || '', actuality: actualityOf(meta),
      stageId: stages[stageIdx]?.id || 'added', stageLabel: stages[stageIdx]?.label || 'Добавлен',
      stageSince: stageRec?.at || t.createdAt || null,
      stageIsFinal: stageIdx >= stages.length - 1,
      supplier: proc.supplier || '', qty: proc.qty || '',
      components: (t.componentElements || []).map((c: any) => ({ id: c.id, name: c.name, itemCode: c.itemCode })),
    };
  });
}

const PAGE_MAX = 200;
const pageOf = (req: Request): { limit: number; offset: number } => {
  const limit = Math.min(PAGE_MAX, Math.max(1, Number(req.query.limit) || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  return { limit, offset };
};

// ── Плоский список компонентов проекта (для фильтров и поиска) ──

interface FlatComponent {
  id: string; name: string; itemCode: string; equipType: string; role: string;
  systemName: string; systemCategory: string; monoblockName: string;
  status: string; hasConflict: boolean; paramConflicts: string | null; version: number;
  tags: Array<{ id: string; identifier: string }>;
  specs: SpecParam[]; specsTotal: number;
}

export async function flatComponents(projectId: string): Promise<FlatComponent[]> {
  const systems = await getPrisma().equipmentSystem.findMany({
    where: { projectId },
    include: { monoblocks: { include: { components: { include: { tags: true } } } } },
    orderBy: { createdAt: 'asc' },
  });
  const out: FlatComponent[] = [];
  for (const sys of systems as any[]) {
    for (const mono of (sys.monoblocks || [])) {
      for (const comp of (mono.components || [])) {
        const f = flattenSpecs(comp.specs);
        out.push({
          id: comp.id, name: comp.name, itemCode: comp.itemCode,
          equipType: comp.equipType || comp.equipClass || 'ПРОЧЕЕ',
          role: comp.role || 'БЛОК',
          systemName: sys.name, systemCategory: sys.category, monoblockName: mono.name,
          status: comp.status, hasConflict: !!comp.hasConflict,
          paramConflicts: comp.paramConflicts || null, version: comp.version || 1,
          tags: (comp.tags || []).map((t: any) => ({ id: t.id, identifier: t.identifier })),
          specs: f.list, specsTotal: f.total,
        });
      }
    }
  }
  return out;
}

export function registerGuideRoutes(app: Express, deps: { io: SocketIOServer }): void {
  const io = deps.io;
  // Миграция прежних плоских F-ответов в структурное хранение (F-ACL-03/ACL-08)
  backfillGuideReplies().then((n) => { if (n) console.log(`[Guide] Мигрировано сервисных ответов: ${n}`); }).catch((e) => console.error('[Guide] Миграция ответов:', e.message));
  // ── Список проектов, видимых этому человеку ──
  app.get('/api/guide/projects', async (req: Request, res: Response) => {
    try {
      const user = (req as any).authUser;
      const admin = isAdminActor(user);
      const prisma = getPrisma();
      const rows = await prisma.project.findMany({
        where: { system: false },
        select: { id: true, name: true, code: true, status: true, customer: true },
        orderBy: { createdAt: 'asc' },
      });
      const members = await prisma.projectMember.findMany({ select: { projectId: true, userId: true } });
      const hidden = new Set<string>();
      const byProject = new Map<string, Set<string>>();
      for (const m of members as any[]) {
        if (!byProject.has(m.projectId)) byProject.set(m.projectId, new Set());
        byProject.get(m.projectId)!.add(m.userId);
      }
      for (const [pid, users] of byProject) {
        if (!admin && users.size > 0 && !users.has(String(user?.id || ''))) hidden.add(pid);
      }
      res.json({ projects: rows.filter((p: any) => !hidden.has(p.id)) });
    } catch (err: any) { fail(res, 500, 'UNAVAILABLE', err.message); }
  });

  // ── Сводка проекта: строгие счётчики (ТЗ §12.1) ──
  app.get('/api/guide/project/:projectId/summary', async (req: Request, res: Response) => {
    try {
      const projectId = await requireProject(req, res);
      if (!projectId) return;
      const prisma = getPrisma();
      const [tags, systems, monoblocks, components, stages, project] = await Promise.all([
        prisma.tag.findMany({ where: { projectId }, select: { id: true, identifier: true, metadata: true } }),
        prisma.equipmentSystem.findMany({ where: { projectId } }),
        prisma.monoblock.findMany({ where: { system: { projectId } } }),
        flatComponents(projectId),
        procurementStages(),
        prisma.project.findUnique({ where: { id: projectId }, select: { name: true, code: true, status: true, customer: true } }),
      ]);

      const codes = new Map<string, string[]>();
      for (const t of tags as any[]) {
        const code = String(t.identifier || '').trim();
        if (code) (codes.get(code) || codes.set(code, []).get(code)!).push(t.id);
      }
      const duplicates = [...codes.entries()].filter(([, ids]) => ids.length > 1);
      const categories = new Map<string, number>();
      for (const c of components) categories.set(c.equipType, (categories.get(c.equipType) || 0) + 1);

      res.json({
        project,
        counts: {
          tags: tags.length,
          systems: systems.length,
          monoblocks: monoblocks.length,
          components: components.length,
          componentsNoTag: components.filter((c) => !c.tags.length).length,
          duplicates: duplicates.length,
          conflicts: components.filter((c) => c.hasConflict).length,
        },
        categories: [...categories.entries()].sort((a, b) => b[1] - a[1]).map(([type, count]) => ({ type, count })),
        stages,
      });
    } catch (err: any) { fail(res, 500, 'UNAVAILABLE', err.message); }
  });

  // ── Теги проекта: поиск, фильтры, пагинация ──
  app.get('/api/guide/project/:projectId/tags', async (req: Request, res: Response) => {
    try {
      const projectId = await requireProject(req, res);
      if (!projectId) return;
      const prisma = getPrisma();
      const { limit, offset } = pageOf(req);
      const q = String(req.query.q || '').trim();
      const exact = String(req.query.exact || '') === '1';
      const stage = String(req.query.stage || '').trim();
      const actuality = String(req.query.actuality || '').trim();

      const rows = await prisma.tag.findMany({
        where: { projectId },
        include: { componentElements: { select: { id: true, name: true, itemCode: true } } },
        orderBy: { identifier: 'asc' },
      });
      const stages = await procurementStages();
      let list = enrichTags(rows as any[], stages);

      if (q) {
        list = exact
          ? list.filter((t) => t.identifier === q) // точный код: без самовольных исправлений
          : list.filter((t) => FOLD(t.identifier).includes(FOLD(q)) || FOLD(t.mainName).includes(FOLD(q)) || FOLD(t.brand || '').includes(FOLD(q)));
      }
      if (stage) list = list.filter((t) => t.stageId === stage);
      if (actuality) list = list.filter((t) => t.actuality === actuality);
      if (String(req.query.dup || '') === '1') {
        const seen = new Map<string, number>();
        for (const t of list) seen.set(t.identifier, (seen.get(t.identifier) || 0) + 1);
        list = list.filter((t) => (seen.get(t.identifier) || 0) > 1);
      }

      res.json({ total: list.length, items: list.slice(offset, offset + limit), stages, truncated: offset + limit < list.length });
    } catch (err: any) { fail(res, 500, 'UNAVAILABLE', err.message); }
  });

  // ── Оборудование проекта: фильтры, поиск, пагинация ──
  app.get('/api/guide/project/:projectId/components', async (req: Request, res: Response) => {
    try {
      const projectId = await requireProject(req, res);
      if (!projectId) return;
      const { limit, offset } = pageOf(req);
      const q = FOLD(String(req.query.q || ''));
      const equipType = String(req.query.type || '').trim().toUpperCase();
      const untagged = String(req.query.untagged || '') === '1';
      const missing = String(req.query.missing || '').trim();

      let list = await flatComponents(projectId);
      if (equipType) list = list.filter((c) => c.equipType === equipType);
      if (untagged) list = list.filter((c) => !c.tags.length);
      if (missing) list = list.filter((c) => !findSpecExact(c.specs, FOLD(missing)) && !findSpecFuzzy(c.specs, FOLD(missing)));
      if (q) list = list.filter((c) =>
        FOLD(c.name).includes(q) || FOLD(c.itemCode).includes(q) || FOLD(c.systemName).includes(q)
        || c.tags.some((t) => FOLD(t.identifier).includes(q))
        || c.specs.some((p) => FOLD(p.value).includes(q)));

      res.json({ total: list.length, items: list.slice(offset, offset + limit), truncated: offset + limit < list.length });
    } catch (err: any) { fail(res, 500, 'UNAVAILABLE', err.message); }
  });

  // ── Точный тег по коду: без исправлений ввода, с полной карточкой ──
  app.get('/api/guide/project/:projectId/tag/:identifier', async (req: Request, res: Response) => {
    try {
      const projectId = await requireProject(req, res);
      if (!projectId) return;
      const identifier = String(req.params.identifier || '').trim();
      if (!identifier || identifier.length > 120) return fail(res, 400, 'BAD_TAG', 'Некорректный код тега.');

      const rows = await getPrisma().tag.findMany({
        where: { projectId },
        include: { componentElements: { include: { monoblock: { include: { system: true } } } } },
      });
      const matches = (rows as any[]).filter((t) => String(t.identifier).trim() === identifier);
      // Точное совпадение — критично: похожие коды (002B / 0028) не подставляются
      if (!matches.length) return res.json({ status: 'no-match', identifier });

      const stages = await procurementStages();
      const enriched = enrichTags(
        matches.map((m) => ({ ...m, componentElements: (m.componentElements || []).map((c: any) => ({ id: c.id, name: c.name, itemCode: c.itemCode })) })),
        stages,
      );
      // Уровень: где стоит тег — на компоненте, моноблоке или системе. Главный
      // тег установки и тег компонента различаются (ТЗ §11.3)
      const places = matches.flatMap((m: any) => (m.componentElements || []).map((c: any) => ({
        componentId: c.id, component: c.name, itemCode: c.itemCode,
        equipType: c.equipType || '', monoblock: c.monoblock?.name || '', system: c.monoblock?.system?.name || '',
        specs: flattenSpecs(c.specs).list, specsTotal: flattenSpecs(c.specs).total,
      })));
      res.json({ status: 'ok', identifier, tags: enriched, places });
    } catch (err: any) { fail(res, 500, 'UNAVAILABLE', err.message); }
  });

  // ── Характеристика: адресный запрос по позиции/полю (без SPEC_LIMIT) ──
  app.get('/api/guide/project/:projectId/spec', async (req: Request, res: Response) => {
    try {
      const projectId = await requireProject(req, res);
      if (!projectId) return;
      const field = String(req.query.field || '').trim();
      if (!field) return fail(res, 400, 'NO_FIELD', 'Не указана характеристика.');
      const componentId = String(req.query.componentId || '').trim();
      // Числовой фильтр: «расход больше 1000» — по известной единице (ТЗ §9, §34.2-14)
      const op = String(req.query.op || '');
      const valueRaw = req.query.value;
      const unit = String(req.query.unit || '').trim();
      const minRaw = req.query.min;
      const maxRaw = req.query.max;
      const hasAnyRangeBound = minRaw !== undefined || maxRaw !== undefined;
      const hasRange = hasAnyRangeBound && minRaw !== undefined && maxRaw !== undefined;
      const min = Number(minRaw);
      const max = Number(maxRaw);
      if (hasAnyRangeBound && (!hasRange || !Number.isFinite(min) || !Number.isFinite(max) || min > max)) {
        return fail(res, 400, 'invalid_range', 'Для диапазона нужны обе числовые границы, нижняя не больше верхней.');
      }
      if (hasAnyRangeBound && op) return fail(res, 400, 'invalid_range', 'Нельзя передавать диапазон вместе с одиночным порогом.');
      // Явно названная единица должна быть известной: молчаливое игнорирование
      // возвращало бы неверные выборки (NUM-V3-01)
      if ((op || hasRange) && unit && !UNIT_TO_BASE[unit]) {
        return fail(res, 400, 'invalid_unit', 'Единица «' + unit + '» не поддерживается. Допустимо: м³/ч, л/с для расхода; Па, кПа для давления; Вт, кВт для мощности.');
      }
      const requestedQuantity = quantityForField(field);
      if ((op || hasRange) && unit && requestedQuantity && UNIT_TO_BASE[unit]?.quantity !== requestedQuantity) {
        return fail(res, 400, 'invalid_unit', `Единица «${unit}» несовместима с характеристикой «${field}».`);
      }
      const hasNumeric = hasRange || (['>', '<', '>=', '<=', '='].includes(op) && valueRaw !== undefined && valueRaw !== '' && !!UNIT_TO_BASE[unit]);

      let components = await flatComponents(projectId);
      if (componentId) components = components.filter((c) => c.id === componentId);
      // Проход 1: точное имя. Нечётный проход включается только если точного
      // нет НИ У ОДНОЙ позиции: иначе «Полное давление» смешается с «Давление»
      const exact = new Map<string, SpecParam | null>();
      let exactTotal = 0;
      for (const c of components) {
        const hit = findSpecExact(c.specs, FOLD(field));
        exact.set(c.id, hit);
        if (hit) exactTotal++;
      }
      const allowFuzzy = exactTotal === 0;
      let rows = components
        .map((c) => ({ c, found: exact.get(c.id) || (allowFuzzy ? findSpecFuzzy(c.specs, FOLD(field)) : null) }))
        .filter((r) => r.found !== null)
        .map((r) => ({
          componentId: r.c.id, name: r.c.name, itemCode: r.c.itemCode, equipType: r.c.equipType,
          system: r.c.systemName, tags: r.c.tags.map((t) => t.identifier),
          field: r.found!.key, value: r.found!.value, unit: r.found!.unit, group: r.found!.group,
          specsTotal: r.c.specsTotal,
        }));
      if (hasNumeric) {
        rows = rows.filter((r) => {
          const p = { key: r.field, value: r.value, unit: r.unit, group: r.group };
          return hasRange ? matchNumericRange(p, min, max, unit) : matchNumeric(p, op, Number(valueRaw), unit);
        });
      }
      const { limit, offset } = pageOf(req);
      res.json({ total: rows.length, items: rows.slice(offset, offset + limit), truncated: offset + limit < rows.length });
    } catch (err: any) { fail(res, 500, 'UNAVAILABLE', err.message); }
  });

  // ── Ревизии: история изменений позиций и конфликты (ТЗ §12.6, §34.2-16) ──
  app.get('/api/guide/project/:projectId/revisions', async (req: Request, res: Response) => {
    try {
      const projectId = await requireProject(req, res);
      if (!projectId) return;
      const prisma = getPrisma();
      const componentId = String(req.query.componentId || '').trim();
      const tag = String(req.query.tag || '').trim();
      const q = FOLD(String(req.query.q || ''));
      const conflictsOnly = String(req.query.conflicts || '') === '1';

      let components = await flatComponents(projectId);
      if (componentId) components = components.filter((c) => c.id === componentId);
      if (tag) {
        components = components.filter((c) => c.tags.some((t) => t.identifier === tag)); // точный код
      }
      if (q) components = components.filter((c) => FOLD(c.name).includes(q) || FOLD(c.itemCode).includes(q));
      if (conflictsOnly) components = components.filter((c) => c.hasConflict);

      const ids = components.slice(0, 25).map((c) => c.id);
      const history = ids.length ? await prisma.equipmentHistory.findMany({
        where: { elementId: { in: ids } },
        orderBy: { changedAt: 'desc' },
        take: 200,
      }) : [];

      const byComponent = new Map<string, any[]>();
      for (const h of history as any[]) {
        (byComponent.get(h.elementId) || byComponent.set(h.elementId, []).get(h.elementId)!).push(h);
      }
      const rows = components.slice(0, 25).map((c) => ({
        componentId: c.id, name: c.name, itemCode: c.itemCode, equipType: c.equipType,
        system: c.systemName, monoblock: c.monoblockName, tags: c.tags.map((t) => t.identifier),
        hasConflict: c.hasConflict,
        conflicts: (parseJsonSafe((c as any).paramConflicts) || []) as Array<{ group: string; key: string; oldValue: string; newValue: string; unit: string }>,
        revisions: (byComponent.get(c.id) || []).slice(0, 5).map((h) => ({
          id: h.id, version: h.version, changedAt: h.changedAt, changeType: h.changeType,
          changes: diffSpecs(h.oldSpecs, h.newSpecs).slice(0, 10),
        })),
      }));
      res.json({ total: components.length, items: rows, truncated: components.length > 25 });
    } catch (err: any) { fail(res, 500, 'UNAVAILABLE', err.message); }
  });

  // ── Документы: файлы по тегу или по имени (ТЗ §12.7) ──
  app.get('/api/guide/project/:projectId/files', async (req: Request, res: Response) => {
    try {
      const projectId = await requireProject(req, res);
      if (!projectId) return;
      const prisma = getPrisma();
      const tag = String(req.query.tag || '').trim();
      const q = FOLD(String(req.query.q || ''));
      if (!tag && !q) return fail(res, 400, 'NO_QUERY', 'Укажите тег или название файла.');
      const { limit, offset } = pageOf(req);
      const user = (req as any).authUser;

      const baseWhere: any = { deletedAt: null, folder: { projectId, deletedAt: null } };
      // Личные файлы видим только владелец и администратор
      const admin = isAdminActor(user);
      baseWhere.OR = [{ scope: 'SHARED' }, ...(admin ? [{ scope: 'PERSONAL' }] : [{ scope: 'PERSONAL', ownerId: String(user?.id || '') }])];

      let rows: any[] = [];
      if (tag) {
        // Точный код тега (без исправлений ввода)
        const tags = await prisma.tag.findMany({ where: { projectId, identifier: tag }, select: { id: true } });
        const ids = tags.map((t: any) => t.id);
        if (ids.length) {
          rows = await prisma.fileNode.findMany({
          where: { AND: [baseWhere, { OR: [{ mainTags: { some: { id: { in: ids } } } }, { additionalTags: { some: { id: { in: ids } } } }] }] },
            include: { mainTags: { select: { identifier: true } }, additionalTags: { select: { identifier: true } }, folder: { select: { name: true } } },
            orderBy: { updatedAt: 'desc' },
          });
        }
      } else {
        rows = await prisma.fileNode.findMany({
          where: { ...baseWhere, name: { contains: q } },
          include: { mainTags: { select: { identifier: true } }, additionalTags: { select: { identifier: true } }, folder: { select: { name: true } } },
          orderBy: { updatedAt: 'desc' },
          take: 500,
        });
        rows = rows.filter((f) => FOLD(f.name).includes(q));
      }
      const items = rows.slice(offset, offset + limit).map((f) => ({
        id: f.id, name: f.name, folder: f.folder?.name || '', size: f.size,
        revision: f.revision, statusCode: f.statusCode, updatedAt: f.updatedAt,
        mainTags: (f.mainTags || []).map((t: any) => t.identifier),
        additionalTags: (f.additionalTags || []).map((t: any) => t.identifier),
      }));
      res.json({ total: rows.length, items, truncated: offset + limit < rows.length });
    } catch (err: any) { fail(res, 500, 'UNAVAILABLE', err.message); }
  });

  // ── F-ответ в Messenger: сервисный отправитель + проверка аудитории (ТЗ §1) ──
  app.post('/api/guide/chat-reply', async (req: Request, res: Response) => {
    try {
      const actorId = String((req as any).authUser?.id || '');
      if (!actorId) return fail(res, 401, 'NO_AUTH', 'Требуется вход.');
      const type = String(req.body?.type) === 'GROUP' ? 'GROUP' : 'DIRECT';
      const conversationId = String(req.body?.conversationId || '');
      const requestMessageId = String(req.body?.requestMessageId || '');
      const projectId = req.body?.projectId ? String(req.body.projectId) : undefined;
      if (!conversationId || !requestMessageId) {
        return fail(res, 400, 'BAD_REQUEST', 'Не указан разговор или сообщение вопроса.');
      }
      const result = await handleFRequest({ type, conversationId, requestMessageId, question: '', actorId, projectId });
      if (!result.replyId) return res.json({ ok: true, published: result.published, refusal: result.refusal, text: result.text });

      // Рассылка события только участникам (та же конвенция комнат, что в chat.ts)
      const prisma = getPrisma();
      let memberIds: string[] = [];
      if (type === 'GROUP') {
        const group = await prisma.chatGroup.findUnique({ where: { id: conversationId }, include: { members: { select: { id: true } } } });
        memberIds = [...new Set([group?.ownerId, ...(group?.members || []).map((m: any) => m.id)].filter(Boolean) as string[])];
      } else {
        memberIds = [actorId, conversationId];
      }
      const reply = await prisma.chatMessage.findUnique({
        where: { id: result.replyId }, include: { sender: { select: { id: true, name: true, symbol: true } }, replyTo: true, guideReply: { select: { projectId: true, kind: true } } },
      });
      if (reply) {
        // Рассылка каждому участнику его (санитизированного) представления
        for (const memberId of memberIds) {
          const full = await prisma.chatMessage.findUnique({
            where: { id: reply.id },
            include: {
              attachments: true,
              sender: { select: { id: true, name: true, symbol: true, role: true } },
              guideReply: { select: { projectId: true, kind: true } },
              replyTo: { select: { id: true, content: true, senderId: true, receiverId: true, chatGroupId: true, guideReply: { select: { projectId: true, kind: true } }, sender: { select: { id: true, name: true } } } },
            },
          });
          const member = await prisma.user.findUnique({ where: { id: memberId }, select: { role: true } });
          const [safe] = await sanitizeGuideReplies([full as any], memberId, isAdminActor(member));
          io.to(`user:${memberId}`).emit('chat:message_received', safe);
          if (result.published && memberId !== actorId) {
            await notifyUser(memberId, 'ЧАТ', 'Новый ответ Flux Guide', 'В разговоре опубликован ответ Flux Guide.', type === 'GROUP' ? `/chat?group=${conversationId}` : `/chat?from=${actorId}`);
          }
        }
      }
      res.json({ ok: true, published: result.published, refusal: result.refusal, text: result.text, replyId: result.replyId, guideReply: reply?.guideReply || null });
    } catch (err: any) { fail(res, 500, 'UNAVAILABLE', err.message); }
  });

  // ── История вопросов Guide (ТЗ v3 §4) ──
  // Хранилище — существующая таблица AssistantChat (владелец + проект, ТЗ §22:
  // схему не плодить). Чаты Guide отличимы по role='guide' в сообщениях; старые
  // разговоры «Помощника» остаются архивом и в списки Guide не попадают.

  const meId = (req: Request): string => String((req as any).authUser?.id || '');

  const isGuideChat = (raw: string): boolean => {
    try {
      const arr = JSON.parse(raw || '[]');
      return Array.isArray(arr) && arr.some((m: any) => m?.role === 'guide');
    } catch { return false; }
  };

  let guideKindMigration: Promise<void> | null = null;
  const ensureGuideChatKinds = (): Promise<void> => {
    if (!guideKindMigration) guideKindMigration = (async () => {
      const prisma = getPrisma();
      const legacy = await prisma.assistantChat.findMany({ where: { kind: 'assistant' }, select: { id: true, messages: true } });
      for (const row of legacy as any[]) if (isGuideChat(row.messages)) {
        await prisma.assistantChat.updateMany({ where: { id: row.id, kind: 'assistant' }, data: { kind: 'guide' } });
      }
    })().catch((error) => { guideKindMigration = null; throw error; });
    return guideKindMigration;
  };

  const safeGuideHistory = async (row: any, user: any): Promise<{ messages: any[]; title: string; preview: string; search: string }> => {
    const messages = (parseJsonSafe(row.messages) || []) as any[];
    const fallbackProjectId = String(row.projectId || '');
    const viewerId = String(user?.id || '');
    const revoked = new Set<number>();
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      const messageProjectId = typeof message?.projectId === 'string'
        ? message.projectId
        : typeof message?.context?.projectId === 'string' ? message.context.projectId : (fallbackProjectId || UNKNOWN_SCOPE);
      if (messageProjectId && (messageProjectId === UNKNOWN_SCOPE || !(await canSeeProject(viewerId, messageProjectId, isAdminActor(user))))) revoked.add(i);
    }
    const clean = messages.map((message, index) => {
      if (!revoked.has(index)) return message;
      const { actions, table, cards, list, clarify, context, source, outcome, ...rest } = message;
      return { ...rest, text: 'Данные этого ответа сейчас недоступны.', outcome: undefined, status: 'permission', source: { label: 'Источник недоступен', at: '' } };
    });
    const hasRevoked = revoked.size > 0;
    const title = hasRevoked ? 'Разговор по проекту' : String(row.title || '');
    const last = clean[clean.length - 1];
    const preview = String(last?.outcome || last?.text || '');
    return {
      messages: clean,
      title,
      preview: preview.slice(0, 120),
      search: `${title} ${clean.map((m) => String(m?.text || '')).join(' ')}`.toLowerCase().slice(0, 8000),
    };
  };

  app.get('/api/guide/chats', async (req: Request, res: Response) => {
    try {
      const me = meId(req);
      if (!me) return res.json({ chats: [] });
      await ensureGuideChatKinds();
      const q = FOLD(String(req.query.q || ''));
      const archived = String(req.query.archived || '') === '1';
      const rows = await getPrisma().assistantChat.findMany({
        where: { ownerId: me, kind: 'guide', archivedAt: archived ? { not: null } : null },
        orderBy: { updatedAt: 'desc' },
        take: 1000,
        select: { id: true, projectId: true, title: true, preview: true, messages: true, search: true, updatedAt: true, archivedAt: true },
      });
      const chats = await Promise.all((rows as any[])
        .map(async (r) => {
          const safe = await safeGuideHistory(r, (req as any).authUser);
          return { row: r, safe };
        }));
      const visible = chats
        .filter(({ safe }) => !q || FOLD(safe.search).includes(q))
        .map(({ row, safe }) => ({ id: row.id, projectId: row.projectId, title: safe.title, preview: safe.preview, updatedAt: row.updatedAt, archivedAt: row.archivedAt }));
      res.json({ chats: visible });
    } catch (err: any) { fail(res, 500, 'UNAVAILABLE', err.message); }
  });

  app.get('/api/guide/chats/:id', async (req: Request, res: Response) => {
    try {
      const me = meId(req);
      await ensureGuideChatKinds();
      const row = await getPrisma().assistantChat.findUnique({ where: { id: String(req.params.id || '') } });
      // Владелец сверяется ещё раз: подставить чужой идентификатор недостаточно
      if (!row || row.ownerId !== me || row.kind !== 'guide') return res.status(404).json({ error: 'Разговор не найден.' });
      const safe = await safeGuideHistory(row, (req as any).authUser);
      res.json({ chat: { id: row.id, projectId: row.projectId, title: safe.title, messages: safe.messages, archivedAt: row.archivedAt } });
    } catch (err: any) { fail(res, 500, 'UNAVAILABLE', err.message); }
  });

  app.put('/api/guide/chats/:id', async (req: Request, res: Response) => {
    try {
      const me = meId(req);
      if (!me) return fail(res, 401, 'NO_AUTH', 'Требуется вход.');
      await ensureGuideChatKinds();
      const id = String(req.params.id || '');
      const body = req.body || {};
      const messages = Array.isArray(body.messages) ? body.messages : [];
      // Пустой разговор в базе не создаётся: сохранение начинается с первого вопроса
      if (!messages.some((m: any) => m?.role === 'user')) return res.json({ chat: { id, skipped: true } });
      const title = String(body.title || '').slice(0, 80);
      const firstUser = messages.find((m: any) => m?.role === 'user');
      const search = messages.map((m: any) => String(m?.text || '')).join(' ').toLowerCase().slice(0, 8000);
      const preview = String(messages.length ? (messages[messages.length - 1]?.outcome || messages[messages.length - 1]?.text || '') : '').slice(0, 120);
      const data = {
        ownerId: me, kind: 'guide', projectId: String(body.projectId || ''), title: title || String(firstUser?.text || 'Вопрос').slice(0, 60),
        preview, messages: JSON.stringify(messages), search,
      };
      const existing = await getPrisma().assistantChat.findUnique({ where: { id } });
      // Обновлять можно только свой разговор
      if (existing && existing.ownerId !== me) return fail(res, 403, 'FORBIDDEN', 'Это не ваш разговор.');
      if (existing && existing.kind !== 'guide') return fail(res, 409, 'WRONG_CHAT_KIND', 'Идентификатор уже принадлежит другому типу разговора.');
      if (existing?.archivedAt) return fail(res, 409, 'ARCHIVED', 'Сначала восстановите разговор из архива.');
      const projectId = String(body.projectId || '');
      const scopedProjects = [...new Set([projectId, ...messages.map((m: any) => typeof m?.projectId === 'string' ? m.projectId : m?.context?.projectId)].filter((pid): pid is string => typeof pid === 'string' && !!pid))];
      for (const scopedProject of scopedProjects) {
        if (!(await canSeeProject(me, scopedProject, isAdminActor((req as any).authUser)))) return fail(res, 403, 'FORBIDDEN', 'Нет доступа к проекту разговора.');
      }
      const chat = existing
        ? await getPrisma().assistantChat.update({ where: { id }, data })
        : await getPrisma().assistantChat.create({ data: { id, ...data } });
      res.json({ chat: { id: chat.id, title: chat.title, updatedAt: chat.updatedAt } });
    } catch (err: any) { fail(res, 500, 'UNAVAILABLE', err.message); }
  });

  app.post('/api/guide/chats/:id/archive', async (req: Request, res: Response) => {
    try {
      const me = meId(req);
      await ensureGuideChatKinds();
      const row = await getPrisma().assistantChat.findUnique({ where: { id: String(req.params.id || '') } });
      if (!row || row.ownerId !== me || row.kind !== 'guide') return res.status(404).json({ error: 'Разговор не найден.' });
      if (!row.archivedAt) await getPrisma().assistantChat.update({ where: { id: row.id }, data: { archivedAt: new Date() } });
      res.json({ ok: true });
    } catch (err: any) { fail(res, 500, 'UNAVAILABLE', err.message); }
  });

  app.post('/api/guide/chats/:id/restore', async (req: Request, res: Response) => {
    try {
      const me = meId(req);
      await ensureGuideChatKinds();
      const row = await getPrisma().assistantChat.findUnique({ where: { id: String(req.params.id || '') } });
      if (!row || row.ownerId !== me || row.kind !== 'guide') return res.status(404).json({ error: 'Разговор не найден.' });
      if (row.archivedAt) await getPrisma().assistantChat.update({ where: { id: row.id }, data: { archivedAt: null } });
      res.json({ ok: true });
    } catch (err: any) { fail(res, 500, 'UNAVAILABLE', err.message); }
  });

  // Скрыть из списка означает архивировать; уже сохранённая история не удаляется.
  app.delete('/api/guide/chats/:id', async (req: Request, res: Response) => {
    try {
      const me = meId(req);
      await ensureGuideChatKinds();
      const row = await getPrisma().assistantChat.findUnique({ where: { id: String(req.params.id || '') } });
      if (!row || row.ownerId !== me || row.kind !== 'guide') return res.json({ ok: true });
      if (!row.archivedAt) await getPrisma().assistantChat.update({ where: { id: row.id }, data: { archivedAt: new Date() } });
      res.json({ ok: true });
    } catch (err: any) { fail(res, 500, 'UNAVAILABLE', err.message); }
  });
}

function parseJsonSafe(raw: string | null | undefined): unknown {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
