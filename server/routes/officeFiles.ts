/**
 * Файлы Flux Office: сохранение из редактора целиком, со сверкой и откатом.
 *
 * Зачем отдельный путь, а не куски Проводника (fileChunks.ts). Куски
 * рассчитаны на новый файл: номер куска перезаписывается, но куски сверх
 * нового числа остаются. Сохрани поверх книгу короче прежней — и в базе
 * склеится новое начало со старым хвостом, файл перестанет открываться.
 * Редактор же всегда пишет поверх, поэтому здесь запись идёт целиком и в одной
 * транзакции: старые куски уходят, новые ложатся.
 *
 * Правила данных (flux-data-safety):
 *   - сверка до записи: редактор присылает хеш того содержимого, с которого
 *     начал правку. Если файл за это время поменял кто-то другой, запись не
 *     происходит — ответ 409 и нынешний хеш, человек решает сам;
 *   - откат: прежнее содержимое кладётся в FileVersion ДО записи нового;
 *     хранятся последние KEEP версий файла;
 *   - кто сохранил — из сессии (authUser), а не из запроса.
 */
import express, { type Express, type Request, type Response } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { getPrisma, sendError } from '../context.js';
import { ensureTables as ensureDbTables } from '../ddl.js';
import { fileBytes } from './fileChunks.js';

export interface OfficeFileDeps {
  chunkBytes: () => Promise<number>;
  /** '' — можно писать; иначе причина отказа для человека */
  mayWrite: (req: Request, fileId: string) => Promise<string>;
}

/** Сколько прежних версий файла держим для отката */
const KEEP = 20;
/** Предел одного сохранения: больше редактор документов не открывает */
const LIMIT = '256mb';

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

let ensured = false;
async function ensureVersionTable(): Promise<string> {
  if (ensured) return '';
  const prisma = getPrisma();
  try {
    await (prisma as any).fileVersion.count();
    ensured = true;
    return '';
  } catch (_) {
    const why = await ensureDbTables(prisma, [{
      table: 'FileVersion',
      cols: [
        { name: 'id', kind: 'text', pk: true },
        { name: 'fileId', kind: 'text', notNull: true, def: '', indexed: true },
        { name: 'version', kind: 'int', notNull: true, def: 0 },
        { name: 'size', kind: 'int', notNull: true, def: 0 },
        { name: 'sha256', kind: 'text', notNull: true, def: '' },
        { name: 'data', kind: 'blob' },
        { name: 'createdById', kind: 'text' },
        { name: 'createdAt', kind: 'time', notNull: true, def: 'now' },
      ],
      indexes: [{ name: 'FileVersion_file_version_idx', cols: ['fileId', 'version'] }],
    }]);
    if (!why) ensured = true;
    return why;
  }
}

export function registerOfficeFileRoutes(app: Express, deps: OfficeFileDeps): void {
  /** Что сейчас в файле: редактор запоминает хеш при открытии */
  app.get('/api/office/files/:id/meta', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    try {
      const file = await prisma.fileNode.findUnique({ where: { id: String(req.params.id) } });
      if (!file) return res.status(404).json({ error: 'Файл не найден' });
      const bytes = await fileBytes(file);
      res.json({
        id: file.id, name: file.name, size: bytes.length, sha256: sha256(bytes),
        updatedAt: file.updatedAt, updatedById: file.updatedById,
      });
    } catch (err: any) { sendError(res, err); }
  });

  /** Сохранение целиком. Заголовок X-Base-Sha256 — с чего начиналась правка */
  app.put('/api/office/files/:id/content',
    express.raw({ type: () => true, limit: LIMIT }),
    async (req: Request, res: Response) => {
      const prisma = getPrisma();
      try {
        const fileId = String(req.params.id);
        const user = (req as any).authUser;
        if (!user?.id) return res.status(401).json({ error: 'Требуется вход в систему' });
        const denied = await deps.mayWrite(req, fileId);
        if (denied) return res.status(403).json({ error: denied });

        const body: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        if (!body.length) return res.status(400).json({ error: 'Пустое содержимое: сохранять нечего' });

        const why = await ensureVersionTable();
        if (why) return res.status(500).json({ error: `Не удалось подготовить хранилище версий: ${why}` });

        const file = await prisma.fileNode.findUnique({ where: { id: fileId } });
        if (!file) return res.status(404).json({ error: 'Файл не найден' });

        const before = await fileBytes(file);
        const beforeSha = sha256(before);
        const base = String(req.header('x-base-sha256') || '');
        if (!base) return res.status(400).json({ error: 'Не указано, с какой версии начата правка' });
        if (base !== beforeSha) {
          return res.status(409).json({
            error: 'Файл изменили после того, как вы его открыли. Ваши правки не записаны.',
            currentSha256: beforeSha,
          });
        }
        const afterSha = sha256(body);
        if (afterSha === beforeSha) return res.json({ sha256: afterSha, size: body.length, unchanged: true });

        const step = Math.max(64 * 1024, await deps.chunkBytes());
        const last = await (prisma as any).fileVersion.findFirst({
          where: { fileId }, orderBy: { version: 'desc' }, select: { version: true },
        });
        const version = (last?.version ?? 0) + 1;

        await prisma.$transaction(async (tx: any) => {
          // Прежнее — в откат, до того как его не станет
          await tx.fileVersion.create({
            data: {
              id: randomUUID(), fileId, version, size: before.length, sha256: beforeSha,
              data: before, createdById: user.id,
            },
          });
          await tx.fileChunk.deleteMany({ where: { fileId } });
          for (let i = 0, idx = 0; i < body.length; i += step, idx++) {
            await tx.fileChunk.create({ data: { fileId, idx, data: body.subarray(i, i + step) } });
          }
          await tx.fileNode.update({
            where: { id: fileId },
            data: { size: body.length, content: null, updatedById: user.id },
          });
        }, { timeout: 120_000 });

        // Старше KEEP — прочь; это только откат, а не история проекта
        const old = await (prisma as any).fileVersion.findMany({
          where: { fileId }, orderBy: { version: 'desc' }, skip: KEEP, select: { id: true },
        });
        if (old.length) await (prisma as any).fileVersion.deleteMany({ where: { id: { in: old.map((o: any) => o.id) } } });

        res.json({ sha256: afterSha, size: body.length, version });
      } catch (err: any) { sendError(res, err); }
    });

  /** Прежние версии: кто и когда сохранил, без содержимого */
  app.get('/api/office/files/:id/versions', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    try {
      const why = await ensureVersionTable();
      if (why) return res.status(500).json({ error: why });
      const rows = await (prisma as any).fileVersion.findMany({
        where: { fileId: String(req.params.id) }, orderBy: { version: 'desc' },
        select: { id: true, version: true, size: true, sha256: true, createdById: true, createdAt: true },
      });
      res.json({ versions: rows });
    } catch (err: any) { sendError(res, err); }
  });
}
