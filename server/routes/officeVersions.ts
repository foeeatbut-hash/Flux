/**
 * Версии файла Flux Office: посмотреть прежнее содержимое и вернуть его.
 *
 * Откат копится сам: каждая запись через writeOfficeFile кладёт прежнее
 * содержимое в FileVersion. Список версий отдаёт officeFiles.ts; здесь —
 * скачать одну и восстановить.
 *
 * Восстановление — такая же запись, как сохранение: через writeOfficeFile, с
 * правом, сверкой и откатом. Значит, то, что было в файле до восстановления,
 * тоже не пропадает — оно становится новой версией, и передумать можно.
 * Открытый файл не трогается: запись в обход окна спорила бы с тем, что видит
 * человек в редакторе, — сначала файл закрывают.
 */
import type { Express, Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { getPrisma, sendError } from '../context.js';
import { fileBytes } from './fileChunks.js';
import { writeOfficeFile } from './officeFiles.js';

export interface OfficeVersionDeps {
  /** Кто держит файл в редакторе; null — файл закрыт */
  holderOf: (fileId: string) => Promise<{ userId: string; name: string } | null>;
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

export function registerOfficeVersionRoutes(app: Express, deps: OfficeVersionDeps): void {
  const versionOf = async (req: Request) => {
    const prisma = getPrisma() as any;
    const user = (req as any).authUser;
    const file = await prisma.fileNode.findUnique({ where: { id: String(req.params.id) } });
    if (!file || file.deletedAt) return { error: [404, 'Файл не найден'] as const };
    if (file.scope === 'PERSONAL' && file.ownerId && file.ownerId !== user?.id) return { error: [403, 'Это чужой личный файл'] as const };
    const v = await prisma.fileVersion.findFirst({ where: { id: String(req.params.vid), fileId: file.id } });
    if (!v) return { error: [404, 'Версия не найдена: старые версии уходят, когда их больше двадцати'] as const };
    return { file, v };
  };

  app.get('/api/office/files/:id/versions/:vid/raw', async (req: Request, res: Response) => {
    try {
      const r = await versionOf(req);
      if ('error' in r) return res.status(r.error[0]).json({ error: r.error[1] });
      const name = String(r.file.name || 'файл').replace(/(\.[^.]+)?$/, ` (версия ${r.v.version})$1`);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('X-File-Name', encodeURIComponent(name));
      res.end(Buffer.from(r.v.data));
    } catch (err: any) { sendError(res, err); }
  });

  app.post('/api/office/files/:id/versions/:vid/restore', async (req: Request, res: Response) => {
    try {
      const r = await versionOf(req);
      if ('error' in r) return res.status(r.error[0]).json({ error: r.error[1] });
      const holder = await deps.holderOf(r.file.id);
      if (holder) return res.status(423).json({ error: `Файл открыт (${holder.name}). Закройте его в редакторе и восстановите версию.` });
      const w = await writeOfficeFile({
        fileId: r.file.id, body: Buffer.from(r.v.data), baseSha: sha256(await fileBytes(r.file)),
        user: (req as any).authUser || null, server: true,
      });
      res.status(w.status).json({ ...w.json, restored: r.v.version });
    } catch (err: any) { sendError(res, err); }
  });
}
