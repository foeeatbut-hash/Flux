/**
 * Содержимое файла кусками — вместо одной строки в записи файла.
 *
 * Почему это вообще понадобилось. Файл лежал строкой base64 в колонке
 * `FileNode.content`, а строка целиком едет в базу одним пакетом. У MariaDB
 * размер пакета ограничен (`@@max_allowed_packet`), и при скромной настройке
 * предел на файл получался около пяти мегабайт — не потому, что так решили, а
 * потому, что больше просто не проходило. Хуже того: MariaDB на слишком
 * большой пакет не отвечает ошибкой, а разрывает соединение, и программа
 * видит «connection closed», по которому причину не угадать.
 *
 * Тем же способом уже ездит файл обновления (server/updates.ts): куски по
 * размеру, спрошенному у самой базы. Здесь то же самое для файлов Проводника,
 * и предела на размер больше нет — остаются место на диске базы и время
 * передачи, о чём человеку говорится честно.
 *
 * Старые файлы не переписываются: у записи с `content` он и читается. Кусков
 * нет — значит файл старый, и это не поломка.
 */
import type { Express, Request, Response } from 'express';
import { getPrisma, sendError } from '../context.js';

export interface FileChunkDeps {
  /** Размер куска под предел пакета этой базы */
  chunkBytes: () => Promise<number>;
  /**
   * Можно ли писать в этот файл. Возвращает текст отказа или пустую строку.
   * Право на общий диск считается там же, где для остальных действий с файлами
   */
  mayWrite: (req: Request, fileId: string) => Promise<string>;
}

/** Куски одного файла по порядку. Пусто — файл старый или ещё не дописан */
async function chunksOf(fileId: string): Promise<Buffer[]> {
  const rows = await getPrisma().fileChunk.findMany({
    where: { fileId },
    orderBy: { idx: 'asc' },
    select: { data: true },
  });
  return rows.map((r: any) => Buffer.from(r.data));
}

/**
 * Байты файла: из кусков, а если их нет — из строки прежнего вида.
 * Экспортируется: тем же способом файл читают выгрузка и резервная копия.
 */
export async function fileBytes(file: any): Promise<Buffer> {
  const parts = await chunksOf(file.id);
  if (parts.length) return Buffer.concat(parts);
  const raw = String(file.content || '');
  if (!raw) return Buffer.alloc(0);
  const b64 = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw;
  return Buffer.from(b64, 'base64');
}

export function registerFileChunkRoutes(app: Express, deps: FileChunkDeps): void {
  // Сколько байт слать за раз — спрашивает окно перед отправкой
  app.get('/api/files/chunk-size', async (_req: Request, res: Response) => {
    try {
      res.json({ chunkBytes: await deps.chunkBytes() });
    } catch (err: any) { sendError(res, err); }
  });

  /**
   * Кусок содержимого. Перезапись, а не добавление: повторная отправка того же
   * номера после обрыва не должна плодить дубли — иначе файл, собранный
   * обратно, окажется длиннее себя, и заметит это не программа, а человек,
   * открывший испорченную книгу.
   */
  app.post('/api/files/:id/chunk', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    try {
      const fileId = String(req.params.id);
      const denied = await deps.mayWrite(req, fileId);
      if (denied) return res.status(403).json({ error: denied });

      const idx = Number(req.body?.idx);
      const data = String(req.body?.data || '');
      if (!Number.isInteger(idx) || idx < 0) return res.status(400).json({ error: 'Неверный номер куска' });
      if (!data) return res.status(400).json({ error: 'Пустой кусок' });
      const bytes = Buffer.from(data, 'base64');

      await prisma.fileChunk.upsert({
        where: { fileId_idx: { fileId, idx } },
        create: { fileId, idx, data: bytes },
        update: { data: bytes },
      });
      res.json({ ok: true, idx, bytes: bytes.length });
    } catch (err: any) { sendError(res, err); }
  });

  /**
   * Файл дописан: проставляем размер и убираем прежнюю строку содержимого.
   *
   * Размер берём НЕ из тела запроса, а считаем по кускам: иначе в записи
   * оказался бы размер, который прислало окно, а в базе — то, что доехало.
   * Расхождение тихое и вылезает через месяц, при выгрузке.
   */
  app.post('/api/files/:id/done', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    try {
      const fileId = String(req.params.id);
      const denied = await deps.mayWrite(req, fileId);
      if (denied) return res.status(403).json({ error: denied });

      const rows = await prisma.fileChunk.findMany({ where: { fileId }, select: { data: true } });
      const size = rows.reduce((n: number, r: any) => n + Buffer.from(r.data).length, 0);
      const file = await prisma.fileNode.update({
        where: { id: fileId },
        data: { size, content: null },
      });
      res.json({ file, size, chunks: rows.length });
    } catch (err: any) { sendError(res, err); }
  });

  /**
   * Байты файла — потоком, а не в конверте JSON.
   *
   * Прежний путь отдавал содержимое строкой внутри объекта: сервер собирал
   * весь файл в памяти, окно его разбирало и декодировало. На сорока
   * мегабайтах это заметно, на четырёхстах — невозможно. Куски уходят по
   * одному, и память не растёт с размером файла.
   */
  app.get('/api/files/:id/raw', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    try {
      const file = await prisma.fileNode.findUnique({ where: { id: String(req.params.id) } });
      if (!file) return res.status(404).json({ error: 'Файл не найден' });

      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.name || 'file')}`);

      const parts = await prisma.fileChunk.findMany({
        where: { fileId: file.id },
        orderBy: { idx: 'asc' },
        select: { data: true },
      });
      if (parts.length) {
        for (const p of parts) res.write(Buffer.from(p.data));
        return res.end();
      }
      // Файл прежних версий: содержимое лежит строкой. Переписывать его не
      // надо — он и так читается
      const raw = String(file.content || '');
      if (!raw) return res.end();
      const b64 = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw;
      res.end(Buffer.from(b64, 'base64'));
    } catch (err: any) { sendError(res, err); }
  });
}
