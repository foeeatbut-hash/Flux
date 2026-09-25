/**
 * Прежние замечания Просмотра → в сам PDF (Flux Office).
 *
 * Старый Просмотр хранил пометки в базе (PdfMarkup), рядом с файлом. Новый
 * редактор PDF пишет пометки в сам файл — их видит любой просмотрщик. Чтобы
 * прежние замечания не пропали из виду, окно PDF предлагает перенести их:
 *
 *   - список — только текущей ревизии чертежа и ещё не перенесённые;
 *   - доли страницы в точки PDF пересчитывает окно (у него pdf.js и повороты
 *     страниц), сервер проверяет фигуры и пишет их родным кодом редактора
 *     (officeHostApps.transformWithHost → pdf:save);
 *   - запись — общим ядром officeFiles: право, держатель, сверка хеша, откат;
 *   - строки PdfMarkup не удаляются: отметка PdfMarkupTransfer только говорит
 *     «второй раз не переносить».
 */
import type { Express, Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { getPrisma, sendError } from '../context.js';
import { ensureTables } from '../ddl.js';
import { fileBytes } from './fileChunks.js';
import { writeOfficeFile } from './officeFiles.js';
import { transformWithHost } from '../officeHostApps.js';

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
const pt = (v: unknown) => Array.isArray(v) && v.length === 2 && v.every(num);
const box = (v: unknown) => Array.isArray(v) && v.length === 4 && v.every(num);
const rgb = (v: unknown) => Array.isArray(v) && v.length === 3 && v.every((x) => num(x) && x >= 0 && x <= 1);

/** Фигура редактора: только те виды, в которые переводятся прежние замечания */
export function cleanDrawing(d: any): object | null {
  if (!d || typeof d !== 'object' || !Number.isInteger(d.pageIndex) || d.pageIndex < 0 || d.pageIndex > 10_000 || !rgb(d.color)) return null;
  const width = num(d.width) ? Math.min(12, Math.max(0.5, d.width)) : 1.5;
  if (d.kind === 'rect' && box(d.rect)) return { kind: 'rect', pageIndex: d.pageIndex, color: d.color, width, rect: d.rect };
  if (d.kind === 'arrow' && pt(d.from) && pt(d.to)) return { kind: 'arrow', pageIndex: d.pageIndex, color: d.color, width, from: d.from, to: d.to };
  if (d.kind === 'note' && pt(d.at) && typeof d.contents === 'string' && d.contents.trim()) {
    return {
      kind: 'note', pageIndex: d.pageIndex, color: d.color, at: d.at, contents: d.contents.slice(0, 4000),
      ...(typeof d.author === 'string' ? { author: d.author.slice(0, 120) } : {}),
      ...(num(d.createdMs) ? { createdMs: d.createdMs } : {}),
    };
  }
  return null;
}

async function transferTable(): Promise<void> {
  await ensureTables(getPrisma(), [{
    table: 'PdfMarkupTransfer',
    cols: [
      { name: 'markupId', kind: 'text', pk: true },
      { name: 'fileId', kind: 'text', notNull: true, def: '', indexed: true },
      { name: 'sha256', kind: 'text', notNull: true, def: '' },
      { name: 'transferredById', kind: 'text' },
      { name: 'transferredAt', kind: 'time', notNull: true, def: 'now' },
    ],
  }]);
}

/** Уже перенесённые замечания файла; таблицы ещё нет — создать */
async function transferredIds(fileId: string): Promise<Set<string>> {
  const prisma = getPrisma() as any;
  try {
    return new Set((await prisma.pdfMarkupTransfer.findMany({ where: { fileId }, select: { markupId: true } })).map((r: any) => r.markupId));
  } catch (_) {
    await transferTable();
    return new Set((await prisma.pdfMarkupTransfer.findMany({ where: { fileId }, select: { markupId: true } })).map((r: any) => r.markupId));
  }
}

/** Замечания, которые можно перенести: текущей ревизии, не удалённые, не перенесённые */
async function legacyOf(fileId: string) {
  const prisma = getPrisma();
  const file = await prisma.fileNode.findUnique({ where: { id: fileId } });
  if (!file) return null;
  const rows = await prisma.pdfMarkup.findMany({
    where: { fileId, deletedAt: null, revision: file.revision || '1' },
    include: { createdBy: { select: { id: true, name: true } } },
    orderBy: { createdAt: 'asc' },
  });
  const done = await transferredIds(fileId);
  return { file, markups: rows.filter((m: any) => !done.has(m.id)) };
}

export function registerPdfMarkupTransferRoutes(app: Express, deps: { mayWrite: (req: Request, fileId: string) => Promise<string> }): void {
  app.get('/api/office/files/:id/legacy-markups', async (req: Request, res: Response) => {
    try {
      if (!(req as any).authUser) return res.status(401).json({ error: 'Требуется вход в систему' });
      const got = await legacyOf(String(req.params.id));
      if (!got) return res.status(404).json({ error: 'Файл не найден' });
      res.json({ markups: got.markups });
    } catch (e) { sendError(res, e); }
  });

  app.post('/api/office/files/:id/legacy-markups/transfer', async (req: Request, res: Response) => {
    try {
      const user = (req as any).authUser;
      if (!user) return res.status(401).json({ error: 'Требуется вход в систему' });
      const fileId = String(req.params.id);
      const denied = await deps.mayWrite(req, fileId);
      if (denied) return res.status(403).json({ error: denied });
      const got = await legacyOf(fileId);
      if (!got) return res.status(404).json({ error: 'Файл не найден' });
      const wanted = new Set<string>(Array.isArray(req.body?.ids) ? req.body.ids.map(String) : []);
      const ids = got.markups.map((m: any) => m.id).filter((id: string) => wanted.has(id));
      const drawings = (Array.isArray(req.body?.drawings) ? req.body.drawings : []).slice(0, 5000).map(cleanDrawing).filter(Boolean);
      if (!ids.length || !drawings.length) return res.status(400).json({ error: 'Переносить нечего' });

      const bytes = await fileBytes(got.file);
      const baseSha = String(req.body?.baseSha || '');
      if (baseSha && sha256(bytes) !== baseSha) {
        return res.status(409).json({ error: 'Файл изменили, пока вы его смотрели. Откройте свежую версию и повторите перенос' });
      }
      const next = await transformWithHost('pdf', bytes, got.file.name, 'pdf:save',
        (path) => [{ path, markups: [], drawings, formValues: [], stamps: [] }]);
      const w = await writeOfficeFile({ fileId, body: next, baseSha: sha256(bytes), user });
      if (w.status !== 200) return res.status(w.status).json(w.json);
      const prisma = getPrisma() as any;
      for (const markupId of ids) {
        await prisma.pdfMarkupTransfer.upsert({
          where: { markupId },
          create: { markupId, fileId, sha256: w.json.sha256, transferredById: user.id },
          update: {},
        });
      }
      res.json({ ...w.json, transferred: ids.length });
    } catch (e) { sendError(res, e); }
  });
}
