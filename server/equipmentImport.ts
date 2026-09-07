import { EquipParseResult, SpecGroup } from './equipmentParser.js';
import { blockKey } from './specUtils.js';
import { applyTagLinks, type TagLink } from './equipmentTags.js';

// Плоская карта параметров: ключ "группа||параметр" -> { value, unit }
export function flattenGroups(groups: SpecGroup[]): Record<string, { value: string; unit: string }> {
  const map: Record<string, { value: string; unit: string }> = {};
  for (const g of groups || []) {
    for (const p of g.params || []) {
      map[`${g.title}||${p.key}`] = { value: String(p.value ?? ''), unit: String(p.unit ?? '') };
    }
  }
  return map;
}

export interface ParamConflict { group: string; key: string; oldValue: string; newValue: string; unit: string; }

function diffSpecs(oldGroups: SpecGroup[], newGroups: SpecGroup[]): ParamConflict[] {
  const oldMap = flattenGroups(oldGroups);
  const newMap = flattenGroups(newGroups);
  const conflicts: ParamConflict[] = [];
  for (const k of Object.keys(newMap)) {
    const [group, key] = k.split('||');
    const ov = oldMap[k];
    if (!ov) {
      conflicts.push({ group, key, oldValue: '', newValue: newMap[k].value, unit: newMap[k].unit });
    } else if (String(ov.value) !== String(newMap[k].value)) {
      conflicts.push({ group, key, oldValue: ov.value, newValue: newMap[k].value, unit: newMap[k].unit });
    }
  }
  return conflicts;
}

export interface ImportSummary {
  conflictsCount: number; newBlocks: number; updatedBlocks: number; systems: number;
  /** Партия импорта — по ней ввоз отменяется целиком (см. importUndo) */
  batchId: string;
  /** Теги: сколько привязано, сколько заведено, что не удалось и почему */
  tagsLinked: number; tagsCreated: number; tagConflicts: string[];
}

/**
 * Записывает разобранный расчёт в БД: установки → моноблоки → блоки.
 * specs хранятся сгруппированно. При повторном импорте сверяет по параметрам.
 * conflictMode='immediate' — сразу применяет новые значения; 'wait' — оставляет
 * старые и помечает конфликты для ручного решения (✓/✏️).
 */
export async function importEquipmentToDB(
  prisma: any,
  projectId: string,
  category: string,
  fileName: string,
  result: EquipParseResult,
  conflictMode: 'immediate' | 'wait',
  tagLinks?: TagLink[],
): Promise<ImportSummary> {
  // Партия: всё, что записал один ввоз расчёта. Без неё «отменить импорт»
  // пришлось бы собирать по времени, а два импорта подряд слились бы в один.
  const batchId = `imp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const summary: ImportSummary = {
    conflictsCount: 0, newBlocks: 0, updatedBlocks: 0, systems: 0, batchId,
    tagsLinked: 0, tagsCreated: 0, tagConflicts: [],
  };
  // Адрес позиции → её элемент в базе: по нему решения инженера о тегах
  // ложатся на те самые блоки, которые он видел в предпросмотре
  const componentIdByKey = new Map<string, string>();

  for (const unitData of result.units) {
    summary.systems++;
    let system = await prisma.equipmentSystem.findFirst({
      where: { projectId, name: unitData.name, category },
    });
    if (!system) {
      system = await prisma.equipmentSystem.create({
        data: { projectId, name: unitData.name, category, fileName },
      });
    }

    // Параметры самой установки храним отдельным служебным блоком "__unit__"
    const unitBlocks = [
      { name: '__unit__', title: unitData.title, equipType: 'УСТАНОВКА', groups: unitData.groups },
      ...unitData.monoblocks.flatMap(mb =>
        mb.blocks.map(b => ({ ...b, __mb: mb }))
      ),
    ];

    // Создаём моноблоки заранее
    const mbMap: Record<string, any> = {};
    for (const mb of unitData.monoblocks) {
      let monoblock = await prisma.monoblock.findFirst({ where: { systemId: system.id, name: mb.name } });
      if (!monoblock) monoblock = await prisma.monoblock.create({ data: { systemId: system.id, name: mb.name } });
      mbMap[mb.name] = monoblock;
    }
    // Служебный моноблок для параметров установки
    let unitMb = await prisma.monoblock.findFirst({ where: { systemId: system.id, name: '__unit__' } });
    if (!unitMb) unitMb = await prisma.monoblock.create({ data: { systemId: system.id, name: '__unit__' } });

    for (const blk of unitBlocks as any[]) {
      const monoblock = blk.__mb ? mbMap[blk.__mb.name] : unitMb;
      const newGroups = blk.groups || [];
      const serialized = JSON.stringify({ groups: newGroups });

      const keyOfBlock = blockKey(unitData.name, blk.__mb ? blk.__mb.name : '', blk.name);
      let component = await prisma.componentElement.findFirst({
        where: { monoblockId: monoblock.id, itemCode: blk.name },
        include: { tags: true },
      });

      if (!component) {
        const created = await prisma.componentElement.create({
          data: {
            monoblockId: monoblock.id,
            itemCode: blk.name,
            name: blk.title || blk.name,
            equipType: blk.equipType || 'ПРОЧЕЕ',
            specs: serialized,
            version: 1,
            status: 'OK',
          },
        });
        // Заведение тоже пишем в историю: без этой записи отмена импорта не
        // знала бы, какие элементы завёл именно он, и оставила бы их навсегда
        await prisma.equipmentHistory.create({
          data: {
            elementId: created.id, version: 1,
            oldSpecs: null, newSpecs: serialized,
            changeType: 'CREATE', batchId,
          },
        });
        componentIdByKey.set(keyOfBlock, created.id);
        summary.newBlocks++;
        continue;
      }

      componentIdByKey.set(keyOfBlock, component.id);
      const oldParsed = component.specs ? JSON.parse(component.specs) : { groups: [] };
      const oldGroups = oldParsed.groups || [];
      const conflicts = diffSpecs(oldGroups, newGroups);

      if (conflicts.length === 0) {
        // Нет изменений — освежим название/тип на всякий случай
        await prisma.componentElement.update({
          where: { id: component.id },
          data: { name: blk.title || component.name, equipType: blk.equipType || component.equipType },
        });
        continue;
      }

      summary.updatedBlocks++;
      summary.conflictsCount += conflicts.length;

      // История версий
      await prisma.equipmentHistory.create({
        data: {
          elementId: component.id,
          version: component.version,
          oldSpecs: component.specs,
          newSpecs: serialized,
          changeType: 'UPDATE',
          batchId,
        },
      });

      if (conflictMode === 'immediate') {
        await prisma.componentElement.update({
          where: { id: component.id },
          data: {
            specs: serialized,
            name: blk.title || component.name,
            equipType: blk.equipType || component.equipType,
            version: component.version + 1,
            hasConflict: false,
            status: 'OK',
            paramConflicts: null,
          },
        });
      } else {
        // 'wait' — оставляем старые значения, помечаем конфликты для решения
        await prisma.componentElement.update({
          where: { id: component.id },
          data: {
            equipType: blk.equipType || component.equipType,
            hasConflict: true,
            status: 'CONFLICT',
            conflictType: 'SPEC_CHANGE',
            paramConflicts: JSON.stringify(conflicts),
          },
        });
      }
    }
  }

  // Теги — последним шагом: элементы уже есть, и решения инженера ложатся
  // ровно на те позиции, которые он видел в предпросмотре
  if (tagLinks && tagLinks.length) {
    const applied = await applyTagLinks(prisma, projectId, tagLinks, componentIdByKey);
    summary.tagsLinked = applied.linked;
    summary.tagsCreated = applied.created;
    summary.tagConflicts = applied.conflicts;
  }

  return summary;
}
