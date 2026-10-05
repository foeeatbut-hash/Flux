/** Immutable update generations live in the shared database; only the Owner publishes them. */
import { requireOwnerMiddleware } from './accessPolicy.js';
import type { Express, Request, Response } from 'express';
import { CHUNK_MAX, CHUNK_MIN, chunkSizeFor } from './limits.js';
import express from 'express';
import crypto from 'crypto';
import { readUpdateSignature } from '../electron/updateSignature.js';
import { ensureTables as ensureDbTables, getDialect } from './ddl.js';
import { clientDialect, resetSchemaPreparations } from './schemaRuntime.js';
import { registerUpdateCampaignRoutes } from './routes/updateCampaigns.js';

export function pickRelease<T extends { version: string }>(list: T[], ok: (r: T) => { ok: boolean; why: string }) {
  const broken: { version: string; why: string }[] = [];
  for (const r of list) {
    const a = ok(r);
    if (a.ok) return { release: r, broken };
    broken.push({ version: r.version, why: a.why });
  }
  return { release: null, broken };
}

export interface UpdateDeps {
  getPrisma: () => any;
  dataDir: string;
  notifyAll: (category: string, title: string, body: string, route: string, by: string) => Promise<void>;
  broadcast: (event: string, payload: unknown) => void;
  /** Internal dependency for isolated fixtures. HTTP requests never select a verification key. */
  updatePublicKeyHex?: string;
}
const validVersion = (v: unknown): string => typeof v === 'string' && v.length <= 40 && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(v) ? v : '';
const validGeneration = (v: unknown): string => typeof v === 'string' && /^[0-9a-f-]{36}$/.test(v) ? v : '';
const isPublished = (r: any) => r && (r.state === 'published' || !r.state || r.state === 'legacy');

/** Upgrade existing databases before the regenerated Prisma client selects release fields. */
export async function ensureUpdatePublicationSchema(db: any): Promise<void> {
  const why = await ensureDbTables(db, [{ table: 'AppUpdate', existingOnly: true, cols: [
    { name: 'id', kind: 'text', pk: true },
    { name: 'version', kind: 'text', notNull: true, def: '', indexed: true },
    { name: 'generation', kind: 'text', notNull: true, def: '' },
    { name: 'state', kind: 'text', notNull: true, def: 'legacy' },
    { name: 'signature', kind: 'longtext', notNull: true, def: '' },
    { name: 'size', kind: 'int', notNull: true, def: 0 },
    { name: 'sha256', kind: 'text', notNull: true, def: '' },
    { name: 'chunkCount', kind: 'int', notNull: true, def: 0 },
  ], indexes: [{ name: 'AppUpdate_version_key', cols: ['version'], unique: true }] }]);
  if (why) throw new Error(why);
}

export function registerUpdateRoutes(app: Express, deps: UpdateDeps): void {
  registerUpdateCampaignRoutes(app, deps);
  app.use('/api/updates', async (_req, res, next) => {
    try { await ensureUpdatePublicationSchema(deps.getPrisma()); next(); }
    catch (e: any) { res.status(503).json({ error: e?.message || 'Схема обновлений недоступна' }); }
  });
  const signatureManifest = (signature: string) => readUpdateSignature(signature, deps.updatePublicKeyHex);
  // Readiness belongs to the current database client, not to this server process forever.
  let readyClient: any = null;
  const ensureUpdateChunks = async (db: any) => {
    if (readyClient === db) return;
    try { await db.appUpdateChunk.findFirst({ select: { data: true } }); }
    catch (_) {
      const why = await ensureDbTables(db, [{ table: 'AppUpdateChunk', cols: [
        { name: 'id', kind: 'text', pk: true },
        { name: 'version', kind: 'text', notNull: true, def: '', indexed: true },
        { name: 'idx', kind: 'int', notNull: true, def: 0 },
        { name: 'data', kind: 'blob', notNull: true },
      ], indexes: [{ name: 'AppUpdateChunk_version_idx_key', cols: ['version', 'idx'], unique: true }] }], m => console.error('[Обновление]', m));
      if (why) throw new Error(why);
    }
    readyClient = db;
  };
  const packetLimit = async (db: any): Promise<number> => {
    if (clientDialect(db, getDialect()) !== 'mysql') return 0;
    try { const rows = await db.$queryRawUnsafe('SELECT @@max_allowed_packet AS n'); return Number(rows?.[0]?.n || 0); }
    catch (_) { return 0; }
  };
  const releaseSignature = async (db: any, r: any): Promise<string> => r.signature || (await db.appSetting.findFirst({ where: { key: `update.sig.${r.version}`, userId: null } }))?.value || '';
  /** Read every byte before advertising/serving a release. Count alone cannot detect truncated chunks. */
  const verifiedParts = async (db: any, generation: string, expected: { size: number; sha256: string; chunkCount?: number }) => {
    await ensureUpdateChunks(db);
    const parts = await db.appUpdateChunk.findMany({ where: { version: generation }, orderBy: { idx: 'asc' }, select: { idx: true, data: true } });
    if (!parts.length || (expected.chunkCount && parts.length !== expected.chunkCount)) throw new Error('В базе неполный файл обновления. Загрузите новый выпуск.');
    const hash = crypto.createHash('sha256'); let size = 0;
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].idx !== i || !parts[i].data) throw new Error('В базе пропущен кусок обновления.');
      const bytes = Buffer.from(parts[i].data);
      if (!bytes.length) throw new Error('В базе пустой кусок обновления.');
      parts[i].data = bytes; hash.update(bytes); size += bytes.length;
    }
    if (size !== expected.size || hash.digest('hex') !== expected.sha256) throw new Error('Файл в общей базе не совпадает с подписанным выпуском.');
    return parts;
  };
  const availability = async (db: any, r: any) => {
    if (!isPublished(r)) return { ok: false, size: 0, why: 'Выпуск не опубликован или отозван' };
    try {
      const signature = await releaseSignature(db, r), signed = signatureManifest(signature);
      if (!signed || signed.version !== r.version) throw new Error('Подпись выпуска не подтверждена');
      if (r.generation && (r.size !== signed.size || r.sha256 !== signed.sha256)) throw new Error('Описание выпуска не совпадает с подписью');
      await verifiedParts(db, r.generation || r.version, { ...signed, chunkCount: r.chunkCount });
      return { ok: true, size: signed.size, why: '', signature };
    } catch (e: any) { return { ok: false, size: 0, why: String(e?.message || e) }; }
  };

  app.get('/api/updates/latest', async (_req: Request, res: Response) => {
    try {
      const db = deps.getPrisma();
      const list: any[] = await db.appUpdate.findMany({ where: { state: { in: ['published', 'legacy'] } }, orderBy: { createdAt: 'desc' }, take: 10 });
      const states = new Map<string, Awaited<ReturnType<typeof availability>>>();
      for (const r of list) states.set(r.version, await availability(db, r));
      const { release, broken } = pickRelease(list, r => states.get(r.version)!);
      if (!release) return res.json({ version: null, broken });
      // Recheck lifecycle after the potentially long full-file validation.
      const active = await db.appUpdate.findUnique({ where: { version: release.version } });
      if (!isPublished(active) || active.generation !== release.generation) return res.json({ version: null, broken });
      const a = states.get(release.version)!;
      res.json({ version: release.version, generation: release.generation || '', changelog: release.changelog,
        fileUrl: `/api/updates/download/${release.version}`, size: a.size, createdAt: release.createdAt, signature: a.signature, broken });
    } catch (e: any) { res.status(503).json({ error: e?.message || 'Не удалось проверить обновления' }); }
  });
  app.get('/api/updates/check/:version', async (req: Request, res: Response) => {
    const version = validVersion(req.params.version);
    if (!version) return res.status(400).json({ error: 'Укажите номер версии в виде 0.90.0' });
    try {
      const db = deps.getPrisma(), r = await db.appUpdate.findUnique({ where: { version } });
      const a = await availability(db, r);
      const active = await db.appUpdate.findUnique({ where: { version } });
      if (!isPublished(active) || active?.generation !== r?.generation) return res.json({ version, ok: false, size: 0, why: 'Выпуск отозван' });
      res.json({ version, generation: r?.generation || '', ...a });
    } catch (e: any) { res.status(503).json({ error: e?.message || 'База обновлений недоступна' }); }
  });

  app.post('/api/updates/upload', requireOwnerMiddleware, express.raw({ type: () => true, limit: '800mb' }), async (req: Request, res: Response) => {
    const version = validVersion(req.query.version), body = req.body;
    if (!version) return res.status(400).json({ error: 'Укажите номер версии в виде 0.90.0' });
    if (!Buffer.isBuffer(body) || body.length < 5 * 1024 * 1024 || body[0] !== 0x4d || body[1] !== 0x5a) return res.status(400).json({ error: 'Передайте Windows EXE (MZ) размером не менее 5 МБ' });
    const db = deps.getPrisma(), generation = crypto.randomUUID();
    const sha256 = crypto.createHash('sha256').update(body).digest('hex');
    let reserved = false;
    try {
      // Unique version is a database-wide fence across all embedded servers.
      await db.appUpdate.create({ data: { version, generation, state: 'uploading', signature: '', size: body.length, sha256, chunkCount: 0, changelog: '', fileUrl: `/api/updates/download/${version}` } });
      reserved = true;
      await ensureUpdateChunks(db);
      let piece = chunkSizeFor(await packetLimit(db)), lastErr: any, chunkCount = 0;
      for (let attempt = 0; attempt < 6; attempt++) {
        try {
          // Cleanup only this upload's immutable generation; never another version or publisher.
          await db.appUpdateChunk.deleteMany({ where: { version: generation } });
          chunkCount = 0;
          for (let i = 0; i < body.length; i += piece) await db.appUpdateChunk.create({ data: { version: generation, idx: chunkCount++, data: body.subarray(i, Math.min(i + piece, body.length)) } });
          await verifiedParts(db, generation, { size: body.length, sha256, chunkCount });
          lastErr = null; break;
        } catch (e: any) {
          lastErr = e;
          if (/no such column|Unknown column|does not exist|no such table/i.test(String(e?.message || ''))) {
            readyClient = null; resetSchemaPreparations(db); await ensureUpdateChunks(db).catch(() => {});
          }
          if (piece <= CHUNK_MIN) break;
          piece = Math.max(CHUNK_MIN, Math.floor(piece / 2));
        }
      }
      if (lastErr) throw lastErr;
      const changed = await db.appUpdate.updateMany({ where: { version, generation, state: 'uploading' }, data: { state: 'ready', chunkCount } });
      if (changed.count !== 1) throw new Error('Загрузка отозвана во время записи');
      res.json({ success: true, version, generation, size: body.length, sha256, shared: true, chunk: piece });
    } catch (e: any) {
      if (!reserved) return res.status(e?.code === 'P2002' ? 409 : 503).json({ error: e?.code === 'P2002' ? 'Эта версия уже загружается, опубликована или отозвана. Выпустите новую версию.' : 'База обновлений недоступна' });
      // This cleanup cannot delete a published release or a competing upload.
      await db.appUpdate.deleteMany({ where: { version, generation, state: 'uploading' } }).catch(() => {});
      await db.appUpdateChunk.deleteMany({ where: { version: generation } }).catch(() => {});
      res.status(503).json({ success: false, version, shared: false, error: 'Файл не записан полностью в общую базу. Публикация отменена; повторите загрузку.' });
    }
  });

  app.post('/api/updates', requireOwnerMiddleware, async (req: Request, res: Response) => {
    const version = validVersion(req.body?.version), generation = validGeneration(req.body?.generation);
    if (!version) return res.status(400).json({ error: 'Укажите номер версии в виде 0.90.0' });
    if (req.body?.fileUrl) return res.status(400).json({ error: 'Обновление публикуется только через общую базу; внешние ссылки не принимаются' });
    const signature = String(req.body?.signature || '').trim(), signed = signatureManifest(signature);
    if (!signed || signed.version !== version) return res.status(400).json({ error: 'Нужна действительная подпись выпуска владельца программы для этой версии' });
    if (!generation) return res.status(400).json({ error: 'Сначала загрузите файл и передайте номер поколения загрузки' });
    const db = deps.getPrisma();
    try {
      const r = await db.appUpdate.findUnique({ where: { version } });
      if (!r || r.generation !== generation) return res.status(400).json({ error: 'Загрузка этой версии не найдена' });
      if (r.state !== 'ready') return res.status(409).json({ error: 'Выпуск уже опубликован, отозван или ещё загружается' });
      if (r.size !== signed.size || r.sha256 !== signed.sha256) return res.status(400).json({ error: 'Подпись не подходит к файлу в общей базе' });
      try { await verifiedParts(db, generation, { ...signed, chunkCount: r.chunkCount }); }
      catch (e: any) { return res.status(400).json({ error: e.message }); }
      const changelog = String(req.body?.changelog || '').slice(0, 20000);
      // One compare-and-set publishes signature and manifest together. Revocation wins over stale work.
      const changed = await db.appUpdate.updateMany({ where: { version, generation, state: 'ready' }, data: { signature, changelog, state: 'published', createdAt: new Date() } });
      if (changed.count !== 1) return res.status(409).json({ error: 'Выпуск изменился или отозван во время проверки' });
      const update = await db.appUpdate.findUnique({ where: { version } });
      deps.broadcast('app:update-published', { version, changelog });
      // Notification failure does not turn a successful atomic publication into a failed upload.
      await deps.notifyAll('СИСТЕМА', `Вышла версия ${version}`, changelog.split('\n')[0].slice(0, 120), '/updates', String((req as any).authUser.id || '')).catch(e => console.error('[Обновление] Уведомление не доставлено:', e?.message));
      res.json({ success: true, update });
    } catch (e: any) { res.status(503).json({ error: e?.message || 'Не удалось опубликовать релиз' }); }
  });

  app.delete('/api/updates/:version', requireOwnerMiddleware, async (req: Request, res: Response) => {
    const version = validVersion(req.params.version);
    if (!version) return res.status(400).json({ error: 'Укажите номер версии в виде 0.90.0' });
    const db = deps.getPrisma();
    try {
      const r = await db.appUpdate.findUnique({ where: { version } });
      if (r) {
        // Preserve the tombstone: an in-flight publisher cannot resurrect a withdrawn version.
        await db.appUpdate.updateMany({ where: { version, generation: r.generation }, data: { state: 'revoked' } });
        await db.appUpdateChunk.deleteMany({ where: { version: r.generation || version } });
        await db.appSetting.deleteMany({ where: { key: `update.sig.${version}`, userId: null } });
      }
      res.json({ success: true, version });
    } catch (e: any) { res.status(503).json({ error: e?.message || 'Не удалось отозвать релиз' }); }
  });

  app.get('/api/updates/download/:version', async (req: Request, res: Response) => {
    const version = validVersion(req.params.version);
    if (!version) return res.status(404).json({ error: 'Версия не указана' });
    try {
      const db = deps.getPrisma(), r = await db.appUpdate.findUnique({ where: { version } });
      if (!isPublished(r)) return res.status(404).json({ error: 'Выпуск не опубликован или отозван' });
      const signature = await releaseSignature(db, r), signed = signatureManifest(signature);
      if (!signed || signed.version !== version) return res.status(409).json({ error: 'Подпись выпуска не подтверждена' });
      if (r.generation && (r.size !== signed.size || r.sha256 !== signed.sha256)) return res.status(409).json({ error: 'Описание выпуска повреждено' });
      // Hold verified bytes as a snapshot. Never re-read or silently skip chunks after headers are sent.
      const parts = await verifiedParts(db, r.generation || version, { ...signed, chunkCount: r.chunkCount });
      const active = await db.appUpdate.findUnique({ where: { version } });
      if (!isPublished(active) || active.generation !== r.generation || (active.signature && active.signature !== signature)) return res.status(404).json({ error: 'Выпуск отозван во время проверки' });
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="Flux-${version}.exe"`);
      res.setHeader('Content-Length', String(signed.size));
      res.setHeader('X-Flux-Update-Generation', r.generation || '');
      for (const p of parts) {
        if (res.destroyed) return;
        if (!res.write(p.data)) await new Promise<void>((resolve, reject) => {
          const clean = () => { res.off('drain', drained); res.off('close', closed); };
          const drained = () => { clean(); resolve(); }, closed = () => { clean(); reject(new Error('Загрузка прервана')); };
          res.once('drain', drained); res.once('close', closed);
        });
      }
      res.end();
    } catch (e: any) {
      if (res.headersSent) res.destroy(e);
      else res.status(409).json({ error: e?.message || 'Не удалось отдать полный файл обновления' });
    }
  });
}
export { CHUNK_MAX, CHUNK_MIN, chunkSizeFor };
