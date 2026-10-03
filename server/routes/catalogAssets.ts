/** Исходники доступны другим компьютерам через общую БД; локальные пути не публикуются. */
import type { Express, Request, Response } from 'express';
import { randomUUID, createHash } from 'node:crypto';
import { getPrisma, sendError } from '../context.js';
import { catalogAllowed, catalogFailure, catalogSetting, putCatalogSetting } from '../catalogWorkspace.js';
interface Deps { ensure: (db: any) => Promise<void>; read: (db: any) => Promise<any>; can: (user: any, feature: string) => boolean }
const CHUNK = 256 * 1024; const MAX = 32 * 1024 * 1024;
export function registerCatalogAssetRoutes(app: Express, deps: Deps) {
  const run = (fn: (req: Request, res: Response, db: any, user: any) => Promise<any>) => async (req: Request, res: Response) => {
    try { const user = (req as any).authUser; if (!user?.id) return res.status(401).json({ error: 'Нужно войти' }); const db = getPrisma(); await deps.ensure(db); await fn(req, res, db, user); }
    catch (e: any) { sendError(res, e, e?.status || 500); }
  };
  const metaOf = async (db: any, id: string) => {
    if (!/^[0-9a-f-]{36}$/.test(id)) catalogFailure(400, 'Некорректный идентификатор файла');
    const meta = await catalogSetting(db, `catalog_asset:${id}`, null); if (!meta) catalogFailure(404, 'Вложение не найдено'); return meta;
  };
  const editable = async (db: any, user: any, meta: any) => {
    if (!await catalogAllowed(db, user, 'edit', meta.scope, deps.can) || (meta.authorId !== user.id && !['OWNER', 'ADMIN'].includes(user.role))) catalogFailure(403, 'Нет доступа к загрузке');
  };
  app.post('/api/catalog/assets/begin', run(async (req, res, db, user) => {
    const { size, sha256, filename, familyId } = req.body || {};
    const family = (await deps.read(db)).families.find((f: any) => f.id === familyId) || (await catalogSetting(db, `catalog_draft:family:${familyId}`, null))?.document;
    if (!family || !await catalogAllowed(db, user, 'edit', family, deps.can)) catalogFailure(403, 'Нет права загрузки для модели');
    if (!Number.isInteger(size) || size < 1 || size > MAX || !/^[a-f0-9]{64}$/.test(sha256) || typeof filename !== 'string' || !filename.length || filename.length > 200) catalogFailure(400, 'Некорректные имя, размер или хеш файла');
    // Незавершённые загрузки не занимают квоту навсегда; удаляются только собственные служебные блоки.
    const uploads = await db.appSetting.findMany({ where: { key: { startsWith: 'catalog_asset:' } }, take: 2001 });
    for (const row of uploads) {
      const old = JSON.parse(row.value);
      if (!old.complete && Date.now() - new Date(old.createdAt).getTime() > 72 * 3600000) {
        await db.appSetting.deleteMany({ where: { key: { startsWith: `catalog_asset_chunk:${old.id}:` } } });
        await db.appSetting.deleteMany({ where: { id: row.id, value: row.value } });
      } else if (old.complete && old.sha256 === sha256 && old.size === size && await catalogAllowed(db, user, 'edit', old.scope, deps.can)) return res.json({ id: old.id, complete: true });
      else if (!old.complete && old.authorId === user.id && old.familyId === familyId && old.sha256 === sha256 && old.size === size) return res.json({ id: old.id, chunkBytes: CHUNK, chunks: Math.ceil(size / CHUNK), resumed: true });
    }
    const pending = await db.appSetting.count({ where: { key: { startsWith: 'catalog_asset:' } } });
    if (pending >= 2000) catalogFailure(413, 'Достигнут предел вложений каталога (2000)');
    const id = randomUUID(); await putCatalogSetting(db, `catalog_asset:${id}`, { id, size, sha256, filename: filename.replace(/[\\/\u0000-\u001f]/g, '_'), familyId, scope: { classId: family.classId, manufacturerId: family.manufacturerId }, authorId: user.id, complete: false, createdAt: new Date().toISOString() });
    res.json({ id, chunkBytes: CHUNK, chunks: Math.ceil(size / CHUNK) });
  }));
  app.put('/api/catalog/assets/:id/chunks/:index', run(async (req, res, db, user) => {
    const meta = await metaOf(db, String(req.params.id)); await editable(db, user, meta);
    if (meta.complete) catalogFailure(409, 'Завершённое вложение неизменяемо');
    const index = Number(req.params.index); const expected = Math.min(CHUNK, meta.size - index * CHUNK);
    const base64 = req.body?.data;
    if (!Number.isInteger(index) || index < 0 || expected <= 0 || typeof base64 !== 'string' || base64.length > CHUNK * 2 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) catalogFailure(400, 'Некорректный блок');
    const bytes = Buffer.from(base64, 'base64'); if (bytes.length !== expected || bytes.toString('base64') !== base64) catalogFailure(400, 'Размер блока не совпадает');
    const key = `catalog_asset_chunk:${meta.id}:${index}`;
    const before = await catalogSetting(db, key, null);
    if (before && before !== base64) catalogFailure(409, 'Уже загруженный блок нельзя заменить');
    if (!before) {
      const id = `cat-${createHash('sha256').update(key).digest('hex')}`;
      await db.appSetting.upsert({ where: { id }, create: { id, key, value: JSON.stringify(base64) }, update: {} });
      if (await catalogSetting(db, key, null) !== base64) catalogFailure(409, 'Блок одновременно загружен с другим содержимым');
    }
    res.json({ ok: true });
  }));
  const bytesOf = async (db: any, meta: any): Promise<Buffer> => {
    const chunks = [];
    for (let i = 0; i < Math.ceil(meta.size / CHUNK); i++) { const part = await catalogSetting(db, `catalog_asset_chunk:${meta.id}:${i}`, null); if (!part) catalogFailure(409, `Не загружен блок ${i + 1}`); chunks.push(Buffer.from(part, 'base64')); }
    const bytes = Buffer.concat(chunks); if (bytes.length !== meta.size || createHash('sha256').update(bytes).digest('hex') !== meta.sha256) catalogFailure(409, 'Хеш исходника не совпадает'); return bytes;
  };
  app.post('/api/catalog/assets/:id/finish', run(async (req, res, db, user) => {
    const meta = await metaOf(db, String(req.params.id)); await editable(db, user, meta); const bytes = await bytesOf(db, meta);
    const mime = bytes.subarray(0, 5).toString() === '%PDF-' ? 'application/pdf' : bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png' : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg' : bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP' ? 'image/webp' : '';
    if (!mime) catalogFailure(400, 'Поддерживаются PDF, PNG, JPEG и WebP с корректной сигнатурой');
    if (meta.complete) return res.json({ ok: true, assetId: meta.id });
    await putCatalogSetting(db, `catalog_asset:${meta.id}`, { ...meta, mime, complete: true }); res.json({ ok: true, assetId: meta.id });
  }));
  app.get('/api/catalog/assets/:id', run(async (req, res, db, user) => {
    const meta = await metaOf(db, String(req.params.id)); if (!meta.complete) catalogFailure(409, 'Загрузка не завершена');
    const catalog = await deps.read(db);
    const published = catalog.families.some((f: any) => f.catalog?.assetId === meta.id || f.documents?.some((d: any) => d.assetId === meta.id) || f.tables?.some((t: any) => t.source?.assetId === meta.id));
    let previouslyPublished = false;
    if (!published && !await catalogAllowed(db, user, 'edit', meta.scope, deps.can)) {
      // Старые проекты сохраняют доступ к своему опубликованному исходнику.
      const historical = await db.catalogRevision.findMany({ where: { entity: 'family', action: { in: ['published', 'before-publication'] }, snapshotJson: { contains: meta.id } }, select: { snapshotJson: true }, take: 100 });
      previouslyPublished = historical.some((row: any) => {
        const snapshot = JSON.parse(row.snapshotJson); const doc = JSON.parse(snapshot.dataJson || '{}');
        return doc.catalog?.assetId === meta.id || doc.documents?.some((d: any) => d.assetId === meta.id) || doc.tables?.some((t: any) => t.source?.assetId === meta.id);
      });
      if (!previouslyPublished) catalogFailure(403, 'Исходник ещё не опубликован');
    }
    const bytes = await bytesOf(db, meta); res.setHeader('Content-Type', meta.mime); res.setHeader('Content-Length', bytes.length); res.setHeader('Cache-Control', 'private, max-age=3600'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(meta.filename)}`); res.send(bytes);
  }));
}
