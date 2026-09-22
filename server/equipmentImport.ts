import { EquipParseResult, SpecGroup } from './equipmentParser.js';
import { blockKey } from './specUtils.js';
import { applyTagLinks, type TagLink } from './equipmentTags.js';
import { planTagParents, parentSetByHand, type TaggedPosition } from './equipmentHierarchy.js';
import { policyOfProject } from './routes/tagPolicy.js';

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
  /** Сколько связей «родитель — потомок» построено по составу оборудования */
  tagParents?: number;
  /** Родство, которое человек назначил рукой и которое импорт не тронул */
  tagParentsKept?: string[];
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
  // itemCode внутри моноблока → id: по нему подпозиция находит своего владельца
  const idByItemCode = new Map<string, string>();
  // Состав в терминах blockKey — из него строится родство тегов
  const placed: { unit: string; key: string; parentKey: string; title: string }[] = [];

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
      // Служебный блок параметров установки заводим, только если параметры есть.
      // План импорта считает так же — иначе предпросмотр обещал бы четыре блока,
      // а в базе появлялось пять, и лишний висел бы пустым.
      if (blk.name === '__unit__' && !(blk.groups || []).length) continue;
      const monoblock = blk.__mb ? mbMap[blk.__mb.name] : unitMb;
      const newGroups = blk.groups || [];
      const serialized = JSON.stringify({ groups: newGroups });

      const keyOfBlock = blockKey(unitData.name, blk.__mb ? blk.__mb.name : '', blk.name);
      let component = await prisma.componentElement.findFirst({
        where: { monoblockId: monoblock.id, itemCode: blk.name },
        include: { tags: true },
      });

      // Состав: роль, владелец, номер экземпляра и порядок из файла. Владелец
      // уже записан — разбор отдаёт блок раньше своих подпозиций
      const parentId = blk.parentName ? idByItemCode.get(`${monoblock.id}‖${blk.parentName}`) : undefined;
      const place = {
        role: blk.role || 'БЛОК',
        parentElementId: parentId ?? null,
        sourceKind: blk.sourceKind || null,
        instanceNo: blk.instanceNo ?? null,
        instanceCount: blk.instanceCount ?? null,
        sourceOrder: blk.sourceOrder ?? 0,
        tagNotes: blk.tagNotes?.length ? JSON.stringify(blk.tagNotes) : null,
      };

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
            ...place,
          },
        });
        idByItemCode.set(`${monoblock.id}‖${blk.name}`, created.id);
        placed.push({ unit: unitData.name, key: keyOfBlock, parentKey: blk.parentName ? blockKey(unitData.name, blk.__mb ? blk.__mb.name : '', blk.parentName) : '', title: blk.title || blk.name });
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
      idByItemCode.set(`${monoblock.id}‖${blk.name}`, component.id);
      placed.push({ unit: unitData.name, key: keyOfBlock, parentKey: blk.parentName ? blockKey(unitData.name, blk.__mb ? blk.__mb.name : '', blk.parentName) : '', title: blk.title || blk.name });
      /**
       * Место в составе обновляется всегда, даже когда параметры не менялись.
       *
       * Позиции, заведённые до появления состава, лежат с ролью по умолчанию и
       * без владельца. Не поправь их повторный импорт — двигатель так и остался
       * бы висеть рядом с блоком, а не внутри вентилятора, и родителя тега
       * взять было бы неоткуда. Ручную позицию это не задевает: её в файле нет,
       * и цикл до неё не доходит.
       */
      await prisma.componentElement.update({ where: { id: component.id }, data: place });

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
    const policy = await policyOfProject(projectId);
    const applied = await applyTagLinks(prisma, projectId, tagLinks, componentIdByKey, policy);
    summary.tagsLinked = applied.linked;
    summary.tagsCreated = applied.created;
    summary.tagConflicts = applied.conflicts;

    const built = await linkTagsByComposition(prisma, projectId, result, placed, applied.assigned);
    summary.tagParents = built.made;
    summary.tagParentsKept = built.kept;
  }

  return summary;
}

/**
 * Родство тегов по составу оборудования.
 *
 * «Самый главный тег — это тег установки»: он становится корнем, а дальше
 * родителем каждого тега идёт тег ближайшего тегированного владельца позиции.
 * Двигатель внутри вентилятора получает тег вентилятора, датчик внутри
 * двигателя — тег двигателя, а вентилятор — тег установки.
 *
 * Связь пишется в то же дерево тегов, которое рисует раздел «Теги»: второе
 * дерево разошлось бы с первым на первой же ручной правке.
 */
async function linkTagsByComposition(
  prisma: any,
  projectId: string,
  result: EquipParseResult,
  placed: { unit: string; key: string; parentKey: string; title: string }[],
  assigned: { blockKey: string; tagId: string }[],
): Promise<{ made: number; kept: string[] }> {
  if (!assigned.length) return { made: 0, kept: [] };

  const rows = await prisma.tag.findMany({
    where: { projectId },
    select: { id: true, identifier: true, metadata: true },
  });
  const nodes = rows.map((t: any) => {
    const meta = safeMeta(t.metadata);
    return { id: t.id, connections: Array.isArray(meta.connections) ? meta.connections : [], parentId: meta.parentId ?? null };
  });
  const metaById = new Map<string, any>(rows.map((t: any) => [t.id, safeMeta(t.metadata)]));
  const identifierById = new Map<string, string>(rows.map((t: any) => [t.id, t.identifier]));
  const handSet = new Set<string>(rows.filter((t: any) => parentSetByHand(t.metadata)).map((t: any) => t.id));
  const tagByKey = new Map(assigned.map(a => [a.blockKey, a.tagId]));

  let made = 0;
  const kept: string[] = [];
  const allPatches = new Map<string, any>();

  for (const unitData of result.units) {
    /**
     * Тег установки — корень всей цепочки, но его может не быть.
     *
     * Обозначение установки иногда не проходит правило проекта (кириллическая
     * «С» вместо латинской), и тогда тега у неё просто нет. Раньше здесь стояло
     * «нет корня — пропускаем установку целиком», и родство не строилось ВООБЩЕ
     * НИ У КОГО, причём молча: двигатель не вставал под свой вентилятор, хотя
     * оба тега были на месте и к установке отношения не имели.
     *
     * Теперь строится всё, что можно построить: цепочки внутри установки
     * складываются, а про отсутствующий корень говорится словами.
     */
    const unitTagId = tagByKey.get(blockKey(unitData.name, '', '__unit__'))
      || rows.find((t: any) => t.identifier === unitData.name)?.id
      || '';
    if (!unitTagId) {
      kept.push(`У установки «${unitData.name}» нет тега — позиции без тегированного владельца остались без родителя`);
    }

    const positions: TaggedPosition[] = placed
      .filter(p => p.unit === unitData.name)
      .map(p => ({ key: p.key, parentKey: p.parentKey, title: p.title, tagId: tagByKey.get(p.key) }));

    const plan = planTagParents(positions, unitTagId, nodes, handSet);
    for (const p of plan.patches) {
      allPatches.set(p.id, p);
      // Следующая установка должна видеть уже построенное: иначе два расчёта
      // в одном файле разложат один и тот же тег по-разному
      const at = nodes.find((n: any) => n.id === p.id);
      if (at) { at.connections = p.connections; at.parentId = p.parentId ?? null; }
      else nodes.push({ id: p.id, connections: p.connections, parentId: p.parentId ?? null });
    }
    for (const d of plan.decisions) {
      if (d.applied) made++;
      else if (handSet.has(d.childTagId)) {
        kept.push(`«${identifierById.get(d.childTagId) || d.childTagId}»: ${d.why}`);
      }
    }
  }

  for (const patch of allPatches.values()) {
    const meta = { ...(metaById.get(patch.id) || {}) };
    meta.connections = patch.connections;
    if (patch.parentId) meta.parentId = patch.parentId; else delete meta.parentId;
    // Отметка «поставил импорт»: по ней следующий ввоз отличит свою связь от
    // руки инженера и не перебьёт чужое решение
    if (meta.parentBy !== 'hand') meta.parentBy = 'import';
    await prisma.tag.update({ where: { id: patch.id }, data: { metadata: JSON.stringify(meta) } });
  }

  return { made, kept };
}

function safeMeta(raw: unknown): any {
  if (raw && typeof raw === 'object') return raw as any;
  try { const v = JSON.parse(String(raw || '{}')); return v && typeof v === 'object' ? v : {}; } catch (_) { return {}; }
}
