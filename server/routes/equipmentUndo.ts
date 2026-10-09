import type { Express, Request, Response } from 'express';
import { getPrisma, sendError } from '../context.js';
import { withBump } from '../equipmentVersion.js';
import { emitEntitiesChanged } from '../entityChanged.js';
import { planUndo, batchTime, describePlan, type ElementNow, type HistoryRow } from '../equipmentUndo.js';
import { applyCatalogSourceUndo, isCatalogSourceUndoBatch, planCatalogSourceUndo } from '../equipmentCatalogUndo.js';
import { applyXmlRevisionUndo, isXmlRevisionBatch, planXmlRevisionUndo } from '../equipmentXmlUndo.js';
import { canSeeProject, roleGrantsOf } from './members.js';
import { actorMay } from '../projectAccess.js';
import { isPrivilegedUser } from '../accessPolicy.js';

async function authorizeXmlUndo(req: Request, batchId: string) {
  const actor = (req as any).authUser;
  if (!actor?.id) throw Object.assign(new Error('Требуется вход'), { status: 401 });
  const app = await getPrisma().equipmentXmlApplication.findUnique({ where: { batchId } });
  const source = app ? await getPrisma().equipmentXmlSource.findUnique({ where: { id: app.sourceId } }) : null;
  if (!source) throw Object.assign(new Error('Операция XML-ревизии не найдена'), { status: 404 });
  if (!(await canSeeProject(String(actor.id), source.projectId, isPrivilegedUser(actor)))) throw Object.assign(new Error('Проект недоступен'), { status: 403 });
  if (!(await actorMay(actor, roleGrantsOf, 'equipment.manage'))) throw Object.assign(new Error('Нужно право «Правка характеристик оборудования»'), { status: 403 });
}

async function authorizeCatalogUndo(req: Request, batchId: string) {
  const actor = (req as any).authUser;
  if (!actor?.id) throw Object.assign(new Error('Требуется вход'), { status: 401 });
  if (!(await actorMay(actor, roleGrantsOf, 'equipment.manage'))) throw Object.assign(new Error('Нужно право «Правка характеристик оборудования»'), { status: 403 });
  const prisma = getPrisma();
  const history = await prisma.equipmentHistory.findMany({ where: { batchId }, select: { elementId: true } });
  const ids = [...new Set(history.map((item: any) => String(item.elementId)).filter(Boolean))];
  const elements = ids.length ? await prisma.componentElement.findMany({ where: { id: { in: ids } }, select: { monoblock: { select: { system: { select: { projectId: true } } } } } }) : [];
  const projectIds = [...new Set(elements.map((element: any) => element.monoblock?.system?.projectId).filter(Boolean) as string[])];
  for (const projectId of projectIds) {
    if (!(await canSeeProject(String(actor.id), projectId, isPrivilegedUser(actor)))) throw Object.assign(new Error('Проект недоступен'), { status: 403 });
  }
}

/**
 * Отмена импорта расчёта: сначала план, потом применение.
 *
 * Двумя шагами, а не одной кнопкой, потому что это массовая запись: человек
 * должен увидеть, сколько элементов вернётся, сколько исчезнет и что откат
 * обойдёт стороной. Прямой записи «по нажатию» в программе быть не должно.
 */

async function loadBatch(batchId: string) {
  const prisma = getPrisma();
  const rows: HistoryRow[] = await prisma.equipmentHistory.findMany({
    where: { batchId },
    orderBy: { changedAt: 'asc' },
  });
  const ids = [...new Set(rows.map(r => r.elementId))];
  const els = await prisma.componentElement.findMany({
    where: { id: { in: ids } },
    include: { monoblock: { include: { system: true } } },
  });
  const map = new Map<string, ElementNow>();
  for (const e of els) {
    map.set(e.id, {
      id: e.id, itemCode: String(e.itemCode || e.name || ''),
      specs: e.specs ?? null, overrides: e.overrides ?? null, version: Number(e.version || 1),
      status: e.status, conflictLog: e.conflictLog ?? null, monoblockId: e.monoblockId,
      systemId: e.monoblock?.system?.id, systemName: e.monoblock?.system?.name,
      projectId: e.monoblock?.system?.projectId,
      where: `${e.monoblock?.system?.name || ''} · ${e.monoblock?.name || ''}`,
    });
  }
  return { rows, map };
}

export function registerEquipmentUndoRoutes(app: Express): void {
  // План отмены — ничего не пишет
  app.get('/api/equipment/import-undo/:batchId', async (req: Request, res: Response) => {
    try {
      const batchId = String(req.params.batchId || '');
      if (isXmlRevisionBatch(batchId)) {
        await authorizeXmlUndo(req, batchId);
        const plan = await planXmlRevisionUndo(batchId);
        return res.json({ ...plan, summary: { restore: plan.action === 'restore' ? 1 : 0, skipped: plan.action === 'skip' ? 1 : 0 }, at: null });
      }
      if (isCatalogSourceUndoBatch(batchId)) await authorizeCatalogUndo(req, batchId);
      const { rows, map } = await loadBatch(batchId);
      if (isCatalogSourceUndoBatch(batchId)) {
        const prisma = getPrisma();
        const bindings = new Map<string, string | null>();
        for (const id of map.keys()) {
          const row = await prisma.appSetting.findFirst({ where: { key: `equipment_catalog_binding:${id}`, userId: null } });
          bindings.set(id, row?.value ?? null);
        }
        const plan = planCatalogSourceUndo(batchId, rows, map, bindings);
        return res.json({ ...plan, summary: { restore: plan.restore.length, skipped: plan.skip.length }, at: null });
      }
      const plan = planUndo(batchId, rows, map);
      res.json({ ...plan, summary: describePlan(plan), at: batchTime(batchId) || null });
    } catch (err: any) { sendError(res, err); }
  });

  // Применение отмены
  app.post('/api/equipment/import-undo', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      const batchId = String(req.body?.batchId || '');
      if (!batchId) return res.status(400).json({ error: 'Нужен batchId' });

      if (isXmlRevisionBatch(batchId)) {
        await authorizeXmlUndo(req, batchId);
        const plan = await planXmlRevisionUndo(batchId);
        const result = await applyXmlRevisionUndo(batchId, plan);
        emitEntitiesChanged('element', result.changedElementIds, req);
        return res.json({ ...result, summary: { restore: plan.action === 'restore' ? 1 : 0, skipped: result.skipped } });
      }

      if (isCatalogSourceUndoBatch(batchId)) await authorizeCatalogUndo(req, batchId);
      const { rows, map } = await loadBatch(batchId);
      if (isCatalogSourceUndoBatch(batchId)) {
        const prisma = getPrisma();
        const bindings = new Map<string, string | null>();
        for (const id of map.keys()) {
          const row = await prisma.appSetting.findFirst({ where: { key: `equipment_catalog_binding:${id}`, userId: null } });
          bindings.set(id, row?.value ?? null);
        }
        const plan = planCatalogSourceUndo(batchId, rows, map, bindings);
        const result = await applyCatalogSourceUndo(batchId, plan, req);
        emitEntitiesChanged('element', result.changedElementIds, req);
        return res.json({ ...result, summary: { restore: plan.restore.length, skipped: result.skipped } });
      }
      const plan = planUndo(batchId, rows, map);
      const life = plan.reinstate.length + plan.reremove.length + plan.unmove.length + plan.retag.length + plan.unrename.length;
      if (!plan.restore.length && !plan.remove.length && !life) {
        return res.json({ restored: 0, removed: 0, skipped: plan.skip.length, summary: describePlan(plan) });
      }

      const changedElementIds = [
        ...plan.restore, ...plan.remove, ...plan.reinstate, ...plan.reremove,
        ...plan.unmove, ...plan.unrename,
      ].map((item) => item.elementId).filter(Boolean);
      const changedTagIds = plan.retag.flatMap((item) => item.tagIds || []);

      const undoBatch = `undo-${batchId}`;
      for (const it of plan.restore) {
        const now = map.get(it.elementId);
        // Возврат тоже попадает в историю: иначе лист изменений показал бы
        // «стало», которого уже нет, и следа отката в программе не осталось бы
        await prisma.equipmentHistory.create({
          data: {
            elementId: it.elementId, version: now?.version || 1,
            oldSpecs: now?.specs ?? null, newSpecs: it.specs ?? null,
            changeType: 'UPDATE', batchId: undoBatch,
          },
        });
        await prisma.componentElement.update({
          where: { id: it.elementId },
          data: {
            // Отмена — тоже изменение: версия растёт, а не откатывается к прежнему
            // числу, иначе «выгрузили v5, сейчас v5» скрыло бы, что содержимое иное
            ...withBump({
              specs: it.specs ?? null,
              hasConflict: false, status: 'OK',
              paramConflicts: null, conflictType: null,
            }),
          },
        });
      }
      // Теги «Переподобрано» — обратно, ДО удаления новых записей: удаление унесло бы связь
      for (const it of plan.retag) {
        const keep: string[] = [];
        for (const tagId of it.tagIds || []) {
          const tag = await prisma.tag.findUnique({ where: { id: tagId }, include: { componentElements: { select: { id: true } } } });
          const on = (tag?.componentElements || []).map((c: any) => c.id);
          // Тег уже у кого-то третьего — не отнимаем
          if (tag && on.every((x: string) => x === it.toId || x === it.elementId)) keep.push(tagId);
        }
        if (!keep.length) continue;
        if (it.toId) await prisma.componentElement.update({ where: { id: it.toId }, data: withBump({ tags: { disconnect: keep.map(id => ({ id })) } }) }).catch(() => {});
        await prisma.componentElement.update({ where: { id: it.elementId }, data: withBump({ tags: { connect: keep.map(id => ({ id })) } }) }).catch(() => {});
      }
      for (const it of plan.unrename) {
        await prisma.equipmentSystem.update({ where: { id: it.systemId! }, data: { name: it.name! } });
      }
      for (const it of plan.unmove) {
        await prisma.componentElement.update({
          where: { id: it.elementId },
          data: withBump({ monoblockId: it.address!.monoblockId, itemCode: it.address!.itemCode, parentElementId: it.address!.parentElementId }),
        });
      }
      for (const it of plan.reinstate) {
        await prisma.componentElement.update({
          where: { id: it.elementId },
          data: withBump({ status: 'OK', conflictLog: null, hasConflict: false, conflictType: null, paramConflicts: null }),
        });
      }
      for (const it of plan.reremove) {
        await prisma.componentElement.update({
          where: { id: it.elementId },
          data: withBump({ status: 'REMOVED', conflictLog: it.conflictLog ?? null }),
        });
      }
      for (const it of plan.remove) {
        await prisma.componentElement.delete({ where: { id: it.elementId } }).catch(() => {});
      }

      // Пустые моноблоки и установки, заведённые этим же импортом, убираем:
      // иначе после отката в разделе остаются пустые строки без содержимого.
      // Всё, что было до импорта, не трогаем — сверяем по времени партии.
      let emptied = 0;
      const since = batchTime(batchId);
      if (since) {
        const monos = await prisma.monoblock.findMany({
          where: { createdAt: { gte: new Date(since) } },
          include: { components: { select: { id: true } } },
        });
        for (const m of monos) {
          if ((m.components || []).length === 0) {
            await prisma.monoblock.delete({ where: { id: m.id } }).catch(() => {});
            emptied++;
          }
        }
        const systems = await prisma.equipmentSystem.findMany({
          where: { createdAt: { gte: new Date(since) } },
          include: { monoblocks: { select: { id: true } } },
        });
        for (const s of systems) {
          if ((s.monoblocks || []).length === 0) {
            await prisma.equipmentSystem.delete({ where: { id: s.id } }).catch(() => {});
            emptied++;
          }
        }
      }

      emitEntitiesChanged('element', changedElementIds, req);
      emitEntitiesChanged('tag', changedTagIds, req);

      res.json({
        restored: plan.restore.length,
        reinstated: plan.reinstate.length,
        unmoved: plan.unmove.length,
        unrenamed: plan.unrename.length,
        retagged: plan.retag.length,
        removed: plan.remove.length,
        skipped: plan.skip.length,
        emptied,
        summary: describePlan(plan),
      });
    } catch (err: any) { sendError(res, err); }
  });
}
