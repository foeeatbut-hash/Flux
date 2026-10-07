/**
 * Один проход «установка файла → установка проекта → позиции» для плана и
 * записи импорта.
 *
 * Предпросмотр обязан обещать то же, что запишется. Поэтому обход установки,
 * поиск её в проекте и сопоставление позиций живут здесь, а план
 * (`equipmentPlan.ts`) и запись (`equipmentImport.ts`) только читают результат:
 * один пишет его в ответ окну, другой — в базу.
 */
import type { SpecGroup, TagEvidence, ParsedUnit } from './equipmentParser.js';
import { blockKey } from './specUtils.js';
import { matchItems, sigOf, type DbItem, type FileItem, type Resolution } from './equipmentIdentity.js';
import { resolveSystem, type SysLite, type SystemResolution } from './equipmentSystemMatch.js';

/** Позиция установки в одном виде для плана и записи: служебный блок первым, затем блоки по моноблокам */
export interface UnitBlock {
  code: string;
  /** '' у параметров самой установки */
  mbName: string;
  title: string;
  equipType: string;
  groups: SpecGroup[];
  tags?: string[];
  role?: string;
  parent?: string;
  instanceNo?: number;
  instanceCount?: number;
  sourceOrder?: number;
  tagNotes?: TagEvidence[];
  sourceKind?: string;
}

/**
 * Служебный блок установки заводится ВСЕГДА, даже без параметров (Д6): на него
 * вешаются тег установки и связь с E3, а без записи установка не имела ID.
 */
export function unitBlocksOf(u: ParsedUnit): UnitBlock[] {
  return [
    { code: '__unit__', mbName: '', title: u.title, equipType: 'УСТАНОВКА', groups: u.groups || [], tags: u.tags, role: 'УСТАНОВКА' },
    ...u.monoblocks.flatMap(mb => mb.blocks.map(b => ({
      code: b.name, mbName: mb.name, title: b.title, equipType: b.equipType, groups: b.groups || [], tags: b.tags,
      role: b.role, parent: b.parentName, instanceNo: b.instanceNo, instanceCount: b.instanceCount,
      sourceOrder: b.sourceOrder, tagNotes: b.tagNotes, sourceKind: b.sourceKind,
    }))),
  ];
}

const addressKey = (mb: string, code: string) => `${mb}‖${code}`;

/** Записи установки с тегами; служебный блок установки лежит в моноблоке `__unit__`, адрес у него пустой */
export async function loadSystemItems(prisma: any, systemId: string): Promise<DbItem[]> {
  const mbs = await prisma.monoblock.findMany({
    where: { systemId },
    include: { components: { include: { tags: true } } },
  });
  const out: DbItem[] = [];
  for (const mb of mbs) for (const c of mb.components || []) {
    out.push({
      id: c.id,
      mb: mb.name === '__unit__' ? '' : mb.name,
      code: c.itemCode,
      title: c.name,
      parentId: c.parentElementId || '',
      order: c.sourceOrder ?? 0,
      instanceNo: c.instanceNo ?? undefined,
      tags: (c.tags || []).map((t: any) => t.identifier),
      sig: sigOf({
        itemCode: c.itemCode, name: c.name, equipType: c.equipType, role: c.role, sourceKind: c.sourceKind,
        specs: c.specs, equipClass: c.equipClass, equipKind: c.equipKind,
      }),
      row: c,
    });
  }
  return out;
}

export interface ResolveContext {
  existing: SysLite[];
  /** Установки, уже занятые установками этого же ввоза */
  claimed: Set<string>;
  fileName: string;
  fileUnitNames: string[];
  choices: Record<string, string>;
  items: Map<string, DbItem[]>;
}

export function newContext(existing: SysLite[], fileName: string, units: ParsedUnit[], choices: Record<string, string> = {}): ResolveContext {
  return { existing, claimed: new Set(), fileName, fileUnitNames: units.map(u => u.name), choices, items: new Map() };
}

export interface ResolvedUnit {
  system: SystemResolution;
  blocks: UnitBlock[];
  /** blockKey → что решено с позицией */
  byKey: Map<string, Resolution>;
}

export async function resolveUnit(prisma: any, ctx: ResolveContext, u: ParsedUnit): Promise<ResolvedUnit> {
  const blocks = unitBlocksOf(u);
  const itemsOf = async (id: string) => {
    if (!ctx.items.has(id)) ctx.items.set(id, await loadSystemItems(prisma, id));
    return ctx.items.get(id)!;
  };
  const fileName = u.fileName || ctx.fileName;
  const addresses = new Set(blocks.filter(b => b.code !== '__unit__').map(b => addressKey(b.mbName, b.code)));
  const system = await resolveSystem({
    existing: ctx.existing, claimed: ctx.claimed, fileUnitNames: ctx.fileUnitNames, choices: ctx.choices,
    unit: { name: u.name, fileName, addresses },
    compositionOf: async id => new Set((await itemsOf(id))
      .filter(e => e.code !== '__unit__' && e.row?.status !== 'REMOVED' && !e.row?.manual)
      .map(e => addressKey(e.mb, e.code))),
  });
  if (system.system) ctx.claimed.add(system.system.id);

  const file: FileItem[] = blocks.map((b, i) => ({
    key: blockKey(u.name, b.mbName, b.code),
    mb: b.mbName, code: b.code, title: b.title || b.code,
    parentKey: b.parent ? blockKey(u.name, b.mbName, b.parent) : '',
    order: b.sourceOrder ?? i,
    instanceNo: b.instanceNo,
    tags: b.tags || [],
    sig: sigOf({
      itemCode: b.code, name: b.title || b.code, equipType: b.equipType, role: b.role, sourceKind: b.sourceKind,
      specs: { groups: b.groups },
    }),
  }));
  const byKey = matchItems(file, system.system ? await itemsOf(system.system.id) : [], ctx.choices);
  return { system, blocks, byKey };
}

/**
 * Решения инженера приходят из запроса, и верить им вслепую нельзя: берутся
 * только строки-пары ограниченной длины. Чужой или лишний ключ ничего не
 * делает — разбор ищет решение по ключам своих строк, остальное не читает.
 */
export function cleanChoices(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>).slice(0, 5000)) {
    if (typeof v === 'string' && k.length <= 600 && v.length <= 200) out[k] = v;
  }
  return out;
}
