import { EquipParseResult, SpecGroup, SpecParam, TagEvidence } from './equipmentParser.js';
import { flattenGroups } from './equipmentImport.js';
import { overrideKey, blockKey, matchSystem } from './specUtils.js';
import { planTagLinks, type TagLink, type ExistingTag } from './equipmentTags.js';
import { importPolicyOfProject } from './routes/tagPolicy.js';
import { parseRuNumber } from './normalize.js';

// ── Dry-run план импорта (Фаза 2 «Импорт бланков 2.0») ──
// Считает, ЧТО изменится в проекте, НЕ трогая БД: инженер видит дерево
// установок с диффом и предупреждениями до записи. Тот же обход, что и
// importEquipmentToDB, но только чтение.

// Составной ключ блока живёт в specUtils — им пользуется и запись импорта
export { blockKey } from './specUtils.js';

export interface PlanParam {
  group: string; key: string; value: string; unit: string;
  status: 'new' | 'changed' | 'same'; oldValue?: string;
  warning?: string; // валидация значения (§5.5 дизайна)
}

export interface PlanBlock {
  key: string;                 // blockKey
  systemName: string;
  monoblockName: string;       // '' для параметров самой установки
  itemCode: string;
  title: string;
  equipType: string;
  action: 'create' | 'update' | 'unchanged';
  params: PlanParam[];
  changedCount: number;
  newCount: number;
  overrideImpact: number;      // сколько ручных правок инженера перекроет обновление

  // ── Состав: где позиция стоит ──
  /** Роль позиции: БЛОК, ВЕНТИЛЯТОР, ДВИГАТЕЛЬ, КЛАПАН, ПРИВОД, ДАТЧИК… */
  role?: string;
  /** blockKey владельца; пусто — блок */
  parentKey?: string;
  /** Номер экземпляра и сколько их всего: «Вентилятор №2 из 2» */
  instanceNo?: number;
  instanceCount?: number;
  /** Порядок появления в файле */
  sourceOrder?: number;
  /** Откуда взялись теги позиции и что с ними решено */
  tagNotes?: TagEvidence[];
  /** Вид узла выгрузки; `note` — позиция заведена по примечанию */
  sourceKind?: string;
}

export interface PlanSystem {
  name: string; title: string;
  action: 'create' | 'match';  // новая установка или обновление существующей
  matchedName?: string;        // если сопоставлена fuzzy — фактическое имя в БД
  /** Обозначение исправлено при разборе: что было в файле и что заменено */
  nameFix?: { from: string; what: string };
}

export interface ImportPlan {
  systems: PlanSystem[];
  blocks: PlanBlock[];
  /**
   * Технологические позиции бланка: что с каждой сделать — привязать к
   * существующему тегу, завести новый или пропустить. Решает инженер в
   * предпросмотре; молча теги не создаются и не перевешиваются.
   */
  tagLinks: TagLink[];
  /**
   * Виды узлов выгрузки, которых программа не знает.
   *
   * Разбор собирал их всегда, а до окна они не доходили — предпросмотр о них
   * молчал, и позиция тихо не приезжала. Теперь их видно, и человек относит
   * вид к роли прямо здесь.
   */
  unknownKinds?: string[];
  totals: { systems: number; newBlocks: number; updatedBlocks: number; unchangedBlocks: number; conflicts: number; warnings: number; overrides: number; tagsNew: number; tagsLinked: number; tagsInvalid: number };
}

// ── Валидация значений по типу оборудования (§5.5) ──
// Данные, не код: нарушение — жёлтая пометка «проверьте», не ошибка.
interface RangeRule { keys: string[]; min: number; max: number; label: string }
const RANGE_RULES: Record<string, RangeRule[]> = {
  ВЕНТИЛЯТОР: [
    { keys: ['расход'], min: 1, max: 500000, label: 'расход воздуха, м³/ч' },
    { keys: ['давлен', 'напор'], min: 0, max: 20000, label: 'давление, Па' },
    { keys: ['мощност'], min: 0, max: 2000, label: 'мощность, кВт' },
    { keys: ['оборот', 'об/мин'], min: 0, max: 60000, label: 'обороты, об/мин' },
  ],
  НАГРЕВАТЕЛЬ: [
    { keys: ['мощност'], min: 0, max: 100000, label: 'мощность, кВт' },
    { keys: ['температ'], min: -60, max: 300, label: 'температура, °C' },
  ],
  ОХЛАДИТЕЛЬ: [
    { keys: ['мощност'], min: 0, max: 100000, label: 'мощность, кВт' },
    { keys: ['температ'], min: -60, max: 100, label: 'температура, °C' },
  ],
  ФИЛЬТР: [
    { keys: ['сопротивл', 'давлен'], min: 0, max: 5000, label: 'сопротивление, Па' },
  ],
};
// Габариты — общие для любого типа
const COMMON_RANGES: RangeRule[] = [
  { keys: ['высот', 'ширин', 'длин', 'глубин', 'диаметр'], min: 1, max: 20000, label: 'размер, мм' },
  { keys: ['масс', 'вес'], min: 0, max: 50000, label: 'масса, кг' },
];

const parseNum = parseRuNumber;

function validateParam(equipType: string, key: string, value: string): string | undefined {
  const kl = key.toLowerCase();
  const rules = [...(RANGE_RULES[equipType] || []), ...COMMON_RANGES];
  const rule = rules.find(r => r.keys.some(k => kl.includes(k)));
  if (!rule) return undefined;
  const n = parseNum(value);
  if (n === null) return value.trim() === '' ? undefined : undefined; // нечисло у размерного — не наша забота здесь
  if (n < rule.min || n > rule.max) return `значение вне диапазона (${rule.label}: ${rule.min}…${rule.max})`;
  return undefined;
}


// Правки предпросмотра: blockKey → "группа‖ключ" → новое значение
export type EditMap = Record<string, Record<string, string>>;

// Применяет правки к разобранному результату (перед планом и перед записью),
// чтобы инженер мог исправить кривой OCR/парсинг до попадания в БД.
export function applyEdits(result: EquipParseResult, edits: EditMap | undefined): EquipParseResult {
  if (!edits || Object.keys(edits).length === 0) return result;
  const patchGroups = (groups: SpecGroup[], key: string) => {
    const e = edits[key];
    if (!e) return groups;
    return groups.map(g => ({
      ...g,
      params: g.params.map(p => {
        const nv = e[`${g.title}‖${p.key}`];
        return nv !== undefined ? { ...p, value: nv } : p;
      }),
    }));
  };
  return {
    units: result.units.map(u => ({
      ...u,
      groups: patchGroups(u.groups, blockKey(u.name, '', '__unit__')),
      monoblocks: u.monoblocks.map(mb => ({
        ...mb,
        blocks: mb.blocks.map(b => ({ ...b, groups: patchGroups(b.groups, blockKey(u.name, mb.name, b.name)) })),
      })),
    })),
  };
}

// Список blockKey → нужно ли импортировать (для выбора области)
export type Selection = Set<string> | null; // null = всё

export function isSelected(sel: Selection, key: string): boolean {
  return sel === null || sel.has(key);
}

// ── Построение плана ──
export async function planEquipmentImport(
  prisma: any,
  projectId: string,
  category: string,
  result: EquipParseResult,
): Promise<ImportPlan> {
  const plan: ImportPlan = {
    systems: [],
    blocks: [],
    tagLinks: [],
    ...(result.unknownKinds?.length ? { unknownKinds: result.unknownKinds } : {}),
    totals: { systems: 0, newBlocks: 0, updatedBlocks: 0, unchangedBlocks: 0, conflicts: 0, warnings: 0, overrides: 0, tagsNew: 0, tagsLinked: 0, tagsInvalid: 0 },
  };

  // Существующие системы этого проекта+категории — для сопоставления по коду
  const existingSystems = await prisma.equipmentSystem.findMany({ where: { projectId, category } });
  // Позиции с тегами — их разбирает planTagLinks после обхода дерева
  const tagged: { key: string; tags?: string[] }[] = [];

  for (const unitData of result.units) {
    plan.totals.systems++;
    // Точное имя, затем то же без опечаток раскладки (у1==У1==y1==У-1)
    const found = matchSystem(existingSystems as any[], unitData.name);
    const system: any = found.system;
    const matchedName = found.how === 'similar' ? system.name : undefined;
    plan.systems.push({
      name: unitData.name,
      title: unitData.title,
      action: system ? 'match' : 'create',
      matchedName,
      ...(unitData.nameFix ? { nameFix: unitData.nameFix } : {}),
    });

    // Плоский список блоков установки (как в importEquipmentToDB)
    const flatBlocks: {
      code: string; mbName: string; title: string; equipType: string; groups: SpecGroup[]; tags?: string[];
      role?: string; parent?: string; instanceNo?: number; instanceCount?: number; sourceOrder?: number;
      tagNotes?: TagEvidence[]; sourceKind?: string;
    }[] = [
      { code: '__unit__', mbName: '', title: unitData.title, equipType: 'УСТАНОВКА', groups: unitData.groups, tags: unitData.tags, role: 'УСТАНОВКА' },
      ...unitData.monoblocks.flatMap(mb =>
        mb.blocks.map(b => ({
          code: b.name, mbName: mb.name, title: b.title, equipType: b.equipType, groups: b.groups, tags: b.tags,
          role: b.role, parent: b.parentName, instanceNo: b.instanceNo, instanceCount: b.instanceCount,
          sourceOrder: b.sourceOrder, tagNotes: b.tagNotes, sourceKind: b.sourceKind,
        }))),
    ];

    for (const blk of flatBlocks) {
      if (blk.code === '__unit__' && (!blk.groups || blk.groups.length === 0)) continue;

      // Существующий элемент: моноблок по имени (или служебный __unit__), затем itemCode
      let component: any = null;
      if (system) {
        const mbName = blk.mbName || '__unit__';
        const mb = await prisma.monoblock.findFirst({ where: { systemId: system.id, name: mbName } });
        if (mb) {
          component = await prisma.componentElement.findFirst({
            where: { monoblockId: mb.id, itemCode: blk.code },
          });
        }
      }

      const oldParsed = component?.specs ? safeParse(component.specs) : { groups: [] };
      const oldMap = flattenGroups(oldParsed.groups || []);
      const overrides = component?.overrides ? (safeParse(component.overrides) || {}) : {};

      const params: PlanParam[] = [];
      let changedCount = 0, newCount = 0, overrideImpact = 0;
      for (const g of blk.groups || []) {
        for (const p of g.params || []) {
          const mk = `${g.title}||${p.key}`;
          const old = oldMap[mk];
          let status: PlanParam['status'] = 'new';
          if (old) status = String(old.value) === String(p.value) ? 'same' : 'changed';
          if (status === 'new') newCount++;
          if (status === 'changed') {
            changedCount++;
            // Ручная правка инженера на этот параметр будет перекрыта
            if (overrides[overrideKey(g.title, p.key)] !== undefined) overrideImpact++;
          }
          const warning = validateParam(blk.equipType, p.key, p.value);
          if (warning) plan.totals.warnings++;
          params.push({
            group: g.title, key: p.key, value: String(p.value ?? ''), unit: String(p.unit ?? ''),
            status, oldValue: old?.value, warning,
          });
        }
      }

      const action: PlanBlock['action'] = !component ? 'create' : (changedCount + newCount > 0 ? 'update' : 'unchanged');
      if (action === 'create') plan.totals.newBlocks++;
      else if (action === 'update') plan.totals.updatedBlocks++;
      else plan.totals.unchangedBlocks++;
      plan.totals.conflicts += changedCount;
      plan.totals.overrides += overrideImpact;

      tagged.push({ key: blockKey(unitData.name, blk.mbName, blk.code), tags: blk.tags });
      plan.blocks.push({
        key: blockKey(unitData.name, blk.mbName, blk.code),
        systemName: unitData.name,
        monoblockName: blk.mbName,
        itemCode: blk.code,
        title: blk.title,
        equipType: blk.equipType,
        action, params, changedCount, newCount, overrideImpact,
        ...(blk.role ? { role: blk.role } : {}),
        ...(blk.parent ? { parentKey: blockKey(unitData.name, blk.mbName, blk.parent) } : {}),
        ...(blk.instanceNo ? { instanceNo: blk.instanceNo, instanceCount: blk.instanceCount } : {}),
        ...(blk.sourceOrder !== undefined ? { sourceOrder: blk.sourceOrder } : {}),
        ...(blk.tagNotes?.length ? { tagNotes: blk.tagNotes } : {}),
        ...(blk.sourceKind ? { sourceKind: blk.sourceKind } : {}),
      });
    }
  }

  // Теги бланка: что с каждым делать. Занятость («один тег — одно изделие»)
  // видна сразу, чтобы предпросмотр не обещал того, чего не сделает.
  if (tagged.some(t => (t.tags || []).length)) {
    const rows = await prisma.tag.findMany({
      where: { projectId },
      select: { id: true, identifier: true, componentElements: { select: { id: true } } },
    });
    const existingTags: ExistingTag[] = rows.map((r: any) => ({
      id: r.id, identifier: r.identifier,
      componentIds: (r.componentElements || []).map((c: any) => c.id),
    }));
    // Правила проекта (алфавит, приставки) читаются здесь же: предпросмотр
    // обязан показывать то, что случится на записи, а не более мягкую картину
    const policy = await importPolicyOfProject(projectId);
    plan.tagLinks = planTagLinks(tagged, existingTags, policy);
    plan.totals.tagsNew = plan.tagLinks.filter(l => l.action === 'create').length;
    plan.totals.tagsLinked = plan.tagLinks.filter(l => l.action === 'link').length;
    plan.totals.tagsInvalid = plan.tagLinks.filter(l => l.action === 'invalid').length;
  }

  return plan;
}

function safeParse(s: string): any {
  try { return JSON.parse(s); } catch { return { groups: [] }; }
}

// Фильтрует разобранный результат по выбранной области (blockKey).
// null = импортировать всё. Пустые установки после фильтра отбрасываются.
export function filterBySelection(result: EquipParseResult, sel: Selection): EquipParseResult {
  if (sel === null) return result;
  const units = result.units.map(u => {
    const unitGroupsKept = isSelected(sel, blockKey(u.name, '', '__unit__'));
    const monoblocks = u.monoblocks.map(mb => {
      const kept = new Set<string>();
      const blocks = mb.blocks.filter(b => {
        /**
         * Подпозиция уезжает, только если выбрана она сама И уехал её владелец.
         *
         * Владелец без подпозиции — законный выбор («двигатель уже заведён,
         * не трогайте его»). Подпозиция без владельца — нет: родителя тега
         * взять неоткуда, и в дереве она повисла бы на установке.
         *
         * Раньше здесь в «уехавших» числились только блоки, и привод внутри
         * клапана (владелец — клапан, а не блок) отбрасывался всегда, стоило
         * предпросмотру прислать выбор. Двигатель внутри вентилятора — так же.
         * Владелец в списке всегда раньше своих подпозиций, поэтому одного
         * прохода хватает на любую глубину.
         */
        const own = isSelected(sel, blockKey(u.name, mb.name, b.name));
        const ok = own && (!b.parentName || kept.has(b.parentName));
        if (ok) kept.add(b.name);
        return ok;
      });
      return { ...mb, blocks };
    }).filter(mb => mb.blocks.length > 0);
    return { ...u, groups: unitGroupsKept ? u.groups : [], monoblocks };
  }).filter(u => u.monoblocks.length > 0 || u.groups.length > 0);
  return { units };
}
