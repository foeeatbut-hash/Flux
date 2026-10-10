import { isPrivilegedUser } from '../accessPolicy.js';
import type { Express, Request, Response } from 'express';
import { getPrisma, sendError } from '../context.js';
import { emitEntityChanged } from '../entityChanged.js';
import { randomUUID } from 'node:crypto';
import { canSeeProject, roleGrantsOf } from './members.js';
import { actorMay } from '../projectAccess.js';
import { sourceInfo, equipmentCatalog, bindingKey, catalogRevision, matchesFor, publishedRevision, familyMatchesEquipment, componentMatchesEquipment, validateFamilyValues } from '../equipmentCatalog.js';
import { previewCatalogSource } from '../equipmentCatalog.js';
import { catalogValuesByAddress, snapshotForBinding } from '../../equipment/catalogSpecs.js';
import { withBump } from '../equipmentVersion.js';
import { readCatalog } from './catalog.js';

export function registerEquipmentCatalogRoutes(app: Express): void {
  const position = async (req: Request) => {
    const el = await getPrisma().componentElement.findUnique({ where: { id: req.params.id }, include: { monoblock: { include: { system: true } } } });
    if (!el) throw Object.assign(new Error('Позиция не найдена'), { status: 404 });
    const actor = (req as any).authUser;
    if (!(await canSeeProject(actor?.id || '', el.monoblock.system.projectId, isPrivilegedUser(actor)))) throw Object.assign(new Error('Проект недоступен'), { status: 403 });
    return el;
  };
  app.get('/api/equipment/component/:id/catalog-source', async (req, res) => {
    try { const info = await sourceInfo(await position(req)); res.json(info); }
    catch (err: any) { sendError(res, err, err.status || 500); }
  });
  app.post('/api/equipment/component/:id/catalog-source/preview', async (req, res) => {
    try {
      const el = await position(req);
      const sourceType = req.body?.sourceType === 'family' ? 'family' : 'component';
      const result = await previewCatalogSource(el, String(req.body?.modelId || ''), sourceType, req.body?.values);
      res.json(result);
    } catch (err: any) { sendError(res, err, err.status || 500); }
  });
  app.put('/api/equipment/component/:id/catalog-source', async (req, res) => {
    try {
      const el = await position(req); const actor = (req as any).authUser;
      if (!(await actorMay(actor, roleGrantsOf, 'equipment.manage'))) throw Object.assign(new Error('Нужно право «Правка характеристик оборудования»'), { status: 403 });
      const p = getPrisma(); const mode = req.body?.mode;
      if (!['xml', 'catalog', 'hybrid'].includes(mode)) return res.status(400).json({ error: 'Выберите источник данных' });
      const expectedVersion = Number(req.body?.expectedVersion);
      if (!Number.isInteger(expectedVersion) || expectedVersion !== Number(el.version || 1)) return res.status(409).json({ error: 'Карточка оборудования изменилась. Обновите данные перед применением.' });
      const key = bindingKey(el.id); const before = await p.appSetting.findFirst({ where: { key, userId: null } });
      const old = before ? JSON.parse(before.value) : null;
      if ((req.body?.expectedRevision || '') !== (old?.revision || '')) return res.status(409).json({ error: 'Привязка изменена коллегой. Обновите карточку' });
      const catalog = await equipmentCatalog();
      const sourceType = req.body?.sourceType === 'family' ? 'family' : 'component';
      const model = mode === 'xml' ? undefined : sourceType === 'family'
        ? catalog.families.find(c => c.id === req.body?.modelId)
        : catalog.components.find(c => c.id === req.body?.modelId);
      if (mode !== 'xml' && !model) return res.status(400).json({ error: 'Выберите точную модель в каталоге' });
      if (mode !== 'xml' && model && (sourceType === 'family' ? (model as any).status === 'draft' || !familyMatchesEquipment(el, model as any, catalog) : !componentMatchesEquipment(el, model as any, catalog))) return res.status(400).json({ error: 'Модель не опубликована или не относится к типу этой позиции' });
      const sameSource = old?.modelId === model?.id && (old?.sourceType || 'component') === sourceType;
      // Сохраняем исходную модель: значение «other» из старого DTO не должно менять тип семейства.
      const selected = model;
      const exactCandidate = selected && matchesFor(el, catalog).find(candidate => candidate.id === selected.id && candidate.sourceType === sourceType);
      const values = sourceType === 'family' && model
        ? validateFamilyValues(model as any, req.body?.values ?? (old?.modelId === model.id && sameSource ? old?.values : exactCandidate?.parsedValues ?? {}), exactCandidate?.parsedValues ? [exactCandidate.parsedValues] : [])
        : exactCandidate?.parsedValues || (old?.modelId === model?.id && (old?.sourceType || 'component') === sourceType ? old?.values : undefined);
      const sourceRevision = model ? publishedRevision(catalog.meta?.[model.id]?.updatedAt, catalogRevision(model)) : undefined;
      const expectedPublishedRevision = req.body?.expectedPublishedRevision;
      const publicationChanged = () => Object.assign(new Error('Каталог изменился. Обновите предпросмотр перед применением.'), { status: 409 });
      if (mode !== 'xml' && (typeof expectedPublishedRevision !== 'string' || !expectedPublishedRevision || expectedPublishedRevision !== sourceRevision)) throw publicationChanged();
      const snapshot = sameSource ? snapshotForBinding(old?.snapshot, selected, !!req.body?.refresh) : selected;
      const acceptedCandidate = mode !== 'xml' && model && snapshot
        ? catalogValuesByAddress(el.specs, snapshot, { values, sourceRef: snapshot.catalog }) : {};
      const requestedAccepted = Array.isArray(req.body?.acceptedCatalogParams)
        ? req.body.acceptedCatalogParams.filter((address: unknown): address is string => typeof address === 'string' && address.length <= 240)
        : [];
      const acceptedCatalogParams = mode === 'hybrid' && model
        ? [...new Set([...(sameSource ? old?.acceptedCatalogParams || [] : []), ...requestedAccepted.filter(address => Object.hasOwn(acceptedCandidate, address))])] : [];
      let parsedOverrides: unknown = {};
      try { parsedOverrides = JSON.parse(el.overrides || '{}'); } catch { throw Object.assign(new Error('Ручные значения повреждены; источник не изменён'), { status: 409 }); }
      if (!parsedOverrides || typeof parsedOverrides !== 'object' || Array.isArray(parsedOverrides)) throw Object.assign(new Error('Ручные значения повреждены; источник не изменён'), { status: 409 });
      const overrides = parsedOverrides as Record<string, string>;
      const nextOverrides = { ...overrides };
      const newlyAccepted = mode === 'catalog' ? Object.keys(acceptedCandidate) : requestedAccepted.filter(address => Object.hasOwn(acceptedCandidate, address));
      for (const address of newlyAccepted) delete nextOverrides[address];
      const serializedOverrides = Object.keys(nextOverrides).length ? JSON.stringify(nextOverrides) : null;
      const binding = {
        mode, modelId: model?.id, code: model?.code, manufacturer: sourceType === 'family' ? catalog.manufacturers.find(m => m.id === (model as any).manufacturerId)?.name : (model as any)?.manufacturer,
        sourceType: model ? sourceType : undefined, values: sourceType === 'family' ? values : undefined,
        acceptedCatalogParams,
        revision: randomUUID(), catalogRevision: snapshot ? catalogRevision(snapshot) : undefined,
        sourceRevision: sameSource && !req.body?.refresh ? old?.sourceRevision : sourceRevision,
        at: sameSource && !req.body?.refresh ? old?.at : new Date().toISOString(), snapshot,
      };
      const batchId = `catalog-${Date.now()}-${randomUUID()}`;
      const oldSnapshot = JSON.stringify({ catalogSource: old, overrides: el.overrides ?? null, version: Number(el.version || 1) });
      const newSnapshot = JSON.stringify({ catalogSource: binding, overrides: serializedOverrides, version: Number(el.version || 1) + 1 });
      await p.$transaction(async (db: any) => {
        // Повторная проверка внутри транзакции защищает ручные значения от публикации после предпросмотра.
        if (mode !== 'xml') {
          const currentCatalog = await readCatalog(db);
          const currentModel = sourceType === 'family'
            ? currentCatalog.families.find(c => c.id === model!.id)
            : currentCatalog.components.find(c => c.id === model!.id);
          if (!currentModel || publishedRevision(currentCatalog.meta?.[currentModel.id]?.updatedAt, catalogRevision(currentModel)) !== expectedPublishedRevision
            || (sourceType === 'family' ? (currentModel as any).status === 'draft' || !familyMatchesEquipment(el, currentModel as any, currentCatalog) : !componentMatchesEquipment(el, currentModel as any, currentCatalog))) throw publicationChanged();
        }
        const changed = await db.componentElement.updateMany({
          where: { id: el.id, version: expectedVersion },
          data: withBump({ overrides: serializedOverrides }),
        });
        if (changed.count !== 1) throw Object.assign(new Error('Карточка оборудования изменилась. Обновите данные перед применением.'), { status: 409 });
        if (before) {
          const claim = await db.appSetting.updateMany({ where: { id: before.id, value: before.value }, data: { value: JSON.stringify(binding) } });
          if (claim.count !== 1) throw Object.assign(new Error('Привязка изменена коллегой'), { status: 409 });
        } else await db.appSetting.create({ data: { id: `ecb-${el.id}`, key, userId: null, value: JSON.stringify(binding) } });
        await db.appSetting.create({ data: { key: `equipment_catalog_history:${el.id}:${randomUUID()}`, userId: (req as any).authUser?.id || null, value: JSON.stringify({ before: old, after: binding }) } });
        await db.equipmentHistory.create({ data: { elementId: el.id, version: expectedVersion, oldSpecs: oldSnapshot, newSpecs: newSnapshot, changeType: 'CATALOG_SOURCE', batchId } });
      }, { isolationLevel: 'Serializable' });
      emitEntityChanged('element', el.id, req);
      res.json({ ok: true, binding });
    } catch (err: any) {
      if (err.code === 'P2002') return res.status(409).json({ error: 'Привязку уже сохранил коллега. Обновите карточку' });
      if (err.code === 'P2034') return res.status(409).json({ error: 'Данные изменились во время применения. Обновите предпросмотр.' });
      sendError(res, err, err.status || 500);
    }
  });
}
