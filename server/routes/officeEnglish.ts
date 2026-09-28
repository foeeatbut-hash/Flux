/**
 * «Английская версия…» файла Word и Excel.
 *
 * Ни один документ не уходит заказчику «нажал — получил»: окно сначала
 * показывает сверку «русский → английский» (переводит движок Переводчика с
 * памятью проекта), человек правит строки, и только потом рядом с оригиналом
 * появляется копия «<имя> (EN)». Оригинал не трогается никогда.
 *
 * Связь оригинал ↔ перевод — запись TransLink с mode 'office' (та же таблица,
 * что у Переводчика; sourceDocId/targetDocId — номера файлов). По отпечатку
 * текстов видно, что оригинал правили после перевода. Повторный выпуск пишет
 * в ту же копию — через общее ядро записи, с откатом, — а не плодит «(EN) (2)».
 */
import type { Express, Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { getPrisma, sendError } from '../context.js';
import { fileBytes } from './fileChunks.js';
import { writeOfficeFile } from './officeFiles.js';
import { createFileFromBytes, homeOfFile, exportsHome } from '../officeStore.js';
import { applyFileTranslation, englishName, kindOfName, listFileSegments } from '../translateFile.js';

export interface OfficeEnglishDeps {
  chunkBytes: () => Promise<number>;
  mayWrite: (req: Request, fileId: string) => Promise<string | null>;
  holderOf: (fileId: string) => { userId: string; name: string } | null;
}

const MODE = 'office';
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function readable(req: Request, id: string) {
  const user = (req as any).authUser;
  const file = await getPrisma().fileNode.findUnique({ where: { id } });
  if (!file || file.deletedAt) return { error: [404, 'Файл не найден'] as const };
  if (file.scope === 'PERSONAL' && file.ownerId && file.ownerId !== user?.id) return { error: [403, 'Это чужой личный файл'] as const };
  const kind = kindOfName(file.name || '');
  if (!kind) return { error: [400, 'Английская версия делается для файлов Word (.docx) и Excel (.xlsx)'] as const };
  return { file, kind };
}

/** Связь, где файл — оригинал или перевод, и оба файла живы */
async function linkOf(fileId: string) {
  const prisma = getPrisma() as any;
  const rows = await prisma.transLink.findMany({
    where: { mode: MODE, OR: [{ sourceDocId: fileId }, { targetDocId: fileId }] }, orderBy: { updatedAt: 'desc' },
  });
  for (const r of rows) {
    const [src, dst] = await Promise.all([
      prisma.fileNode.findUnique({ where: { id: r.sourceDocId } }),
      prisma.fileNode.findUnique({ where: { id: r.targetDocId } }),
    ]);
    if (src && dst && !src.deletedAt && !dst.deletedAt) return { row: r, src, dst };
  }
  return null;
}

export function registerOfficeEnglishRoutes(app: Express, deps: OfficeEnglishDeps): void {
  app.get('/api/office/files/:id/english/segments', async (req: Request, res: Response) => {
    try {
      const r = await readable(req, String(req.params.id));
      if ('error' in r) return res.status(r.error[0]).json({ error: r.error[1] });
      const { segments, fingerprint } = await listFileSegments(await fileBytes(r.file), r.kind);
      res.json({ kind: r.kind, segments, fingerprint });
    } catch (err: any) { sendError(res, err); }
  });

  app.get('/api/office/files/:id/english', async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      const l = await linkOf(id);
      if (!l) return res.json({ link: null });
      const kind = kindOfName(l.src.name || '');
      const now = kind ? (await listFileSegments(await fileBytes(l.src), kind)).fingerprint : '';
      res.json({
        link: {
          sourceId: l.src.id, sourceName: l.src.name, targetId: l.dst.id, targetName: l.dst.name,
          isSource: l.src.id === id, stale: !!l.row.fingerprint && now !== l.row.fingerprint,
        },
      });
    } catch (err: any) { sendError(res, err); }
  });

  app.post('/api/office/files/:id/english', async (req: Request, res: Response) => {
    const prisma = getPrisma() as any;
    try {
      const user = (req as any).authUser;
      if (!user?.id) return res.status(401).json({ error: 'Требуется вход в систему' });
      const r = await readable(req, String(req.params.id));
      if ('error' in r) return res.status(r.error[0]).json({ error: r.error[1] });
      const pairs: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.body?.pairs || {})) if (typeof v === 'string') pairs[String(k)] = v;

      const source = await fileBytes(r.file);
      const { fingerprint } = await listFileSegments(source, r.kind);
      // Оригинал поправили, пока шла сверка: ключи кусочков могли съехать
      if (req.body?.fingerprint && req.body.fingerprint !== fingerprint) {
        return res.status(409).json({ error: 'Оригинал изменился, пока шла сверка. Откройте «Английскую версию» заново.' });
      }
      const { bytes, applied } = await applyFileTranslation(source, r.kind, pairs);

      const l = await linkOf(r.file.id);
      if (l && l.src.id === r.file.id) {
        // Повторный выпуск — в ту же копию: её могли уже отправить, ссылка на неё живёт
        const holder = deps.holderOf(l.dst.id);
        if (holder) return res.status(423).json({ error: `Английская версия открыта (${holder.name}). Закройте её и выпустите заново.` });
        const w = await writeOfficeFile({
          fileId: l.dst.id, body: bytes, baseSha: sha256(await fileBytes(l.dst)), user, server: true,
        });
        if (w.status !== 200) return res.status(w.status).json(w.json);
        await prisma.transLink.update({ where: { id: l.row.id }, data: { fingerprint } });
        return res.json({ id: l.dst.id, name: l.dst.name, applied, updated: true });
      }

      const nearby = !(await deps.mayWrite(req, r.file.id));
      const home = (nearby && await homeOfFile(r.file.id)) || await exportsHome(user.id, null);
      const made = await createFileFromBytes({
        name: englishName(r.file.name), body: bytes, home, userId: user.id, chunkBytes: await deps.chunkBytes(), type: r.file.type,
      });
      const folder = r.file.folderId ? await prisma.folder.findUnique({ where: { id: r.file.folderId }, select: { projectId: true } }) : null;
      await prisma.transLink.create({
        data: { projectId: folder?.projectId || '', sourceDocId: r.file.id, targetDocId: made.id, mode: MODE, fingerprint },
      });
      res.json({ id: made.id, name: made.name, applied, updated: false, nearby });
    } catch (err: any) { sendError(res, err); }
  });
}
