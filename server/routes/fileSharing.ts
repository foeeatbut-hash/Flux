import type { Express, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { getPrisma, sendError, broadcast } from '../context.js';
import { ensureSharing, lockShare, qShare as q, shareExec, shareRows, shareOf, shareAllows, shareHash, recordShareEvent, recipientsOf, type ShareAudience, type SharePermission } from '../fileSharing.js';

const MAX_BYTES = 256 * 1024 * 1024;
const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
const actor = (req: Request): string => { const id = (req as any).authUser?.id; if (!id) throw fail(401, 'Требуется вход в систему'); return id; };
const catchError = (res: Response, err: any) => sendError(res, err, err?.status || 500);
const publicShare = (s: any) => ({ fileId: s.fileId, ownerId: s.ownerId, audience: s.audience, permission: s.permission, recipients: recipientsOf(s), epoch: s.epoch, state: s.state });

export function registerFileSharingRoutes(app: Express, deps: { chunkBytes: () => Promise<number> }): void {
  // Источник — непрозрачный хеш устройства и локальной ссылки, пути коллегам не выдаются.
  app.post('/api/file-sharing/publications', async (req, res) => {
    const prisma = getPrisma();
    try {
      const ownerId = actor(req); await ensureSharing(prisma);
      const { sourceKey, sha256, size } = req.body || {};
      const name = String(req.body?.name || '').trim();
      if (!/^[a-f0-9]{64}$/.test(sourceKey) || !/^[a-f0-9]{64}$/.test(sha256) || !Number.isSafeInteger(size) || size < 0 || size > MAX_BYTES || !name || name.length > 500 || /[\\/\x00]/.test(name)) throw fail(400, 'Неверный снимок файла (имя, размер или хеш)');
      const find = () => shareRows(prisma, `SELECT * FROM ${q('FileShare')} WHERE ${q('ownerId')} = ? AND ${q('sourceKey')} = ?`, ownerId, sourceKey);
      let existing = (await find())[0];
      if (!existing) {
        try {
          await prisma.$transaction(async (tx: any) => {
            const file = await tx.fileNode.create({ data: { id: randomUUID(), name, filePath: '/personal/shared-publications/', size, scope: 'PERSONAL', ownerId, createdById: ownerId, updatedById: ownerId, type: 'FILE' } });
            await shareExec(tx, `INSERT INTO ${q('FileShare')} (${['fileId','ownerId','sourceKey','audience','permission','recipients','epoch','state','expectedSha','expectedSize','changedAt'].map(q).join(',')}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, file.id, ownerId, sourceKey, 'NONE', 'EDIT', '[]', 0, 'PENDING', sha256, size, new Date());
          });
        } catch (err) { if (!(await find()).length) throw err; }
        existing = (await find())[0];
      }
      if (existing.state === 'PENDING' && (existing.expectedSha !== sha256 || Number(existing.expectedSize) !== size)) {
        existing = await prisma.$transaction(async (tx: any) => {
          const s = await lockShare(tx, existing.fileId);
          if (!s || s.state !== 'PENDING' || Number(req.body?.epoch) !== Number(s.epoch)) throw fail(409, 'Снимок изменился. Откройте общий доступ заново.');
          const epoch = Number(s.epoch) + 1;
          await tx.fileChunk.deleteMany({ where: { fileId: s.fileId } });
          await tx.fileNode.update({ where: { id: s.fileId }, data: { name, size } });
          await shareExec(tx, `UPDATE ${q('FileShare')} SET ${q('expectedSha')} = ?, ${q('expectedSize')} = ?, ${q('epoch')} = ?, ${q('changedAt')} = ? WHERE ${q('fileId')} = ?`, sha256, size, epoch, new Date(), s.fileId);
          return { ...s, expectedSha: sha256, expectedSize: size, epoch };
        });
      }
      res.json({ ...publicShare(existing), chunkBytes: await deps.chunkBytes() });
    } catch (err) { catchError(res, err); }
  });
  app.put('/api/file-sharing/:id/chunks/:idx', async (req, res) => {
    const prisma = getPrisma();
    try {
      const ownerId = actor(req); await ensureSharing(prisma);
      const fileId = String(req.params.id); const idx = Number(req.params.idx);
      const step = await deps.chunkBytes();
      const b64 = req.body?.base64;
      if (!Number.isSafeInteger(idx) || idx < 0 || typeof b64 !== 'string' || b64.length > Math.ceil(step / 3) * 4 + 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(b64)) throw fail(400, 'Неверная часть файла');
      const data = Buffer.from(b64, 'base64');
      await prisma.$transaction(async (tx: any) => {
        const s = await lockShare(tx, fileId);
        if (!s || s.ownerId !== ownerId) throw fail(404, 'Файл не найден');
        if (s.state !== 'PENDING') throw fail(409, 'Файл уже опубликован. Сохраняйте через редактор со сверкой версии.');
        if (Number(req.body?.epoch) !== Number(s.epoch)) throw fail(409, 'Снимок изменился. Начните загрузку заново.');
        if (idx * step >= Number(s.expectedSize) || data.length !== Math.min(step, Number(s.expectedSize) - idx * step)) throw fail(400, 'Размер части не совпадает со снимком файла');
        await tx.fileChunk.upsert({ where: { fileId_idx: { fileId, idx } }, create: { fileId, idx, data }, update: { data } });
      });
      res.json({ ok: true });
    } catch (err) { catchError(res, err); }
  });
  app.get('/api/file-sharing/source/:sourceKey', async (req, res) => {
    try {
      const prisma = getPrisma(); const ownerId = actor(req); await ensureSharing(prisma);
      const rows = await shareRows(prisma, `SELECT * FROM ${q('FileShare')} WHERE ${q('ownerId')} = ? AND ${q('sourceKey')} = ?`, ownerId, String(req.params.sourceKey));
      res.json(rows[0] ? publicShare(rows[0]) : null);
    } catch (err) { catchError(res, err); }
  });
  app.get('/api/file-sharing/received', async (req, res) => {
    try {
      const prisma = getPrisma(); const userId = actor(req); await ensureSharing(prisma);
      const [shares, hidden] = await Promise.all([
        shareRows(prisma, `SELECT * FROM ${q('FileShare')} WHERE ${q('state')} = ? AND ${q('audience')} <> ?`, 'READY', 'NONE'),
        shareRows(prisma, `SELECT ${q('fileId')} FROM ${q('FileShareHidden')} WHERE ${q('userId')} = ?`, userId),
      ]);
      const excluded = new Set(hidden.map((h) => h.fileId));
      const allowed = shares.filter((s) => shareAllows(s, userId) && !excluded.has(s.fileId));
      const ids = allowed.map((s) => s.fileId);
      const files = ids.length ? await prisma.fileNode.findMany({ where: { id: { in: ids }, deletedAt: null }, select: { id: true, name: true, size: true, updatedAt: true } }) : [];
      const owners = [...new Set(allowed.map((s) => s.ownerId))];
      const users = owners.length ? await prisma.user.findMany({ where: { id: { in: owners } }, select: { id: true, name: true } }) : [];
      const byId = new Map(allowed.map((s) => [s.fileId, s])); const names = new Map(users.map((u: any) => [u.id, u.name]));
      res.json({ files: files.map((file: any) => { const s: any = byId.get(file.id); return { ...file, ownerId: s.ownerId, ownerName: names.get(s.ownerId) || 'Сотрудник', permission: s.ownerId === userId ? 'OWNER' : s.permission, epoch: s.epoch }; }) });
    } catch (err) { catchError(res, err); }
  });
  app.get('/api/file-sharing/:id', async (req, res) => {
    try {
      const userId = actor(req); const s = await shareOf(getPrisma(), String(req.params.id));
      if (!s || s.ownerId !== userId) throw fail(404, 'Файл не найден');
      res.json(publicShare(s));
    } catch (err) { catchError(res, err); }
  });
  // Получатель подтверждает состав и права одной кнопкой; незавершённый снимок никому не виден.
  app.put('/api/file-sharing/:id/access', async (req, res) => {
    const prisma = getPrisma();
    try {
      const ownerId = actor(req); await ensureSharing(prisma); const fileId = String(req.params.id);
      const audience: ShareAudience = req.body?.audience;
      const permission: SharePermission = req.body?.permission || 'EDIT';
      const raw = req.body?.recipients || [];
      if (!['NONE','USERS','ALL'].includes(audience) || !['VIEW','EDIT'].includes(permission) || !Array.isArray(raw) || raw.length > 1000 || raw.some((id) => typeof id !== 'string' || !id || id.length > 191)) throw fail(400, 'Неверный список получателей');
      const recipients = audience === 'USERS' ? [...new Set(raw)].filter((id) => id !== ownerId).sort() : [];
      if (audience === 'USERS' && !recipients.length) throw fail(400, 'Выберите хотя бы одного сотрудника');
      const users = recipients.length ? await prisma.user.findMany({ where: { id: { in: recipients } }, select: { id: true } }) : [];
      if (users.length !== recipients.length) throw fail(400, 'В списке есть отсутствующий сотрудник');
      const updated = await prisma.$transaction(async (tx: any) => {
      const s = await lockShare(tx, fileId);
        if (!s || s.ownerId !== ownerId) throw fail(404, 'Файл не найден');
        if (Number(req.body?.epoch) !== Number(s.epoch)) throw fail(409, 'Настройки доступа изменились. Откройте их заново.');
        if (s.state === 'PENDING') {
          const parts = await tx.fileChunk.findMany({ where: { fileId }, orderBy: { idx: 'asc' }, select: { idx: true, data: true } });
          const bytes = Buffer.concat(parts.map((p: any) => Buffer.from(p.data)));
          if (parts.some((p: any, i: number) => p.idx !== i) || bytes.length !== Number(s.expectedSize) || shareHash(bytes) !== s.expectedSha) throw fail(409, 'Загрузка не завершена или содержимое повреждено. Общий доступ не включён.');
        }
        const epoch = Number(s.epoch) + 1;
        await shareExec(tx, `UPDATE ${q('FileShare')} SET ${q('audience')} = ?, ${q('permission')} = ?, ${q('recipients')} = ?, ${q('epoch')} = ?, ${q('state')} = ?, ${q('changedAt')} = ? WHERE ${q('fileId')} = ?`, audience, permission, JSON.stringify(recipients), epoch, 'READY', new Date(), fileId);
        // Повторная выдача явно возвращает файл тому, кто раньше спрятал его.
        await shareExec(tx, `DELETE FROM ${q('FileShareHidden')} WHERE ${q('fileId')} = ?`, fileId);
        await recordShareEvent(tx, fileId, epoch);
        return { ...s, audience, permission, recipients: JSON.stringify(recipients), epoch, state: 'READY' };
      }, { timeout: 120_000 });
      broadcast('file-sharing:changed', { fileId });
      res.json(publicShare(updated));
    } catch (err) { catchError(res, err); }
  });
  app.post('/api/file-sharing/:id/hide', async (req, res) => {
    try {
      const prisma = getPrisma(); const userId = actor(req); const fileId = String(req.params.id); const s = await shareOf(prisma, fileId);
      if (!s || !shareAllows(s, userId) || s.ownerId === userId) throw fail(404, 'Файл не найден');
      const id = shareHash(Buffer.from(`${userId}\0${fileId}`));
      await prisma.$transaction(async (tx: any) => { await shareExec(tx, `DELETE FROM ${q('FileShareHidden')} WHERE ${q('id')} = ?`, id); await shareExec(tx, `INSERT INTO ${q('FileShareHidden')} (${q('id')},${q('fileId')},${q('userId')}) VALUES (?, ?, ?)`, id, fileId, userId); });
      res.json({ ok: true });
    } catch (err) { catchError(res, err); }
  });
}
