import type { Express, Request, Response } from 'express';
import { getPrisma, sendError, broadcast } from '../context.js';
import { randomUUID } from 'node:crypto';
import { canSeeProject } from './members.js';
import { sourceInfo, catalogModels, bindingKey, catalogRevision } from '../equipmentCatalog.js';

export function registerEquipmentCatalogRoutes(app: Express): void {
  const position = async (req: Request) => {
    const el = await getPrisma().componentElement.findUnique({ where: { id: req.params.id }, include: { monoblock: { include: { system: true } } } });
    if (!el) throw Object.assign(new Error('Позиция не найдена'), { status: 404 });
    const actor = (req as any).authUser;
    if (!(await canSeeProject(actor?.id || '', el.monoblock.system.projectId, actor?.role === 'ADMIN'))) throw Object.assign(new Error('Проект недоступен'), { status: 403 });
    return el;
  };
  app.get('/api/equipment/component/:id/catalog-source', async (req, res) => {
    try { const info = await sourceInfo(await position(req)); res.json(info); }
    catch (err: any) { sendError(res, err, err.status || 500); }
  });
  app.put('/api/equipment/component/:id/catalog-source', async (req, res) => {
    try {
      const el = await position(req); const p = getPrisma(); const mode = req.body?.mode;
      if (!['xml', 'catalog', 'hybrid'].includes(mode)) return res.status(400).json({ error: 'Выберите источник данных' });
      const models = await catalogModels(); const model = models.find(c => c.id === req.body?.modelId);
      if (mode !== 'xml' && !model) return res.status(400).json({ error: 'Выберите точную модель в каталоге' });
      const key = bindingKey(el.id); const before = await p.appSetting.findFirst({ where: { key, userId: null } });
      const old = before ? JSON.parse(before.value) : null;
      if ((req.body?.expectedRevision || '') !== (old?.revision || '')) return res.status(409).json({ error: 'Привязка изменена коллегой. Обновите карточку' });
      const snapshot = old?.modelId === model?.id && !req.body?.refresh ? old?.snapshot || model : model;
      const binding = { mode, modelId: model?.id, code: model?.code, manufacturer: model?.manufacturer, revision: randomUUID(), catalogRevision: snapshot ? catalogRevision(snapshot) : undefined, at: new Date().toISOString(), snapshot };
      await p.$transaction(async (db: any) => {
        if (before) {
          const claim = await db.appSetting.updateMany({ where: { id: before.id, value: before.value }, data: { value: JSON.stringify(binding) } });
          if (claim.count !== 1) throw Object.assign(new Error('Привязка изменена коллегой'), { status: 409 });
        } else await db.appSetting.create({ data: { id: `ecb-${el.id}`, key, userId: null, value: JSON.stringify(binding) } });
        await db.appSetting.create({ data: { key: `equipment_catalog_history:${el.id}:${randomUUID()}`, userId: (req as any).authUser?.id || null, value: JSON.stringify({ before: old, after: binding }) } });
      });
      broadcast('equipment:updated', { projectId: el.monoblock.system.projectId, componentId: el.id });
      res.json({ ok: true, binding });
    } catch (err: any) {
      if (err.code === 'P2002') return res.status(409).json({ error: 'Привязку уже сохранил коллега. Обновите карточку' });
      sendError(res, err, err.status || 500);
    }
  });
}
