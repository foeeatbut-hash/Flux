import { EquipParseResult, SpecGroup, SpecParam } from './equipmentParser.js';
import { flattenGroups } from './equipmentImport.js';
import { overrideKey } from './specUtils.js';
import { parseRuNumber } from './normalize.js';

// ── Dry-run план импорта (Фаза 2 «Импорт бланков 2.0») ──
// Считает, ЧТО изменится в проекте, НЕ трогая БД: инженер видит дерево
// установок с диффом и предупреждениями до записи. Тот же обход, что и
// importEquipmentToDB, но только чтение.

// Составной ключ блока: система‖моноблок‖код — уникален в пределах файла,
// служит и для выбора области, и для адресации правок предпросмотра.
export function blockKey(systemName: string, mbName: string, code: string): string {
  return `${systemName}‖${mbName}‖${code}`;
}

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
}

export interface PlanSystem {
  name: string; title: string;
  action: 'create' | 'match';  // новая установка или обновление существующей
  matchedName?: string;        // если сопоставлена fuzzy — фактическое имя в БД
}

export interface ImportPlan {
  systems: PlanSystem[];
  blocks: PlanBlock[];
  totals: { systems: number; newBlocks: number; updatedBlocks: number; unchangedBlocks: number; conflicts: number; warnings: number; overrides: number };
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

// Нормализация кода установки для сопоставления: регистр, латиница/кириллица, дефисы
function normCode(s: string): string {
  return String(s || '').toLowerCase().replace(/[\s \-_.]/g, '')
    .replace(/y/g, 'у').replace(/mn/g, 'мн').replace(/bl/g, 'бл');
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
    totals: { systems: 0, newBlocks: 0, updatedBlocks: 0, unchangedBlocks: 0, conflicts: 0, warnings: 0, overrides: 0 },
  };

  // Существующие системы этого проекта+категории — для сопоставления по коду
  const existingSystems = await prisma.equipmentSystem.findMany({ where: { projectId, category } });

  for (const unitData of result.units) {
    plan.totals.systems++;
    // Точное имя, затем нормализованное сопоставление (у1==У1==y1==У-1)
    let system = existingSystems.find((s: any) => s.name === unitData.name);
    let matchedName: string | undefined;
    if (!system) {
      const nc = normCode(unitData.name);
      system = existingSystems.find((s: any) => normCode(s.name) === nc);
      if (system) matchedName = system.name;
    }
    plan.systems.push({
      name: unitData.name,
      title: unitData.title,
      action: system ? 'match' : 'create',
      matchedName,
    });

    // Плоский список блоков установки (как в importEquipmentToDB)
    const flatBlocks: { code: string; mbName: string; title: string; equipType: string; groups: SpecGroup[] }[] = [
      { code: '__unit__', mbName: '', title: unitData.title, equipType: 'УСТАНОВКА', groups: unitData.groups },
      ...unitData.monoblocks.flatMap(mb =>
        mb.blocks.map(b => ({ code: b.name, mbName: mb.name, title: b.title, equipType: b.equipType, groups: b.groups }))),
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

      plan.blocks.push({
        key: blockKey(unitData.name, blk.mbName, blk.code),
        systemName: unitData.name,
        monoblockName: blk.mbName,
        itemCode: blk.code,
        title: blk.title,
        equipType: blk.equipType,
        action, params, changedCount, newCount, overrideImpact,
      });
    }
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
    const monoblocks = u.monoblocks.map(mb => ({
      ...mb,
      blocks: mb.blocks.filter(b => isSelected(sel, blockKey(u.name, mb.name, b.name))),
    })).filter(mb => mb.blocks.length > 0);
    return { ...u, groups: unitGroupsKept ? u.groups : [], monoblocks };
  }).filter(u => u.monoblocks.length > 0 || u.groups.length > 0);
  return { units };
}
