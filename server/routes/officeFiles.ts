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
 *   - кто сохранил — из сессии (authUser), а не из запроса;
 *   - пока файл правит другой (держатель в server/officeRooms.ts), запись
 *     не идёт — ответ 423 и его имя.
 */
import express, { type Express, type Request, type Response } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { getPrisma, sendError } from '../context.js';
import { ensureTables as ensureDbTables } from '../ddl.js';
import { fileBytes } from './fileChunks.js';
import { collab } from '../officeCollab.js';
import { cleanName, createFileFromBytes, deskHome, exportsHome, homeOfFile, homeOfFolder, type FileHome } from '../officeStore.js';

export interface OfficeFileDeps {
  chunkBytes: () => Promise<number>;
  /** '' — можно писать; иначе причина отказа для человека */
  mayWrite: (req: Request, fileId: string) => Promise<string>;
  /** Кто сейчас держит правку файла (server/officeRooms.ts); null — никто */
  holderOf?: (fileId: string) => { userId: string; name: string } | null;
  /** Право сотрудника (userCan): класть на общий диск — по праву «Общий диск» */
  can?: (user: any, perm: string) => boolean;
}

/** Автосохранение пишет часто: версию отката — не чаще, чем раз в это время */
const AUTOSAVE_VERSION_MS = 10 * 60_000;

/** Файл в общем доступе — правят вместе; личный правит только хозяин */
export const isSharedFile = (file: { scope?: string | null }): boolean => file.scope !== 'PERSONAL';

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

/**
 * Запись файла целиком — одно ядро для всех редакторов: Документ шлёт байты
 * сюда из окна, PDF и Таблица — через главный процесс на сервере
 * (server/officeHostApps.ts). Правила одни: право записи, держатель, сверка
 * хеша, откат до записи, кто сохранил — из сессии.
 */
export async function writeOfficeFile(a: {
  fileId: string; body: Buffer; baseSha: string; user: { id: string } | null; autosave?: boolean;
}): Promise<{ status: number; json: any }> {
  const deps = routeDeps;
  if (!deps) return { status: 500, json: { error: 'Хранилище файлов Flux Office не подключено' } };
  const prisma = getPrisma();
  const { fileId, body, autosave } = a;
  const base = a.baseSha;
  const user = a.user;
  const reply = (status: number, json: any) => ({ status, json });
  if (!user?.id) return reply(401, { error: 'Требуется вход в систему' });
  const denied = await deps.mayWrite({ authUser: user } as any, fileId);
  if (denied) return reply(403, { error: denied });
  // Файл открыт и правится другим — его сохранение и есть правда;
  // запись в обход держателя затёрла бы то, что он видит у себя
  const holder = deps.holderOf?.(fileId);
  if (holder && holder.userId !== user.id) {
    return reply(423, { error: `Файл сейчас правит ${holder.name}. Ваши правки не записаны.`, holder: holder.name });
  }

  if (!body.length) return reply(400, { error: 'Пустое содержимое: сохранять нечего' });

  const why = await ensureVersionTable();
  if (why) return reply(500, { error: `Не удалось подготовить хранилище версий: ${why}` });

  const file = await prisma.fileNode.findUnique({ where: { id: fileId } });
  if (!file) return reply(404, { error: 'Файл не найден' });

  const before = await fileBytes(file);
  const beforeSha = sha256(before);
  if (!base) return reply(400, { error: 'Не указано, с какой версии начата правка' });
  if (base !== beforeSha) {
    return reply(409, {
      error: 'Файл изменили после того, как вы его открыли. Ваши правки не записаны.',
      currentSha256: beforeSha,
    });
  }
  const afterSha = sha256(body);
  if (afterSha === beforeSha) return reply(200, { sha256: afterSha, size: body.length, unchanged: true });

  const step = Math.max(64 * 1024, await deps.chunkBytes());
  const last = await (prisma as any).fileVersion.findFirst({
    where: { fileId }, orderBy: { version: 'desc' }, select: { version: true },
  });
  const version = (last?.version ?? 0) + 1;
  // Автосохранение совместной правки пишет раз в несколько секунд:
  // версия на каждое — и двадцать версий отката сгорели бы за минуту
  let keepVersion = true;
  if (autosave && last) {
    const lastAt = await (prisma as any).fileVersion.findFirst({
      where: { fileId }, orderBy: { version: 'desc' }, select: { createdAt: true },
    });
    keepVersion = !lastAt || Date.now() - new Date(lastAt.createdAt).getTime() >= AUTOSAVE_VERSION_MS;
  }

  await prisma.$transaction(async (tx: any) => {
    // Прежнее — в откат, до того как его не станет
    if (keepVersion) await tx.fileVersion.create({
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

  return reply(200, { sha256: afterSha, size: body.length, version: keepVersion ? version : last?.version ?? 0 });
}

let routeDeps: OfficeFileDeps | null = null;

export function registerOfficeFileRoutes(app: Express, deps: OfficeFileDeps): void {
  routeDeps = deps;
  /** Что сейчас в файле: редактор запоминает хеш при открытии */
  app.get('/api/office/files/:id/meta', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    try {
      const file = await prisma.fileNode.findUnique({ where: { id: String(req.params.id) } });
      if (!file) return res.status(404).json({ error: 'Файл не найден' });
      const bytes = await fileBytes(file);
      res.json({
        id: file.id, name: file.name, folderId: file.folderId, size: bytes.length, sha256: sha256(bytes),
        updatedAt: file.updatedAt, updatedById: file.updatedById,
      });
    } catch (err: any) { sendError(res, err); }
  });

  /**
   * Что открыть в редакторе. Общий файл — исходник сеанса совместной правки
   * (server/officeCollab.ts): у всех участников один и тот же, даже если
   * держатель уже записал в файл свежее — свежее придёт из общего документа.
   * Личный — текущее содержимое.
   */
  app.get('/api/office/files/:id/open', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    try {
      const file = await prisma.fileNode.findUnique({ where: { id: String(req.params.id) } });
      if (!file) return res.status(404).json({ error: 'Файл не найден' });
      const current = await fileBytes(file);
      const shared = isSharedFile(file as any);
      const session = shared ? await collab.ensure(file.id, async () => current) : null;
      const body = session ? session.baseBytes : current;
      if (session) res.setHeader('X-Collab-Session', session.key);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('X-Collab', shared ? '1' : '0');
      res.setHeader('X-Base-Sha256', sha256(body));
      res.setHeader('X-Current-Sha256', sha256(current));
      res.setHeader('X-File-Name', encodeURIComponent(file.name || ''));
      res.end(body);
    } catch (err: any) { sendError(res, err); }
  });

  /** Сохранение целиком. Заголовок X-Base-Sha256 — с чего начиналась правка */
  app.put('/api/office/files/:id/content',
    express.raw({ type: () => true, limit: LIMIT }),
    async (req: Request, res: Response) => {
      try {
        const r = await writeOfficeFile({
          fileId: String(req.params.id),
          body: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
          baseSha: String(req.header('x-base-sha256') || ''),
          user: (req as any).authUser || null,
          autosave: String(req.header('x-autosave') || '') === '1',
        });
        res.status(r.status).json(r.json);
      } catch (err: any) { sendError(res, err); }
    });

  /**
   * «Сохранить как» и «Сохранить мою копию рядом»: новый файл в той же папке.
   *
   * Копия ложится туда же, где исходник, с тем же разделом и владельцем: иначе
   * личный документ, сохранённый «как», оказался бы в общем корне. Имя
   * подбирается свободное — чужой файл с тем же именем не затирается.
   */
  app.post('/api/office/files/:id/copy',
    express.raw({ type: () => true, limit: LIMIT }),
    async (req: Request, res: Response) => {
      const prisma = getPrisma();
      try {
        const fromId = String(req.params.id);
        const user = (req as any).authUser;
        if (!user?.id) return res.status(401).json({ error: 'Требуется вход в систему' });
        const denied = await deps.mayWrite(req, fromId);
        if (denied) return res.status(403).json({ error: denied });
        const body: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        if (!body.length) return res.status(400).json({ error: 'Пустое содержимое: сохранять нечего' });

        const from = await prisma.fileNode.findUnique({ where: { id: fromId } });
        if (!from) return res.status(404).json({ error: 'Файл не найден' });

        const home = await homeOfFile(fromId);
        if (!home) return res.status(404).json({ error: 'Файл не найден' });
        const file = await createFileFromBytes({
          name: cleanName(String(req.query.name || ''), from.name), body, home, userId: user.id,
          chunkBytes: await deps.chunkBytes(), type: from.type,
        });
        res.json(file);
      } catch (err: any) { sendError(res, err); }
    });

  /**
   * Новый файл из байтов: выгрузка, пустой документ, английская версия.
   * where: exports — «Выгрузки» на личном столе (по умолчанию); desk — личный
   * стол; shared — общий стол; folder — папка folderId. Отвечает тем же, что
   * копия: id, имя (свободное в папке), хеш и размер
   */
  app.post('/api/office/files/new',
    express.raw({ type: () => true, limit: LIMIT }),
    async (req: Request, res: Response) => {
      const prisma = getPrisma();
      try {
        const user = (req as any).authUser;
        if (!user?.id) return res.status(401).json({ error: 'Требуется вход в систему' });
        const body: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        const name = String(req.query.name || '').trim();
        if (!name) return res.status(400).json({ error: 'Нет имени файла' });
        const where = String(req.query.where || 'exports');
        const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : null;
        let home: FileHome | null = null;
        if (where === 'folder') {
          const folderId = String(req.query.folderId || '');
          const folder = folderId ? await prisma.folder.findUnique({ where: { id: folderId }, include: { project: true } }) : null;
          if (!folder || folder.deletedAt) return res.status(404).json({ error: 'Папка не найдена' });
          // Чужая личная папка и общий диск — не место для выгрузки: на диск
          // кладут по праву «Общий диск», через Проводник
          if (folder.scope === 'PERSONAL' && folder.ownerId !== user.id) return res.status(403).json({ error: 'Это чужая личная папка' });
          if ((folder as any).project?.system && !deps.can?.(user, 'disk.write')) {
            return res.status(403).json({ error: 'Класть файлы на общий диск можно по праву «Общий диск». Его выдаёт администратор в разделе «Сотрудники».' });
          }
          home = await homeOfFolder(folderId);
        } else if (where === 'section') {
          // Корень раздела Проводника: у его файлов нет папки. Личный раздел —
          // только свой, чужой личный не место для нового файла
          const shared = req.query.scope !== 'PERSONAL';
          home = { folderId: null, scope: shared ? 'SHARED' : 'PERSONAL', ownerId: shared ? null : user.id, dir: shared ? '/shared/' : '/personal/' };
        } else if (where === 'desk' || where === 'shared') {
          home = await deskHome(user.id, where === 'shared', projectId);
        } else {
          home = await exportsHome(user.id, projectId);
        }
        if (!home) return res.status(404).json({ error: 'Папка не найдена' });
        const file = await createFileFromBytes({ name: cleanName(name, name), body, home, userId: user.id, chunkBytes: await deps.chunkBytes() });
        res.json(file);
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
