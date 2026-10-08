import { EquipParseResult, SpecGroup } from './equipmentParser.js';
import { blockKey } from './specUtils.js';
import { newContext, resolveUnit, unitBlocksOf } from './equipmentResolve.js';
import { BUMP } from './equipmentVersion.js';
import { markRemoved, restoreRemoved, recordMove, transferTags } from './equipmentLifecycle.js';
import { applyTagLinks, type TagLink } from './equipmentTags.js';
import { planTagParents, parentSetByHand, type TaggedPosition } from './equipmentHierarchy.js';
import { importPolicyOfProject } from './routes/tagPolicy.js';
import { notifyExporters } from './e3Impact.js';
import { TAG_SOURCE, recordChangeSets, updateSet, type TagChangeSet } from './tagHistory.js';

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
  /** Сколько уведомлений ушло тем, чьи выгруженные в E3 позиции задел ввоз */
  e3Notified?: number;
  /** Партия импорта — по ней ввоз отменяется целиком (см. importUndo) */
  batchId: string;
  /** Теги: сколько привязано, сколько заведено, что не удалось и почему */
  tagsLinked: number; tagsCreated: number; tagConflicts: string[];
  /** Сколько связей «родитель — потомок» построено по составу оборудования */
  tagParents?: number;
  /** Родство, которое человек назначил рукой и которое импорт не тронул */
  tagParentsKept?: string[];
  /** Позиции, найденные на другом адресе: ID прежний, меняется только адрес */
  movedBlocks?: number;
  /** Прежние записи, снятые «Переподобрано» или «Другое изделие» (`REMOVED`, не удалены) */
  supersededBlocks?: number;
  /** Позиции, которых нет в расчёте: сняты (`REMOVED`), не удалены */
  removedBlocks?: number;
  /** Снятые ранее позиции, вернувшиеся в расчёт: запись и ID те же */
  restoredBlocks?: number;
}

/** Выбор инженера по спорным строкам плана и расчёт целиком, по которому они строились */
export interface IdentityInput {
  /** blockKey / `unit‖имя‖файл` → вариант (см. equipmentIdentity, equipmentSystemMatch) */
  choices?: Record<string, string>;
  /**
   * Расчёт до отбора по галочкам. Сопоставление идёт по нему, а пишется только
   * выбранное: иначе снятая галочка меняла бы, кому достаётся прежняя запись, и
   * запись расходилась бы с предпросмотром.
   */
  full?: EquipParseResult;
  /** Полный файл расчёта: позиции, которых в нём нет, снимаются. У фрагмента — нет */
  removeMissing?: boolean;
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
  /** Кто импортирует: от его имени теги попадают в историю изменений */
  actor: { userId?: string | null } = {},
  identity: IdentityInput = {},
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
  // Позиции, заведённые этим ввозом: их версия 1 остаётся единицей, даже если тег лёг сразу
  const createdIds = new Set<string>();
  // Состав в терминах blockKey — из него строится родство тегов
  const placed: { unit: string; key: string; parentKey: string; title: string }[] = [];

  const existingSystems = await prisma.equipmentSystem.findMany({ where: { projectId, category } });
  const matchOn = identity.full ?? result;
  const ctx = newContext(existingSystems, fileName, matchOn.units, identity.choices || {}, !!identity.removeMissing);
  // Отбор по галочкам сохраняет порядок установок: очередь по имени и файлу
  // отдаёт каждой установке полного расчёта её же (отобранную) версию
  const queue = new Map<string, typeof result.units>();
  if (identity.full) for (const u of result.units) {
    const k = `${u.name}\u2016${u.fileName || ''}`;
    queue.set(k, [...(queue.get(k) || []), u]);
  }
  for (const matchUnit of matchOn.units) {
    // Сопоставление — по полному расчёту; пишется только то, что осталось после отбора
    const unitData = identity.full ? queue.get(`${matchUnit.name}\u2016${matchUnit.fileName || ''}`)?.shift() : matchUnit;
    // Тот же разбор, что у плана (equipmentResolve): предпросмотр обещал «обновим
    // существующую» — значит, обновляем её, даже если в реестре она записана с
    // опечаткой, а позиции находятся по тегу, составу и характеристикам, а не
    // только по адресу
    const resolved = await resolveUnit(prisma, ctx, matchUnit);
    if (!unitData) continue;
    summary.systems++;
    let system: any = resolved.system.system;
    let renamedFrom = '';
    if (system && (resolved.system.how === 'similar' || resolved.system.how === 'renamed') && system.name !== unitData.name) {
      renamedFrom = system.name;
      // В реестре — прежнее написание с опечаткой раскладки, в файле —
      // исправленное, либо установку переименовали и инженер подтвердил, что это
      // она. Установка остаётся той же, меняется только имя
      system = await prisma.equipmentSystem.update({ where: { id: system.id }, data: { name: unitData.name } });
    }
    if (!system) {
      system = await prisma.equipmentSystem.create({
        data: { projectId, name: unitData.name, category, fileName: unitData.fileName || fileName },
      });
      existingSystems.push(system);
      ctx.claimed.add(system.id);
    }

    // Параметры самой установки храним отдельным служебным блоком "__unit__"
    const unitBlocks = unitBlocksOf(unitData);

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

    for (const blk of unitBlocks) {
      // Служебный блок установки заводится всегда, даже без параметров: на него
      // вешаются тег установки и связь с E3. План импорта считает так же —
      // иначе предпросмотр обещал бы четыре блока, а в базе появлялось пять
      const monoblock = blk.mbName ? mbMap[blk.mbName] : unitMb;
      const newGroups = blk.groups || [];
      const serialized = JSON.stringify({ groups: newGroups });

      const keyOfBlock = blockKey(unitData.name, blk.mbName, blk.code);
      const found = resolved.byKey.get(keyOfBlock);
      const component: any = found?.element?.row || null;

      // Состав: роль, владелец, номер экземпляра и порядок из файла. Владелец
      // уже записан — разбор отдаёт блок раньше своих подпозиций
      const parentId = blk.parent ? idByItemCode.get(`${monoblock.id}‖${blk.parent}`) : undefined;
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
            itemCode: blk.code,
            name: blk.title || blk.code,
            equipType: blk.equipType || 'ПРОЧЕЕ',
            specs: serialized,
            version: 1,
            status: 'OK',
            ...place,
          },
        });
        idByItemCode.set(`${monoblock.id}‖${blk.code}`, created.id);
        createdIds.add(created.id);
        placed.push({ unit: unitData.name, key: keyOfBlock, parentKey: blk.parent ? blockKey(unitData.name, blk.mbName, blk.parent) : '', title: blk.title || blk.code });
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
        // «Переподобрано» и «Другое изделие»: прежнюю запись не удаляем, а снимаем
        if (found?.replaces) {
          await markRemoved(prisma, found.replaces, batchId, found.linked ? 'reselected' : 'other',
            { replacedBy: found.linked ? created.id : undefined, releaseTags: found.linked });
          // «Переподобрано»: позиция в схеме та же, поэтому теги идут за ней
          if (found.linked) await transferTags(prisma, { projectId, userId: actor.userId }, found.replaces, { id: created.id, title: blk.title || blk.code }, batchId);
          summary.supersededBlocks = (summary.supersededBlocks || 0) + 1;
        }
        continue;
      }

      componentIdByKey.set(keyOfBlock, component.id);
      idByItemCode.set(`${monoblock.id}‖${blk.code}`, component.id);
      placed.push({ unit: unitData.name, key: keyOfBlock, parentKey: blk.parent ? blockKey(unitData.name, blk.mbName, blk.parent) : '', title: blk.title || blk.code });
      /**
       * Место в составе обновляется всегда, даже когда параметры не менялись.
       *
       * Позиции, заведённые до появления состава, лежат с ролью по умолчанию и
       * без владельца. Не поправь их повторный импорт — двигатель так и остался
       * бы висеть рядом с блоком, а не внутри вентилятора, и родителя тега
       * взять было бы неоткуда. Ручную позицию это не задевает: её в файле нет,
       * и цикл до неё не доходит.
       *
       * Адрес тоже часть места: найденная на другом адресе позиция сохраняет ID,
       * а код и моноблок берёт из файла.
       */
      const moved = component.itemCode !== blk.code || component.monoblockId !== monoblock.id;
      const next: Record<string, any> = moved ? { ...place, itemCode: blk.code, monoblockId: monoblock.id } : { ...place };
      // Версия растёт только от настоящего изменения: повторный ввоз того же
      // расчёта не должен «менять» все позиции
      const data: Record<string, any> = {};
      for (const k of Object.keys(next)) if ((component[k] ?? null) !== (next[k] ?? null)) data[k] = next[k];
      let changed = Object.keys(data).length > 0;
      if (moved) {
        summary.movedBlocks = (summary.movedBlocks || 0) + 1;
        await recordMove(prisma, component, { monoblockId: monoblock.id, itemCode: blk.code, parentElementId: place.parentElementId }, batchId);
      }
      // Пропавшая ранее позиция вернулась: та же запись, статус OK
      if (found?.element?.removed) {
        await restoreRemoved(prisma, component, batchId);
        summary.restoredBlocks = (summary.restoredBlocks || 0) + 1;
      }

      const oldParsed = component.specs ? JSON.parse(component.specs) : { groups: [] };
      const oldGroups = oldParsed.groups || [];
      const conflicts = diffSpecs(oldGroups, newGroups);
      const name = blk.title || component.name;
      const equipType = blk.equipType || component.equipType;
      if (name !== component.name) { data.name = name; changed = true; }
      if (equipType !== component.equipType) { data.equipType = equipType; changed = true; }

      if (conflicts.length > 0) {
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
          Object.assign(data, { specs: serialized, hasConflict: false, status: 'OK', paramConflicts: null });
          changed = true;
        } else {
          // 'wait' — оставляем старые значения, помечаем конфликты для решения
          Object.assign(data, { hasConflict: true, status: 'CONFLICT', conflictType: 'SPEC_CHANGE', paramConflicts: JSON.stringify(conflicts) });
        }
      }
      if (Object.keys(data).length) {
        await prisma.componentElement.update({
          where: { id: component.id },
          data: changed ? { ...data, ...BUMP } : data,
        });
      }
    }

    // Переименование установки (Д4) — в историю партии, иначе отмена ввоза оставила бы новое имя.
    // Строка кладётся на служебную запись установки: у самой установки истории нет
    const unitElementId = componentIdByKey.get(blockKey(unitData.name, '', '__unit__'));
    if (renamedFrom && unitElementId) {
      await prisma.equipmentHistory.create({
        data: {
          elementId: unitElementId, version: 1,
          oldSpecs: JSON.stringify({ systemId: system.id, name: renamedFrom }),
          newSpecs: JSON.stringify({ systemId: system.id, name: unitData.name }),
          changeType: 'SYS_RENAME', batchId,
        },
      });
    }

    // Пропавшие из расчёта: не удаляются, а снимаются; решение инженера «оставить» уважается
    for (const gone of resolved.missing) {
      if (!gone.remove) continue;
      const item = ctx.items.get(system.id)?.find(e => e.id === gone.id);
      if (!item) continue;
      await markRemoved(prisma, item, batchId, 'missing');
      summary.removedBlocks = (summary.removedBlocks || 0) + 1;
    }
  }

  // Теги — последним шагом: элементы уже есть, и решения инженера ложатся
  // ровно на те позиции, которые он видел в предпросмотре
  if (tagLinks && tagLinks.length) {
    const policy = await importPolicyOfProject(projectId);
    const applied = await applyTagLinks(prisma, projectId, tagLinks, componentIdByKey, policy, actor, createdIds);
    summary.tagsLinked = applied.linked;
    summary.tagsCreated = applied.created;
    summary.tagConflicts = applied.conflicts;

    const built = await linkTagsByComposition(prisma, projectId, result, placed, applied.assigned, actor);
    summary.tagParents = built.made;
    summary.tagParentsKept = built.kept;
  }

  // Позиции, стоящие в схеме E3, изменились: тому, кто выгружал, — одно уведомление на ввоз (9.4)
  try { summary.e3Notified = await notifyExporters(prisma, projectId, batchId, actor.userId); }
  catch (e: any) { console.error('[E3] Уведомление о смене выгруженных позиций не отправлено:', e?.message || e); }

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
  actor: { userId?: string | null } = {},
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

  const history: Array<TagChangeSet | null> = [];
  const rowById = new Map<string, any>(rows.map((t: any) => [t.id, t]));
  for (const patch of allPatches.values()) {
    const meta = { ...(metaById.get(patch.id) || {}) };
    meta.connections = patch.connections;
    if (patch.parentId) meta.parentId = patch.parentId; else delete meta.parentId;
    // Отметка «поставил импорт»: по ней следующий ввоз отличит свою связь от
    // руки инженера и не перебьёт чужое решение
    if (meta.parentBy !== 'hand') meta.parentBy = 'import';
    await prisma.tag.update({ where: { id: patch.id }, data: { metadata: JSON.stringify(meta) } });
    const was = rowById.get(patch.id);
    if (was) history.push(updateSet({ id: was.id, projectId, metadata: was.metadata }, { id: was.id, metadata: meta }));
  }
  await recordChangeSets(prisma, { projectId, userId: actor.userId, source: TAG_SOURCE.equipmentImport }, history);

  return { made, kept };
}

function safeMeta(raw: unknown): any {
  if (raw && typeof raw === 'object') return raw as any;
  try { const v = JSON.parse(String(raw || '{}')); return v && typeof v === 'object' ? v : {}; } catch (_) { return {}; }
}
