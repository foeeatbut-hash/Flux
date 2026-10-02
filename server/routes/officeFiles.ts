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
import { FILE_NOT_FOUND, FOLDER_NOT_FOUND, canAccessFolder, canReadFile, canWriteFile } from '../fileAccess.js';
import { fileBytes } from './fileChunks.js';
import { collabShared } from '../officeCollab.js';
import { officeBus } from '../officeBus.js';
import { shareOf, authorizedShareWrite, ShareDenied } from '../fileSharing.js';
import { oncePerDatabase } from '../schemaRuntime.js';
import { cleanName, createFileFromBytes, deskHome, exportsHome, homeOfFile, homeOfFolder, type FileHome } from '../officeStore.js';

export interface OfficeFileDeps {
  chunkBytes: () => Promise<number>;
  /** '' — можно писать; иначе причина отказа для человека */
  mayWrite: (req: Request, fileId: string) => Promise<string>;
  /** Кто сейчас держит правку файла (server/officeRooms.ts, по общей базе); null — никто */
  holderOf?: (fileId: string) => Promise<{ userId: string; name: string } | null>;
  /** Право сотрудника (userCan): класть на общий диск — по праву «Общий диск» */
  can?: (user: any, perm: string) => boolean;
}

/** Автосохранение пишет часто: версию отката — не чаще, чем раз в это время */
const AUTOSAVE_VERSION_MS = 10 * 60_000;

/** Файл в общем доступе — правят вместе; личный правит только хозяин */
export const isSharedFile = (file: { scope?: string | null }): boolean => file.scope !== 'PERSONAL';
export async function isCollaborativeFile(file: { id: string; scope?: string | null }): Promise<boolean> {
  if (isSharedFile(file)) return true;
  const share = await shareOf(getPrisma(), file.id);
  return !!share && share.state === 'READY' && share.audience !== 'NONE';
}

/** Сколько прежних версий файла держим для отката */
const KEEP = 20;
/** Предел одного сохранения: больше редактор документов не открывает */
const LIMIT = '256mb';

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

async function ensureVersionTable(): Promise<string> {
  const prisma = getPrisma();
  try { return await oncePerDatabase(prisma, 'office-file-versions', async () => {
  try {
    await (prisma as any).fileVersion.count();
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
    if (why) throw Error(why);
    return '';
  }
  }); } catch (err: any) { return err?.message || String(err); }
}

/**
 * Запись файла целиком — одно ядро для всех редакторов: Документ шлёт байты
 * сюда из окна, PDF и Таблица — через главный процесс на сервере
 * (server/officeHostApps.ts). Правила одни: право записи, держатель, сверка
 * хеша, откат до записи, кто сохранил — из сессии.
 */
export async function writeOfficeFile(a: {
  fileId: string; body: Buffer; baseSha: string; user: { id: string } | null; autosave?: boolean; sessionKey?: string; shareEpoch?: number;
  /**
   * Пишет сервер, а не окно держателя: восстановление версии, «Обновить поля»,
   * английская версия. Сеанс совместной правки после такой записи забывается —
   * в нём старое содержимое (OfficeBus.dropSession)
   */
  server?: boolean;
}): Promise<{ status: number; json: any }> {
  const deps = routeDeps;
  if (!deps) return { status: 500, json: { error: 'Хранилище файлов Flux Office не подключено' } };
  const prisma = getPrisma();
  const { fileId, body, autosave } = a;
  const base = a.baseSha;
  const user = a.user;
  const reply = (status: number, json: any) => ({ status, json });
  if (!user?.id) return reply(401, { error: 'Требуется вход в систему' });
  // Общее ядро записи для всех редакторов: чужой личный файл и файл закрытого
  // проекта для вошедшего «не найден», как и в Проводнике
  if (!(await canWriteFile(prisma, user, fileId))) return reply(404, { error: FILE_NOT_FOUND });
  const shareAtStart = await shareOf(prisma, fileId);
  const denied = await deps.mayWrite({ authUser: user } as any, fileId);
  if (denied) return reply(403, { error: denied });
  // Файл открыт и правится другим — его сохранение и есть правда;
  // запись в обход держателя затёрла бы то, что он видит у себя
  const holder = await deps.holderOf?.(fileId);
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
    // Общий файл: если в нём ровно то, что записал сам сеанс (держатель успел
    // смениться, и записал прежний), окно вправе взять этот хеш и записать ещё
    // раз — содержимое общее, и в нём уже есть всё записанное. Если же файл
    // менял кто-то в обход сеанса, повторять вслепую нельзя: затрёшь чужое
    const session = await isCollaborativeFile(file) ? await officeBus.session(fileId).catch(() => null) : null;
    return reply(409, {
      error: 'Файл изменили после того, как вы его открыли. Ваши правки не записаны.',
      currentSha256: beforeSha,
      bySession: !!a.sessionKey && session?.key === a.sessionKey && session.savedSha === beforeSha,
    });
  }
  const afterSha = sha256(body);
  if (afterSha === beforeSha) return reply(200, { sha256: afterSha, size: body.length, unchanged: true });

  const step = Math.max(64 * 1024, await deps.chunkBytes());
  if (shareAtStart && !a.sessionKey && !a.server) {
    const why = await officeBus.ready();
    if (why) return reply(500, { error: why });
  }
  // Сверка и захват строки в одной транзакции: два окна с одинаковым
  // исходным хешем не могут оба затереть файл. Метка монотонна даже при
  // двух сохранениях в одну миллисекунду.
  let saved: any;
  try { saved = await authorizedShareWrite(prisma, fileId, user.id, async (tx: any) => {
    if (shareAtStart && !a.sessionKey && !a.server) {
      // Локальная синхронизация не затирает принятые, но ещё не сохранённые
      // правки соавторов. Блокировка держится до записи вместе с правом доступа.
      await tx.officeSession.updateMany({ where: { fileId }, data: { lastSeq: { increment: 0 } } });
      const session = await tx.officeSession.findUnique({ where: { fileId }, select: { dataSeq: true, savedSeq: true } });
      if (session && session.dataSeq > session.savedSeq) return { pendingSharedEdits: true };
    }
    const stamp = new Date(Math.max(Date.now(), new Date(file.updatedAt).getTime() + 1));
    const claimed = await tx.fileNode.updateMany({
      where: { id: fileId, updatedAt: file.updatedAt, deletedAt: null },
      data: { updatedAt: stamp },
    });
    if (!claimed.count) return null;
    const last = await tx.fileVersion.findFirst({
      where: { fileId }, orderBy: { version: 'desc' }, select: { version: true, createdAt: true },
    });
    const version = (last?.version ?? 0) + 1;
    const keepVersion = !autosave || !last || Date.now() - new Date(last.createdAt).getTime() >= AUTOSAVE_VERSION_MS;
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
      data: { size: body.length, content: null, updatedById: user.id, updatedAt: stamp },
    });
    return { version: keepVersion ? version : last?.version ?? 0 };
  }, a.shareEpoch ?? (shareAtStart ? Number(shareAtStart.epoch) : undefined)); } catch (err) { if (err instanceof ShareDenied) return reply(403, { error: err.message, accessRevoked: true }); throw err; }
  if (saved?.pendingSharedEdits) return reply(409, { error: 'В общей версии есть несохранённые правки сотрудников. Дождитесь сохранения; исходник не перезаписан.', pendingSharedEdits: true });
  if (!saved) {
    const current = await prisma.fileNode.findUnique({ where: { id: fileId } });
    if (!current) return reply(404, { error: FILE_NOT_FOUND });
    return reply(409, {
      error: 'Файл изменился во время сохранения. Ваши правки не записаны.',
      currentSha256: sha256(await fileBytes(current)), bySession: false,
    });
  }

  // Старше KEEP — прочь; это только откат, а не история проекта
  const old = await (prisma as any).fileVersion.findMany({
    where: { fileId }, orderBy: { version: 'desc' }, skip: KEEP, select: { id: true },
  });
  if (old.length) await (prisma as any).fileVersion.deleteMany({ where: { id: { in: old.map((o: any) => o.id) } } });
  // Сеанс общий для всех серверов: сбрасывается в базе, а не в памяти этого
  if (a.server || shareAtStart && !a.sessionKey) await officeBus.dropSession(fileId);
  // Что записано последним: по этому хешу отличают «записал держатель» от «изменили в обход»
  else if (await isCollaborativeFile(file) && a.sessionKey) await officeBus.patchSession({ fileId, key: a.sessionKey }, { savedSha: afterSha }).catch(() => 0);

  return reply(200, { sha256: afterSha, size: body.length, version: saved.version });
}

let routeDeps: OfficeFileDeps | null = null;

/** Копия редактора: те же права и место, что у копии документа Word. */
export async function copyOfficeFile(a: { fileId: string; body: Buffer; name: string; user: { id: string } | null }) {
  const prisma = getPrisma();
  if (!a.user?.id || !routeDeps) throw new Error('Требуется вход в систему');
  if (!(await canReadFile(prisma, a.user, a.fileId))) throw new Error(FILE_NOT_FOUND);
  const denied = await routeDeps.mayWrite({ authUser: a.user } as any, a.fileId);
  if (denied) throw new Error(denied);
  const from = await prisma.fileNode.findUnique({ where: { id: a.fileId } });
  const home = await homeOfFile(a.fileId);
  if (!from || !home) throw new Error(FILE_NOT_FOUND);
  if (!a.body.length) throw new Error('Пустое содержимое: сохранять нечего');
  return createFileFromBytes({ name: cleanName(a.name, from.name), body: a.body, home,
    userId: a.user.id, chunkBytes: await routeDeps.chunkBytes(), type: from.type });
}

export function registerOfficeFileRoutes(app: Express, deps: OfficeFileDeps): void {
  routeDeps = deps;
  /** Что сейчас в файле: редактор запоминает хеш при открытии */
  app.get('/api/office/files/:id/meta', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    try {
      const file = await prisma.fileNode.findUnique({ where: { id: String(req.params.id) } });
      if (!file || !(await canReadFile(prisma, (req as any).authUser, file))) return res.status(404).json({ error: FILE_NOT_FOUND });
      const bytes = await fileBytes(file);
      const folder = file.folderId ? await prisma.folder.findUnique({ where: { id: file.folderId }, select: { projectId: true } }) : null;
      const session = await officeBus.session(file.id).catch(() => null);
      res.json({
        id: file.id, name: file.name, folderId: file.folderId, projectId: folder?.projectId || null, size: bytes.length, sha256: sha256(bytes),
        updatedAt: file.updatedAt, updatedById: file.updatedById,
        canWrite: await canWriteFile(prisma, (req as any).authUser, file),
        pendingSharedEdits: !!session && session.dataSeq > session.savedSeq,
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
      if (!file || !(await canReadFile(prisma, (req as any).authUser, file))) return res.status(404).json({ error: FILE_NOT_FOUND });
      const current = await fileBytes(file);
      const shared = await isCollaborativeFile(file);
      // Исходник сеанса берётся из общей базы: его записал тот, кто открыл файл
      // первым, на любом сервере, и у всех участников он один
      const session = shared ? await collabShared.base(file.id, async () => current) : null;
      const body = session ? (session.baseData as Buffer) : current;
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
          sessionKey: String(req.header('x-office-session') || ''),
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
        if (!(await canReadFile(prisma, user, fromId))) return res.status(404).json({ error: FILE_NOT_FOUND });
        const denied = await deps.mayWrite(req, fromId);
        if (denied) return res.status(403).json({ error: denied });
        const body: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        if (!body.length) return res.status(400).json({ error: 'Пустое содержимое: сохранять нечего' });

        const from = await prisma.fileNode.findUnique({ where: { id: fromId } });
        if (!from) return res.status(404).json({ error: FILE_NOT_FOUND });

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
          // Скрытый проект и чужая личная папка — «не найдена»: ответ «чужая»
          // подтверждал, что такой номер есть
          if (!folder || folder.deletedAt || !(await canAccessFolder(prisma, user, folderId))) return res.status(404).json({ error: FOLDER_NOT_FOUND });
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
        const revision = typeof req.query.revision === 'string' ? req.query.revision : undefined;
        const file = await createFileFromBytes({ name: cleanName(name, name), body, home, userId: user.id, chunkBytes: await deps.chunkBytes(), revision });
        res.json(file);
      } catch (err: any) { sendError(res, err); }
    });

  /** Прежние версии: кто и когда сохранил, без содержимого */
  app.get('/api/office/files/:id/versions', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    try {
      // Список версий раскрывает, кто и когда правил файл, — только тем, кому файл виден
      if (!(await canReadFile(prisma, (req as any).authUser, String(req.params.id)))) return res.status(404).json({ error: FILE_NOT_FOUND });
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
