import type { Express, Request, Response } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { getPrisma, sendError } from '../context.js';
import { broadcast } from '../context.js';
import type { Catalog } from '../../catalog/model.js';
import { planCatalogSpreadsheet, type CatalogImportRow } from '../../catalog/spreadsheet.js';
import { manufacturerKey } from '../../catalog/componentCatalog.js';

interface Deps { ensure: (prisma: any) => Promise<void>; readCatalog: (prisma: any) => Promise<Catalog> }
const actor = (req: Request) => String((req as any).authUser?.id || '');
const json = (v: string) => JSON.parse(v);
const stable = (value: any): any => Array.isArray(value) ? value.map(stable)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])])) : value;
const sameJson = (a: any, b: any) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
const importedManufacturerId = (name: string) => `mf-import-${createHash('sha256').update(manufacturerKey(name), 'utf8').digest('hex').slice(0, 24)}`;
const errorStatus = (err: any) => err?.status || (err?.code === 'P2002' || err?.code === 'P2025' ? 409 : 500);

/** План и партия лежат в базе: отмена переживает закрытие окна и перезапуск. */
export function registerCatalogSpreadsheetRoutes(app: Express, deps: Deps): void {
  app.post('/api/catalog/spreadsheet/plan', async (req: Request, res: Response) => {
    let prisma: any;
    let catalog: Catalog;
    try {
      prisma = getPrisma(); await deps.ensure(prisma);
      catalog = await deps.readCatalog(prisma);
    } catch (err: any) { return sendError(res, err, err?.status || 500); }
    let rows: CatalogImportRow[];
    try {
      rows = planCatalogSpreadsheet(req.body?.sheets, catalog!, {
        classId: String(req.body?.classId || ''), policy: req.body?.policy || 'fill', mapping: req.body?.mapping,
      });
    } catch (err: any) { return sendError(res, err, err?.status || 400); }
    try {
      const id = randomUUID(); const expiresAt = Date.now() + 60 * 60 * 1000;
      await prisma.appSetting.create({ data: { key: `catalog_sheet_plan:${id}`, userId: actor(req), value: JSON.stringify({ rows, expiresAt }) } });
      const counts = Object.fromEntries(['new', 'update', 'same', 'conflict', 'error'].map(action => [action, rows.filter(r => r.action === action).length]));
      res.json({ planId: id, expiresAt, rows: rows.map(({ component, before, ...r }) => r), counts });
    } catch (err: any) { sendError(res, err, errorStatus(err)); }
  });

  app.post('/api/catalog/spreadsheet/apply', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma(); await deps.ensure(prisma);
      const saved = await prisma.appSetting.findFirst({ where: { key: `catalog_sheet_plan:${String(req.body?.planId || '')}`, userId: actor(req) } });
      if (!saved) return res.status(404).json({ error: 'План не найден. Создайте предпросмотр ещё раз' });
      const plan = json(saved.value);
      if (plan.batchId) return res.json({ batchId: plan.batchId, count: plan.count });
      if (plan.expiresAt < Date.now()) return res.status(409).json({ error: 'Предпросмотр устарел. Разберите файл ещё раз' });
      const indices = req.body?.indices;
      if (!Array.isArray(indices) || indices.some((i: any) => !Number.isInteger(i) || i < 0 || i >= plan.rows.length)) return res.status(400).json({ error: 'Выберите строки предпросмотра' });
      const rows: CatalogImportRow[] = [...new Set<number>(indices)].map(i => plan.rows[i]).filter(r => r.component && ['new', 'update'].includes(r.action));
      if (!rows.length) return res.status(400).json({ error: 'Нет выбранных изменений' });
      const batchId = randomUUID();
      const outcome = await prisma.$transaction(async (db: any) => {
        const claim = await db.appSetting.updateMany({ where: { id: saved.id, value: saved.value }, data: { value: JSON.stringify({ ...plan, batchId, count: rows.length }) } });
        if (claim.count !== 1) throw { status: 409, message: 'Эту партию уже записывают. Обновите каталог' };
        const snapshots: { id: string; before: any; after: string; afterRecord: { classId: string; kind: string; code: string } }[] = [];
        const vendorSnapshots: Array<{ id: string; before: any; after: { name: string; dataJson: string } }> = [];
        const manufacturerRows = await db.catalogManufacturer.findMany();
        const manufacturerByKey = new Map<string, any>(manufacturerRows.map((m: any) => [manufacturerKey(m.name), m]));
        for (const r of rows) {
          const c = r.component!;
          const before = await db.catalogComponent.findUnique({ where: { id: c.id } });
          // Сверяем и ожидаемое отсутствие, и исходный снимок. Это ловит
          // коллизию id до create, а также правку модели другим окном.
          const projected = before ? { ...json(before.dataJson), id: before.id, classId: before.classId, kind: before.kind, code: before.code } : null;
          if (!sameJson(projected, r.before || null)) throw { status: 409, message: before && !r.before
            ? `Ключ модели ${c.id} уже занят. Создайте новый предпросмотр`
            : `Модель ${c.code} изменена коллегой. Создайте новый предпросмотр` };
          if (c.manufacturer) {
            const normalized = manufacturerKey(c.manufacturer);
            let vendor = manufacturerByKey.get(normalized);
            if (!vendor) {
              const id = importedManufacturerId(c.manufacturer);
              const idCollision = await db.catalogManufacturer.findUnique({ where: { id } });
              if (idCollision && manufacturerKey(idCollision.name) !== normalized) throw { status: 409, message: `Не удалось безопасно назначить идентификатор изготовителя «${c.manufacturer}»` };
              vendor = idCollision;
              if (!vendor) {
                const data = { id, name: c.manufacturer, shortName: c.manufacturer };
                const dataJson = JSON.stringify(data);
                vendor = await db.catalogManufacturer.create({ data: { id, name: c.manufacturer, dataJson } });
                vendorSnapshots.push({ id, before: null, after: { name: vendor.name, dataJson: vendor.dataJson } });
                await db.catalogRevision.create({ data: { entity: 'manufacturer', entityId: id, action: 'create', snapshotJson: JSON.stringify({ id }), userId: actor(req) } });
              }
              manufacturerByKey.set(normalized, vendor);
            }
            c.manufacturerId = vendor.id;
          }
          const dataJson = JSON.stringify(c);
          const afterRecord = { classId: c.classId, kind: c.kind, code: c.code };
          snapshots.push({ id: c.id, before, after: dataJson, afterRecord });
          const data = { classId: c.classId, kind: c.kind, code: c.code, dataJson };
          if (before) await db.catalogComponent.update({ where: { id: c.id }, data });
          else await db.catalogComponent.create({ data: { id: c.id, ...data } });
          await db.catalogRevision.create({ data: { entity: 'component', entityId: c.id, action: before ? 'update' : 'create', snapshotJson: JSON.stringify(before || { id: c.id }), userId: actor(req) } });
        }
        await db.appSetting.create({ data: { key: `catalog_sheet_batch:${batchId}`, userId: actor(req), value: JSON.stringify({ snapshots, vendorSnapshots, undone: false, at: new Date().toISOString() }) } });
        return { batchId, count: snapshots.length };
      }, { timeout: 60000 });
      broadcast('catalog:changed', { entity: 'component', batchId }); res.json(outcome);
    } catch (err: any) { sendError(res, err, errorStatus(err)); }
  });

  app.post('/api/catalog/spreadsheet/undo', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma(); await deps.ensure(prisma);
      const batch = await prisma.appSetting.findFirst({ where: { key: `catalog_sheet_batch:${String(req.body?.batchId || '')}`, userId: actor(req) } });
      if (!batch) return res.status(404).json({ error: 'Партия не найдена' });
      const state = json(batch.value);
      if (state.undone) return res.json({ ok: true, alreadyUndone: true });
      const retainedManufacturers: string[] = await prisma.$transaction(async (db: any) => {
        const claim = await db.appSetting.updateMany({ where: { id: batch.id, value: batch.value }, data: { value: JSON.stringify({ ...state, undone: true }) } });
        if (claim.count !== 1) throw { status: 409, message: 'Партию уже отменяют' };
        for (const s of state.snapshots) {
          const cur = await db.catalogComponent.findUnique({ where: { id: s.id } });
          if (!cur || cur.dataJson !== s.after || (s.afterRecord && (cur.classId !== s.afterRecord.classId || cur.kind !== s.afterRecord.kind || cur.code !== s.afterRecord.code))) throw { status: 409, message: `Модель ${s.id} изменена после загрузки. Отмена не затронула каталог` };
          await db.catalogRevision.create({ data: { entity: 'component', entityId: s.id, action: 'undo', snapshotJson: JSON.stringify(cur), userId: actor(req) } });
          if (s.before) {
            const { id, createdAt, updatedAt, ...data } = s.before;
            await db.catalogComponent.update({ where: { id: s.id }, data });
          } else await db.catalogComponent.delete({ where: { id: s.id } });
        }
        const kept: string[] = [];
        for (const vendor of state.vendorSnapshots || []) {
          if (vendor.before) continue;
          const current = await db.catalogManufacturer.findUnique({ where: { id: vendor.id } });
          if (!current) continue;
          if (current.name !== vendor.after.name || current.dataJson !== vendor.after.dataJson) { kept.push(current.name); continue; }
          const families = await db.catalogFamily.findMany({ where: { manufacturerId: vendor.id } });
          const components = await db.catalogComponent.findMany();
          const usedByComponent = components.some((component: any) => {
            let data: any = {};
            let malformed = false;
            try { data = json(component.dataJson); } catch { malformed = true; }
            return malformed || data.manufacturerId === vendor.id || manufacturerKey(data.manufacturer) === manufacturerKey(current.name);
          });
          if (families.length || usedByComponent) { kept.push(current.name); continue; }
          await db.catalogRevision.create({ data: { entity: 'manufacturer', entityId: vendor.id, action: 'undo', snapshotJson: JSON.stringify(current), userId: actor(req) } });
          await db.catalogManufacturer.delete({ where: { id: vendor.id } });
        }
        return kept;
      }, { timeout: 60000 });
      broadcast('catalog:changed', { entity: 'component', batchId: req.body.batchId }); res.json({ ok: true, retainedManufacturers });
    } catch (err: any) { sendError(res, err, err?.status || 500); }
  });
}
