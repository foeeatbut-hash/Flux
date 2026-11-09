/**
 * Вложения чата кусками: до 500 МБ вместо 25.
 *
 * Прежняя загрузка слала файл одной строкой base64 в теле запроса и клала её
 * одной строкой в FileNode.content: предел 25 МБ был не выбором, а потолком
 * того, что проходит в тело запроса (50 МБ) и в пакет базы. Здесь файл едет
 * кусками по размеру, который спрашивается у самой базы, и ложится в
 * FileChunk — так же, как файлы Проводника (server/routes/fileChunks.ts).
 * Память сервера не растёт с размером файла: ни при загрузке, ни при выдаче.
 *
 * Порядок: start (запись файла, размер называется заранее) → chunk × N →
 * done (сервер сверяет число кусков и сумму байт с названным размером).
 * До done запись помечена department='CHAT_UPLOAD': вложением к сообщению её
 * прикрепить нельзя, а уборка сирот стирает недогруженное через сутки.
 *
 * Старые вложения (строка в content) открываются как раньше: куски у них
 * отсутствуют, и выдача берёт содержимое из записи.
 */
import type { Express, Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import path from 'node:path';
import { getPrisma, sendError, AppError } from '../context.js';
import { CHAT_FILE_MAX_BYTES, CHAT_UPLOADING as UPLOADING, uploaderPath } from '../services/chatFiles.js';

/** Сколько кусков читаем за раз при выдаче и подсчёте размера */
const PAGE = 4;
/** Строгий base64: Buffer.from молча принимает мусор */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export interface ChatUploadDeps {
  /** Размер куска под предел пакета этой базы */
  chunkBytes: () => Promise<number>;
}

const actorOf = (req: Request): string => String((req as any).authUser?.id || '');

/** Недогруженный файл этого пользователя; иначе «не найден» — чужие номера не подтверждаем */
async function ownUpload(prisma: any, req: Request, id: string): Promise<any> {
  const node = await prisma.fileNode.findUnique({ where: { id } });
  const mine = !!node && node.type === 'CHAT_FILE' && node.department === UPLOADING && String(node.filePath || '').startsWith(`/chat/${actorOf(req)}/`);
  if (!mine) throw new AppError(404, 'Загрузка не найдена или уже завершена: начните заново');
  return node;
}

export function registerChatUploadRoutes(app: Express, deps: ChatUploadDeps): void {
  app.post('/api/chat/upload/start', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    try {
      const size = Number(req.body?.size);
      let base = path.basename(String(req.body?.fileName || '')).replace(/[\/\\]/g, '').trim();
      if (!base || base === '.' || base === '..') base = `file_${Date.now()}`;
      if (!Number.isInteger(size) || size <= 0) return res.status(400).json({ error: 'Файл пустой или размер не указан' });
      if (size > CHAT_FILE_MAX_BYTES) return res.status(413).json({ error: `Файл больше ${Math.round(CHAT_FILE_MAX_BYTES / 1048576)} МБ: положите его в Проводник и отправьте ссылкой` });
      const node = await prisma.fileNode.create({
        data: { name: base, type: 'CHAT_FILE', filePath: uploaderPath(actorOf(req), base), createdById: actorOf(req) || null, size, content: null, department: UPLOADING },
      });
      res.json({ success: true, id: node.id, chunkBytes: await deps.chunkBytes() });
    } catch (err: any) { sendError(res, err); }
  });

  app.post('/api/chat/upload/:id/chunk', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    try {
      const node = await ownUpload(prisma, req, String(req.params.id));
      const piece = await deps.chunkBytes();
      // Номер ограничен названным размером: лишние куски не растят файл сверх заявленного
      const total = Math.ceil(Number(node.size) / piece);
      const idx = Number(req.body?.idx);
      const data = String(req.body?.data || '');
      if (!Number.isInteger(idx) || idx < 0 || idx >= total) return res.status(400).json({ error: 'Неверный номер куска' });
      if (!data) return res.status(400).json({ error: 'Пустой кусок' });
      if (data.length % 4 !== 0 || !BASE64.test(data)) return res.status(400).json({ error: 'Кусок передан в неверной кодировке' });
      const bytes = Buffer.from(data, 'base64');
      if (bytes.length > piece) return res.status(413).json({ error: 'Кусок больше допустимого: обновите программу' });
      const want = String(req.headers['x-chunk-sha256'] || '').trim().toLowerCase();
      if (want && want !== createHash('sha256').update(bytes).digest('hex')) {
        return res.status(422).json({ error: 'Кусок дошёл повреждённым: контрольная сумма не совпала, отправьте его ещё раз' });
      }
      await prisma.fileChunk.upsert({ where: { fileId_idx: { fileId: node.id, idx } }, create: { fileId: node.id, idx, data: bytes }, update: { data: bytes } });
      res.json({ ok: true, idx, bytes: bytes.length });
    } catch (err: any) { sendError(res, err); }
  });

  app.post('/api/chat/upload/:id/done', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    try {
      const node = await ownUpload(prisma, req, String(req.params.id));
      const count = Number(req.body?.count);
      const present = await prisma.fileChunk.findMany({ where: { fileId: node.id }, select: { idx: true }, orderBy: { idx: 'asc' } });
      // Куски идут подряд 0..N-1 и их ровно столько, сколько назвало окно: файл с дырой не «успех»
      if (!Number.isInteger(count) || present.length !== count || present.some((r: any, i: number) => r.idx !== i)) {
        return res.status(400).json({ error: `Файл загружен не полностью: получено ${present.length} кусков. Отправьте файл ещё раз` });
      }
      let size = 0;
      for (let from = 0; from < present.length; from += PAGE) {
        const rows = await prisma.fileChunk.findMany({ where: { fileId: node.id, idx: { gte: from, lt: from + PAGE } }, select: { data: true } });
        for (const r of rows) size += Buffer.from(r.data).length;
      }
      if (size !== Number(node.size)) {
        return res.status(400).json({ error: `Размер не совпал с названным (${size} из ${node.size} байт). Отправьте файл ещё раз` });
      }
      await prisma.fileNode.update({ where: { id: node.id }, data: { department: 'CHAT' } });
      res.json({ success: true, filePath: `/chat_files/${node.id}/${encodeURIComponent(node.name)}`, fileName: node.name, fileSize: size });
    } catch (err: any) { sendError(res, err); }
  });
}

/**
 * Выдать вложение из кусков потоком. Заголовки (тип, имя, защита) выставляет
 * вызывающий. Возвращает false, если кусков нет: файл прежних версий лежит
 * строкой в записи, и его отдают как раньше.
 */
export async function streamChatChunks(res: Response, node: any): Promise<boolean> {
  const prisma = getPrisma();
  const first = await prisma.fileChunk.findFirst({ where: { fileId: node.id }, select: { id: true } });
  if (!first) return false;
  // Размер известен точно: done сверил его с суммой кусков
  if (Number(node.size) > 0) res.setHeader('Content-Length', String(Number(node.size)));
  let last = -1;
  for (;;) {
    const page = await prisma.fileChunk.findMany({ where: { fileId: node.id, idx: { gt: last } }, orderBy: { idx: 'asc' }, take: PAGE, select: { idx: true, data: true } });
    if (!page.length) break;
    for (const p of page) {
      if (res.destroyed) return true;
      last = p.idx;
      if (!res.write(Buffer.from(p.data))) {
        // Клиент мог уйти: 'drain' тогда не придёт, поэтому ждём и 'close'
        const gone = new AbortController();
        await Promise.race([once(res, 'drain', { signal: gone.signal }), once(res, 'close', { signal: gone.signal })]).catch(() => {}).finally(() => gone.abort());
      }
    }
  }
  res.end();
  return true;
}
