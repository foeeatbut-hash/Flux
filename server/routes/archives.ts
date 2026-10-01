import type { Express, Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { getPrisma, resolveProjectId } from '../context.js';
import { canAccessFolder, canReadFile, FILE_NOT_FOUND } from '../fileAccess.js';
import { fileBytes } from './fileChunks.js';
import { archiveEnginePath, listArchive, run7z, run7zBounded } from '../archive/engine.js';
import { checkArchiveLimits, safeArchivePath, type ArchiveEntry } from '../archive/safety.js';

const INPUT_MAX = 256 * 1024 * 1024;
const OUTPUT_MAX = 512 * 1024 * 1024;
const ENTRY_MAX = 5000;
const TIMEOUT = 120_000;
const jobs = new Map<string, number>();
let activeJobs = 0;

export interface ArchiveDeps {
  can: (user: any, feature: string) => boolean;
  chunkBytes: () => Promise<number>;
}

function auth(req: Request, res: Response): any | null {
  const user = (req as any).authUser;
  if (!user?.id) { res.status(401).json({ error: 'Требуется вход в систему' }); return null; }
  return user;
}

function fail(res: Response, err: any): void {
  const message = String(err?.message || 'Не удалось обработать архив');
  if (message === FILE_NOT_FOUND || message === 'Папка не найдена' || message === 'Папка назначения не найдена') {
    res.status(404).json({ error: message }); return;
  }
  if (message.startsWith('Предпросмотр устарел') || message.startsWith('Исходный архив изменился')) {
    res.status(409).json({ error: message }); return;
  }
  const clientMessage = /^(Пароль неверен|Предпросмотр устарел|Исходный архив изменился|Папка назначения|Архив повреждён|Операция с архивом|Архивный движок|Небезопасное имя|Архив содержит|В архиве|Распакованный архив|Повреждённое содержимое|Распаковка создала|Выберите|Неверный|Для архива|Сначала|Некорректный|Нет элементов|Не удалось сохранить|Элемент не найден|Формат архива|Имя архива|Выбранный архив|Входной архив|Править можно|Путь |Путь нельзя|Правка создаёт|Нельзя добавить)/.test(message)
    ? message : 'Не удалось обработать архив';
  res.status(clientMessage === 'Требуется вход в систему' ? 401 : 400).json({ error: clientMessage });
}

async function runJob(userId: string, fn: (deadline: number) => Promise<void>, res: Response): Promise<void> {
  if (activeJobs >= 2 || (jobs.get(userId) || 0) >= 1) {
    res.status(429).json({ error: 'Сейчас уже выполняется операция с архивом. Попробуйте позже' });
    return;
  }
  activeJobs++;
  jobs.set(userId, (jobs.get(userId) || 0) + 1);
  const deadline = Date.now() + TIMEOUT;
  try { await fn(deadline); }
  catch (err: any) { fail(res, err); }
  finally {
    activeJobs--;
    const left = (jobs.get(userId) || 1) - 1;
    if (left) jobs.set(userId, left); else jobs.delete(userId);
  }
}

function timeLeft(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('Операция с архивом превысила лимит времени');
  return remaining;
}

function passwordOf(body: any): string | undefined {
  if (body?.password === undefined || body.password === null || body.password === '') return undefined;
  if (typeof body.password !== 'string' || body.password.length > 128 || /[\u0000\r\n]/.test(body.password)) throw new Error('Некорректный пароль архива');
  return body.password;
}

function idsOf(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > ENTRY_MAX || value.some((x) => typeof x !== 'string' || !x || x.length > 128)) throw new Error('Выберите не более 5000 элементов');
  return [...new Set(value as string[])];
}

function supportedName(name: string): boolean { return /\.(zip|7z|rar|tar|gz|tgz|bz2|xz|cab|iso)$/i.test(name); }

async function getReadableArchive(id: string, user: any): Promise<any> {
  const prisma = getPrisma();
  const file = await prisma.fileNode.findUnique({ where: { id } });
  if (!file || file.deletedAt || !supportedName(String(file.name || '')) || !(await canReadFile(prisma, user, file))) throw new Error(FILE_NOT_FOUND);
  if (Number(file.size || 0) > INPUT_MAX) throw new Error('Входной архив превышает предел 256 МБ');
  const ext = extname(String(file.name || '')).toLowerCase();
  const stem = String(file.name || '').slice(0, -ext.length).toLocaleLowerCase('en-US');
  if (['.rar', '.zip', '.7z'].includes(ext)) {
    const siblings = await prisma.fileNode.findMany({ where: { folderId: file.folderId, scope: file.scope, ownerId: file.ownerId, deletedAt: null }, select: { name: true } });
    const multi = siblings.some((x: any) => {
      const name = String(x.name || '').toLocaleLowerCase('en-US');
      if (name === String(file.name).toLocaleLowerCase('en-US')) return false;
      return ext === '.rar' ? name.startsWith(`${stem}.part`) && name.endsWith('.rar') || name.startsWith(`${stem}.r`) && /^\d{2,}$/.test(name.slice(`${stem}.r`.length))
        : ext === '.zip' ? name.startsWith(`${stem}.z`) && /^\d{2,}$/.test(name.slice(`${stem}.z`.length))
          : name.startsWith(`${stem}.7z.`) && /^\d{3}$/.test(name.slice(`${stem}.7z.`.length));
    });
    if (multi) throw new Error('Многотомные архивы пока не поддерживаются');
  }
  return file;
}

async function folderWritable(user: any, folderId: string | null, can: ArchiveDeps['can']): Promise<boolean> {
  if (!folderId) return true;
  const prisma = getPrisma();
  if (!(await canAccessFolder(prisma, user, folderId))) return false;
  const folder = await prisma.folder.findUnique({ where: { id: folderId }, select: { project: { select: { system: true } } } });
  return !folder?.project?.system || can(user, 'disk.write');
}

async function siblingNames(folderId: string | null, scope: string, ownerId: string | null): Promise<Set<string>> {
  const prisma = getPrisma();
  const files = await prisma.fileNode.findMany({ where: { folderId, deletedAt: null, scope, ownerId }, select: { name: true } });
  const folders = await prisma.folder.findMany({ where: { parentId: folderId, deletedAt: null, scope, ownerId }, select: { name: true } });
  return new Set([...files, ...folders].map((x: any) => String(x.name).toLocaleLowerCase('en-US')));
}

function uniqueName(base: string, extension: string, taken: Set<string>): string {
  const clean = base.replace(/[<>:"|?*\u0000-\u001f]/g, '').replace(/[. ]+$/g, '').trim().slice(0, 160) || 'Архив';
  let name = `${clean}${extension}`;
  for (let i = 2; taken.has(name.toLocaleLowerCase('en-US')); i++) name = `${clean} (${i})${extension}`;
  return name;
}

function archiveError(err: any): string {
  const message = String(err?.message || '');
  if (message.startsWith('Архив содержит') || message.startsWith('Многотомные архивы')) return message;
  if (message.startsWith('Пароль неверен')) return 'Пароль неверен или архив повреждён';
  if (String(err?.message || '').startsWith('Операция с архивом')) return 'Операция с архивом превысила лимит времени';
  const text = `${err?.stdout || ''}\n${err?.stderr || ''}`.toLowerCase();
  if (/wrong password|password is incorrect|data error in encrypted file/.test(text)) return 'Пароль неверен или архив повреждён';
  return 'Архив повреждён или имеет неподдерживаемый формат';
}

async function boundedBytes(file: any, max: number): Promise<Buffer> {
  const bytes = await fileBytes(file);
  if (bytes.length > max) throw new Error('Входной архив превышает предел 256 МБ');
  return bytes;
}

async function directoryFiles(root: string): Promise<Array<{ path: string; size: number; full: string }>> {
  const found: Array<{ path: string; size: number; full: string }> = [];
  let count = 0; let totalBytes = 0;
  const walk = async (dir: string) => {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      if (++count > ENTRY_MAX) throw new Error('В архиве слишком много элементов');
      const full = join(dir, item.name);
      const info = await lstat(full);
      if (info.isSymbolicLink() || info.nlink > 1) throw new Error('Распаковка создала ссылку; операция отменена');
      if (info.isDirectory()) await walk(full);
      else if (info.isFile()) {
        totalBytes += info.size;
        if (totalBytes > OUTPUT_MAX) throw new Error('Распакованный архив превышает предел 512 МБ');
        found.push({ path: relative(root, full).split(sep).join('/'), size: info.size, full });
      }
      else throw new Error('Распаковка создала недопустимый элемент');
    }
  };
  await walk(root);
  return found;
}

export function registerArchiveRoutes(app: Express, deps: ArchiveDeps): void {
  app.get('/api/archives/capabilities', (req: Request, res: Response) => {
    if (!auth(req, res)) return;
    try { archiveEnginePath(); res.json({ available: true, formats: { read: ['zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'cab', 'iso'], create: ['zip', '7z'], extract: ['zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'cab', 'iso'], multiPart: false }, limits: { inputBytes: INPUT_MAX, outputBytes: OUTPUT_MAX, entries: ENTRY_MAX, timeoutMs: TIMEOUT } }); }
    catch { res.json({ available: false, formats: { read: [], create: [], extract: [] } }); }
  });

  app.post('/api/archives/:id/list', async (req: Request, res: Response) => {
    const user = auth(req, res); if (!user) return;
    await runJob(user.id, async (deadline) => {
      const password = passwordOf(req.body);
      const file = await getReadableArchive(String(req.params.id), user);
      const rows = await listArchiveOnFile(file, password, deadline);
      checkArchiveLimits(rows);
      res.json({ entries: rows.map(({ path, size, directory, encrypted }) => ({ path, size, directory, encrypted })) });
    }, res);
  });

  app.post('/api/archives/:id/test', async (req: Request, res: Response) => {
    const user = auth(req, res); if (!user) return;
    await runJob(user.id, async (deadline) => {
      const password = passwordOf(req.body);
      const file = await getReadableArchive(String(req.params.id), user);
      const archiveBytes = await boundedBytes(file, INPUT_MAX);
      const rows = await listArchiveBytes(archiveBytes, password, deadline); checkArchiveLimits(rows);
      const temp = await mkdtemp(join(tmpdir(), 'flux-archive-test-'));
      try {
        const input = join(temp, 'input.archive'); await writeFile(input, archiveBytes);
        const args = ['t', '-bd', '-y']; if (password) args.push(`-p${password}`); args.push('--', input);
        try { await run7z(args, { cwd: temp, timeout: timeLeft(deadline) }); }
        catch (err: any) { throw new Error(archiveError(err)); }
        res.json({ ok: true, entries: rows.length });
      } finally { await rm(temp, { recursive: true, force: true }); }
    }, res);
  });

  app.post('/api/archives/create', async (req: Request, res: Response) => {
    const user = auth(req, res); if (!user) return;
    await runJob(user.id, async (deadline) => {
      const prisma = getPrisma();
      const fileIds = idsOf(req.body?.fileIds);
      const folderIds = idsOf(req.body?.folderIds);
      if (!fileIds.length && !folderIds.length) throw new Error('Выберите файлы или папки для архива');
      const format = req.body?.format;
      if (format !== 'zip' && format !== '7z') throw new Error('Формат архива — ZIP или 7z');
      const password = passwordOf(req.body);
      const recurse = req.body?.recurse !== false;
      const files: Array<{ row: any; path: string }> = [];
      const dirs: string[] = [];
      const roots: any[] = [];
      let homeFolderId: string | null = null;
      let homeHint: { scope: string; ownerId: string | null } | undefined;
      let inputBytes = 0;
      const addFile = async (row: any, path: string) => {
        if (row.deletedAt || row.type === 'CHAT_FILE' || !(await canReadFile(prisma, user, row))) throw new Error(FILE_NOT_FOUND);
        const safePath = safeArchivePath(path);
        if (Number(row.size || 0) > INPUT_MAX - inputBytes) throw new Error('Общий размер исходных файлов превышает предел 256 МБ');
        inputBytes += Number(row.size || 0);
        files.push({ row, path: safePath });
      };
      for (const id of fileIds) {
        const row = await prisma.fileNode.findUnique({ where: { id } });
        if (!row) throw new Error(FILE_NOT_FOUND);
        if (files.length === 0 && roots.length === 0) { homeFolderId = row.folderId; homeHint = { scope: row.scope || 'SHARED', ownerId: row.ownerId || null }; }
        await addFile(row, String(row.name || ''));
      }
      for (const id of folderIds) {
        const folder = await prisma.folder.findUnique({ where: { id } });
        if (!folder || folder.deletedAt || !(await canAccessFolder(prisma, user, id))) throw new Error('Папка не найдена');
        if (files.length === 0 && roots.length === 0) {
          // Root folders have no parent: save inside that root so a system disk
          // keeps its `disk.write` gate and personal scope stays attached.
          homeFolderId = folder.parentId || folder.id;
          const parent = folder.parentId ? await prisma.folder.findUnique({ where: { id: folder.parentId }, select: { scope: true, ownerId: true } }) : null;
          homeHint = { scope: parent?.scope || folder.scope || 'SHARED', ownerId: parent?.ownerId || folder.ownerId || null };
        }
        roots.push(folder);
      }
      const walk = async (folder: any, prefix: string, depth: number) => {
        if (depth > 64 || files.length >= ENTRY_MAX) throw new Error('В архиве слишком много элементов');
        const folderPath = safeArchivePath(`${prefix}${folder.name}`);
        dirs.push(folderPath);
        if (files.length + dirs.length > ENTRY_MAX) throw new Error('В архиве слишком много элементов');
        const children = await prisma.fileNode.findMany({ where: { folderId: folder.id, deletedAt: null }, orderBy: { name: 'asc' } });
        for (const row of children) await addFile(row, `${folderPath}/${row.name}`);
        if (recurse) {
          const dirs = await prisma.folder.findMany({ where: { parentId: folder.id, deletedAt: null }, orderBy: { name: 'asc' } });
          for (const child of dirs) {
            if (!(await canAccessFolder(prisma, user, child.id))) throw new Error('Папка не найдена');
            await walk(child, `${folderPath}/`, depth + 1);
          }
        }
      };
      for (const folder of roots) await walk(folder, '', 0);
      if (!files.length && !dirs.length) throw new Error('Нет элементов для добавления в архив');
      if (files.length + dirs.length > ENTRY_MAX) throw new Error('В архиве слишком много элементов');
      if (!(await folderWritable(user, homeFolderId, deps.can))) throw new Error('Папка назначения доступна только для чтения');
      const temp = await mkdtemp(join(tmpdir(), 'flux-archive-create-'));
      try {
        const payload = join(temp, 'payload'); await mkdir(payload);
        for (const dir of dirs) await mkdir(resolve(payload, dir), { recursive: true });
        let actualInputBytes = 0;
        for (const item of files) {
          const out = resolve(payload, item.path);
          if (!out.startsWith(`${resolve(payload)}${sep}`)) throw new Error('Небезопасное имя в архиве');
          await mkdir(dirname(out), { recursive: true });
          const body = await fileBytes(item.row);
          if (body.length > INPUT_MAX - actualInputBytes) throw new Error('Общий размер исходных файлов превышает предел 256 МБ');
          actualInputBytes += body.length;
          await writeFile(out, body, { flag: 'wx' });
        }
        const archivePath = join(temp, `out.${format}`);
        const level = Number(req.body?.level ?? 5);
        if (!Number.isInteger(level) || level < 0 || level > 9) throw new Error('Уровень сжатия должен быть от 0 до 9');
        const args = ['a', `-t${format}`, `-mx=${level}`, '-bd', '-y'];
        if (password) args.push(`-p${password}`, ...(format === 'zip' ? ['-mem=AES256'] : ['-mhe=on']));
        args.push(archivePath, '.');
        await run7z(args, { cwd: payload, timeout: timeLeft(deadline) });
        const body = await readFile(archivePath);
        if (body.length > OUTPUT_MAX) throw new Error('Созданный архив превышает предел 512 МБ');
        const home = await destinationHome(homeFolderId, user.id, homeHint);
        const sibling = await siblingNames(home.folderId, home.scope, home.ownerId);
        const firstName = req.body?.name || files[0].row.name || roots[0]?.name || 'Архив';
        if (typeof firstName !== 'string' || /[\\/:*?"<>|\u0000-\u001f]/.test(firstName)) throw new Error('Имя архива содержит недопустимые знаки');
        const name = uniqueName(firstName.replace(/\.[^.]+$/, ''), `.${format}`, sibling);
        const made = await createInHome(name, body, home, user.id, await deps.chunkBytes());
        res.json(made);
      } finally { await rm(temp, { recursive: true, force: true }); }
    }, res);
  });

  /** Edit a ZIP/7z into a sibling copy; the submitted base hash is a CAS guard. */
  app.post('/api/archives/:id/edit-preview', async (req: Request, res: Response) => {
    const user = auth(req, res); if (!user) return;
    await runJob(user.id, async (deadline) => {
      const file = await getEditableArchive(String(req.params.id), user);
      const plan = await prepareEdit(file, user, req.body, deadline);
      const home = await destinationHome(file.folderId || null, user.id, { scope: file.scope || 'SHARED', ownerId: file.ownerId || null });
      if (!(await folderWritable(user, home.folderId, deps.can))) throw new Error('Папка назначения доступна только для чтения');
      const names = await siblingNames(home.folderId, home.scope, home.ownerId);
      const outputName = uniqueName(file.name.replace(/\.[^.]+$/, ''), extname(file.name), names);
      res.json({ baseSha256: plan.baseSha256, previewSha256: plan.previewSha256, outputName, encrypted: !!plan.passwordOut, entries: plan.entries.map(({ path, size, directory }) => ({ path, size, directory })) });
    }, res);
  });

  app.post('/api/archives/:id/edit-apply', async (req: Request, res: Response) => {
    const user = auth(req, res); if (!user) return;
    await runJob(user.id, async (deadline) => {
      const file = await getEditableArchive(String(req.params.id), user);
      const plan = await prepareEdit(file, user, req.body, deadline);
      if (req.body?.baseSha256 !== plan.baseSha256 || req.body?.previewSha256 !== plan.previewSha256) {
        throw new Error('Предпросмотр устарел. Сформируйте план правки ещё раз');
      }
      const home = await destinationHome(file.folderId || null, user.id, { scope: file.scope || 'SHARED', ownerId: file.ownerId || null });
      if (!(await folderWritable(user, home.folderId, deps.can))) throw new Error('Папка назначения доступна только для чтения');
      const temp = await mkdtemp(join(tmpdir(), 'flux-archive-edit-'));
      try {
        const input = join(temp, `input.${plan.format}`); await writeFile(input, plan.sourceBytes);
        const extracted = join(temp, 'source'); await mkdir(extracted);
        const extractArgs = ['x', '-bd', '-y', `-o${extracted}`];
        if (plan.passwordIn) extractArgs.push(`-p${plan.passwordIn}`);
        extractArgs.push('--', input);
        await run7zBounded(extractArgs, extracted, { bytes: OUTPUT_MAX, entries: ENTRY_MAX, timeoutMs: timeLeft(deadline) });
        const actual = await directoryFiles(extracted);
        const originalFiles = plan.originalEntries.filter((x) => !x.directory);
        if (actual.length !== originalFiles.length) throw new Error('Архив повреждён: состав файлов не совпал');
        for (const row of originalFiles) {
          const onDisk = actual.find((x) => x.path.toLocaleLowerCase('en-US') === row.path.toLocaleLowerCase('en-US'));
          if (!onDisk || onDisk.size !== row.size) throw new Error('Архив повреждён: размер файла не совпал');
        }
        const payload = join(temp, 'payload'); await mkdir(payload);
        for (const entry of plan.entries.filter((x) => x.directory)) {
          const out = resolve(payload, entry.path);
          if (!out.startsWith(`${resolve(payload)}${sep}`)) throw new Error('Небезопасное имя в архиве');
          await mkdir(out, { recursive: true });
        }
        for (const row of originalFiles) {
          const target = plan.mappedPaths.get(row.path);
          if (!target) continue;
          const sourcePath = resolve(extracted, row.path); const outputPath = resolve(payload, target);
          if (!outputPath.startsWith(`${resolve(payload)}${sep}`)) throw new Error('Небезопасное имя в архиве');
          await mkdir(dirname(outputPath), { recursive: true });
          await copyFile(sourcePath, outputPath);
        }
        for (const added of plan.addedFiles) {
          const out = resolve(payload, added.path);
          if (!out.startsWith(`${resolve(payload)}${sep}`)) throw new Error('Небезопасное имя в архиве');
          await writeFile(out, added.bytes, { flag: 'wx' });
        }
        const output = join(temp, `edited.${plan.format}`);
        const args = ['a', `-t${plan.format}`, '-mx=5', '-bd', '-y'];
        if (plan.passwordOut) args.push(`-p${plan.passwordOut}`, ...(plan.format === 'zip' ? ['-mem=AES256'] : ['-mhe=on']));
        args.push(output, '.');
        await run7z(args, { cwd: payload, timeout: timeLeft(deadline) });
        const bytes = await readFile(output);
        if (bytes.length > OUTPUT_MAX) throw new Error('Созданный архив превышает предел 512 МБ');
        const verify = await listArchive(output, plan.passwordOut, timeLeft(deadline));
        checkArchiveLimits(verify);
        if (!sameEntries(verify, plan.entries)) throw new Error('Не удалось проверить изменённый архив');
        const made = await createInHome(file.name, bytes, home, user.id, await deps.chunkBytes());
        res.json({ ...made, sourceId: file.id, baseSha256: plan.baseSha256 });
      } finally { await rm(temp, { recursive: true, force: true }); }
    }, res);
  });

  app.post('/api/archives/:id/extract-preview', async (req: Request, res: Response) => {
    const user = auth(req, res); if (!user) return;
    await runJob(user.id, async (deadline) => {
      const file = await getReadableArchive(String(req.params.id), user);
      const password = passwordOf(req.body);
      const archiveBytes = await boundedBytes(file, INPUT_MAX);
      const all = await listArchiveBytes(archiveBytes, password, deadline); checkArchiveLimits(all);
      const selected = selectEntries(all, req.body?.paths);
      const folderName = await extractedFolderName(file, user.id);
      const sha = planHash(file, selected, folderName, createHash('sha256').update(archiveBytes).digest('hex'));
      res.json({ folderName, sha256: sha, entries: selected.map(({ path, size, directory }) => ({ path, size, directory })) });
    }, res);
  });

  app.post('/api/archives/:id/extract', async (req: Request, res: Response) => {
    const user = auth(req, res); if (!user) return;
    await runJob(user.id, async (deadline) => {
      const prisma = getPrisma();
      const file = await getReadableArchive(String(req.params.id), user);
      const password = passwordOf(req.body);
      const archiveBytes = await boundedBytes(file, INPUT_MAX);
      const all = await listArchiveBytes(archiveBytes, password, deadline); checkArchiveLimits(all);
      const selected = selectEntries(all, req.body?.paths);
      const folderName = await extractedFolderName(file, user.id);
      const contentSha = createHash('sha256').update(archiveBytes).digest('hex');
      if (typeof req.body?.previewSha256 !== 'string' || req.body.previewSha256 !== planHash(file, selected, folderName, contentSha)) throw new Error('Предпросмотр устарел. Сформируйте план распаковки ещё раз');
      const parentId = file.folderId || null;
      if (!(await folderWritable(user, parentId, deps.can))) throw new Error('Папка назначения доступна только для чтения');
      const temp = await mkdtemp(join(tmpdir(), 'flux-archive-extract-'));
      try {
        const input = join(temp, `input${extname(file.name) || '.archive'}`);
        await writeFile(input, archiveBytes);
        const output = join(temp, 'out'); await mkdir(output);
        const args = ['x', '-bd', '-y', `-o${output}`]; if (password) args.push(`-p${password}`);
        args.push('--', input);
        try { await run7zBounded(args, output, { bytes: OUTPUT_MAX, entries: ENTRY_MAX, timeoutMs: timeLeft(deadline) }); }
        catch (err: any) { throw new Error(archiveError(err)); }
        const extracted = await directoryFiles(output);
        let total = 0;
        const allowed = new Set(selected.filter((x) => !x.directory).map((x) => x.path.toLocaleLowerCase('en-US')));
        const chosen = extracted.filter((x) => allowed.has(safeArchivePath(x.path).toLocaleLowerCase('en-US')));
        if (chosen.length !== allowed.size) throw new Error('Архив повреждён: состав распаковки изменился');
        for (const entry of chosen) {
          total += entry.size;
          if (total > OUTPUT_MAX) throw new Error('Распакованный архив превышает предел 512 МБ');
          const listed = selected.find((x) => x.path.toLocaleLowerCase('en-US') === entry.path.toLocaleLowerCase('en-US'))!;
          if (entry.size !== listed.size) throw new Error('Архив повреждён: размер файла не совпал');
        }
        if (!chosen.length && !selected.some((x) => x.directory)) throw new Error('Выберите файлы или папки для распаковки');
        const home = await destinationHome(parentId, user.id, { scope: file.scope || 'SHARED', ownerId: file.ownerId || null });
        const siblings = await siblingNames(parentId, home.scope, home.ownerId);
        const freeFolderName = uniqueName(folderName, '', siblings);
        const projectId = home.projectId || await resolveProjectId('default');
        const result = await createExtracted(prisma, home, projectId, freeFolderName, selected, chosen, output, user.id, await deps.chunkBytes());
        res.json(result);
      } finally { await rm(temp, { recursive: true, force: true }); }
    }, res);
  });
}

async function listArchiveOnFile(file: any, password: string | undefined, deadline: number): Promise<ArchiveEntry[]> {
  return listArchiveBytes(await boundedBytes(file, INPUT_MAX), password, deadline);
}

async function listArchiveBytes(bytes: Buffer, password: string | undefined, deadline: number): Promise<ArchiveEntry[]> {
  const temp = await mkdtemp(join(tmpdir(), 'flux-archive-list-'));
  try {
    const input = join(temp, 'input.archive'); await writeFile(input, bytes);
    try { return await listArchive(input, password, timeLeft(deadline)); }
    catch (err: any) {
      const message = String(err?.message || '');
      if (/^(Архив содержит|Многотомные архивы|Пароль неверен|Небезопасное имя|В архиве|Распакованный архив|Повреждённое содержимое)/.test(message)) throw err;
      throw new Error('Архив повреждён или имеет неподдерживаемый формат');
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
}

interface EditPlan {
  format: 'zip' | '7z';
  sourceBytes: Buffer;
  baseSha256: string;
  previewSha256: string;
  originalEntries: ArchiveEntry[];
  entries: ArchiveEntry[];
  mappedPaths: Map<string, string>;
  addedFiles: Array<{ id: string; path: string; bytes: Buffer; sha256: string }>;
  passwordIn?: string;
  passwordOut?: string;
}

async function getEditableArchive(id: string, user: any): Promise<any> {
  const file = await getReadableArchive(id, user);
  if (!/\.(zip|7z)$/i.test(String(file.name || ''))) throw new Error('Править можно только ZIP и 7z. RAR доступен только для чтения');
  return file;
}

function optionalPaths(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > ENTRY_MAX || value.some((x) => typeof x !== 'string' || !x || x.length > 1024)) throw new Error('Некорректный список путей архива');
  return [...new Set((value as string[]).map(safeArchivePath))];
}

async function prepareEdit(file: any, user: any, body: any, deadline: number): Promise<EditPlan> {
  const format = extname(String(file.name)).slice(1).toLowerCase() as 'zip' | '7z';
  const passwordIn = passwordOf({ password: body?.passwordIn });
  const hasPasswordOut = Object.prototype.hasOwnProperty.call(body || {}, 'passwordOut');
  const passwordOut = hasPasswordOut ? passwordOf({ password: body.passwordOut }) : passwordIn;
  const deletePaths = optionalPaths(body?.deletePaths);
  const addIds = body?.addFileIds === undefined || body?.addFileIds === null ? [] : idsOf(body.addFileIds);
  const rawRename = body?.rename === undefined || body?.rename === null ? {} : body.rename;
  if (!rawRename || typeof rawRename !== 'object' || Array.isArray(rawRename) || Object.keys(rawRename).length > ENTRY_MAX) throw new Error('Некорректная карта переименования');
  const renames = new Map<string, string>();
  const renameSourceKeys = new Set<string>();
  for (const [fromRaw, toRaw] of Object.entries(rawRename)) {
    if (typeof toRaw !== 'string') throw new Error('Некорректная карта переименования');
    const from = safeArchivePath(fromRaw);
    const key = from.toLocaleLowerCase('en-US');
    if (renameSourceKeys.has(key)) throw new Error('Путь переименован более одного раза');
    renameSourceKeys.add(key);
    renames.set(from, safeArchivePath(toRaw));
  }
  if (!deletePaths.length && !renames.size && !addIds.length) throw new Error('Выберите удаление, переименование или добавление файла');
  const sourceBytes = await boundedBytes(file, INPUT_MAX);
  const baseSha256 = createHash('sha256').update(sourceBytes).digest('hex');
  if (body?.baseSha256 !== undefined && body.baseSha256 !== baseSha256) throw new Error('Исходный архив изменился. Сформируйте план правки ещё раз');
  const originalEntries = await listArchiveBytes(sourceBytes, passwordIn, deadline);
  checkArchiveLimits(originalEntries);
  const byPath = new Map(originalEntries.map((x) => [x.path.toLocaleLowerCase('en-US'), x]));
  const hasSubtree = (key: string) => originalEntries.some((x) => x.path.toLocaleLowerCase('en-US').startsWith(`${key}/`));
  const deleted = new Set(deletePaths.map((x) => x.toLocaleLowerCase('en-US')));
  for (const path of deleted) if (!byPath.has(path) && !hasSubtree(path)) throw new Error('Элемент не найден в архиве');
  const renameDirs = new Set<string>();
  for (const [from] of renames) {
    const source = from.toLocaleLowerCase('en-US');
    if ([...deleted].some((del) => del === source || del.startsWith(`${source}/`) || source.startsWith(`${del}/`))) throw new Error('Путь нельзя одновременно удалить и переименовать');
    const found = byPath.get(from.toLocaleLowerCase('en-US'));
    if (!found && !hasSubtree(from.toLocaleLowerCase('en-US'))) throw new Error('Элемент не найден в архиве');
    if (found?.directory || hasSubtree(from.toLocaleLowerCase('en-US'))) renameDirs.add(from.toLocaleLowerCase('en-US'));
  }
  const renameKeys = [...renames.keys()].map((x) => x.toLocaleLowerCase('en-US'));
  for (let i = 0; i < renameKeys.length; i++) for (let j = i + 1; j < renameKeys.length; j++) {
    if (renameKeys[i].startsWith(`${renameKeys[j]}/`) || renameKeys[j].startsWith(`${renameKeys[i]}/`)) throw new Error('Не переименовывайте родительскую папку и её элемент одновременно');
  }
  const isDeleted = (path: string) => {
    const key = path.toLocaleLowerCase('en-US');
    return [...deleted].some((del) => key === del || key.startsWith(`${del}/`));
  };
  const mappedPaths = new Map<string, string>();
  const entries: ArchiveEntry[] = [];
  const sortedRenames = [...renames.entries()].sort((a, b) => b[0].length - a[0].length);
  for (const entry of originalEntries) {
    if (isDeleted(entry.path)) continue;
    let target = entry.path;
    for (const [from, to] of sortedRenames) {
      const key = entry.path.toLocaleLowerCase('en-US'); const source = from.toLocaleLowerCase('en-US');
      if (key === source) { target = to; break; }
      if (renameDirs.has(source) && key.startsWith(`${source}/`)) { target = `${to}/${entry.path.slice(from.length + 1)}`; break; }
    }
    target = safeArchivePath(target);
    entries.push({ ...entry, path: target });
    if (!entry.directory) mappedPaths.set(entry.path, target);
  }
  const addedFiles: EditPlan['addedFiles'] = [];
  let inputTotal = sourceBytes.length;
  const prisma = getPrisma();
  for (const id of addIds) {
    if (id === file.id) throw new Error('Нельзя добавить архив в копию самого себя');
    const row = await prisma.fileNode.findUnique({ where: { id } });
    if (!row || row.deletedAt || row.type === 'CHAT_FILE' || !(await canReadFile(prisma, user, row))) throw new Error(FILE_NOT_FOUND);
    if (/[\\/]/.test(String(row.name || ''))) throw new Error('Имя добавляемого файла недопустимо');
    const path = safeArchivePath(String(row.name || ''));
    const bytes = await fileBytes(row);
    if (bytes.length > INPUT_MAX - inputTotal) throw new Error('Общий размер исходных данных превышает предел 256 МБ');
    inputTotal += bytes.length;
    addedFiles.push({ id, path, bytes, sha256: createHash('sha256').update(bytes).digest('hex') });
    entries.push({ path, size: bytes.length, directory: false, encrypted: !!passwordOut });
  }
  validateEditedEntries(entries);
  checkArchiveLimits(entries);
  const payload = {
    baseSha256, format, deletePaths: [...deleted].sort(),
    rename: [...renames.entries()].sort(([a], [b]) => a.localeCompare(b)),
    added: addedFiles.map(({ id, path, bytes, sha256 }) => ({ id, path, size: bytes.length, sha256 })),
    encrypted: !!passwordOut, entries,
  };
  const previewSha256 = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  return { format, sourceBytes, baseSha256, previewSha256, originalEntries, entries, mappedPaths, addedFiles, passwordIn, passwordOut };
}

function validateEditedEntries(entries: ArchiveEntry[]): void {
  const kinds = new Map<string, boolean>();
  for (const entry of entries) {
    const key = safeArchivePath(entry.path).toLocaleLowerCase('en-US');
    if (kinds.has(key)) throw new Error('Правка создаёт совпадающие имена в архиве');
    const parts = key.split('/'); parts.pop();
    for (let i = 1; i <= parts.length; i++) if (kinds.get(parts.slice(0, i).join('/')) === false) throw new Error('Правка создаёт несовместимые пути');
    if (!entry.directory && [...kinds.keys()].some((x) => x.startsWith(`${key}/`))) throw new Error('Правка создаёт несовместимые пути');
    kinds.set(key, entry.directory);
  }
}

function sameEntries(a: ArchiveEntry[], b: ArchiveEntry[]): boolean {
  if (a.length !== b.length) return false;
  const project = (xs: ArchiveEntry[]) => xs.map(({ path, size, directory }) => `${path.toLocaleLowerCase('en-US')}\0${size}\0${directory}`).sort();
  return project(a).every((x, i) => x === project(b)[i]);
}

function selectEntries(all: ArchiveEntry[], paths: unknown): ArchiveEntry[] {
  if (paths === undefined || paths === null) return all;
  const asked = idsOf(paths).map(safeArchivePath);
  if (!asked.length) throw new Error('Выберите элементы архива');
  const keys = new Set(asked.map((x) => x.toLocaleLowerCase('en-US')));
  for (const key of keys) {
    if (!all.some((entry) => entry.path.toLocaleLowerCase('en-US') === key || entry.path.toLocaleLowerCase('en-US').startsWith(`${key}/`))) {
      throw new Error('Элемент не найден в архиве');
    }
  }
  const selected = all.filter((entry) => keys.has(entry.path.toLocaleLowerCase('en-US')) || [...keys].some((key) => entry.path.toLocaleLowerCase('en-US').startsWith(`${key}/`)));
  if (!selected.length || selected.some((x) => !all.includes(x))) throw new Error('Элемент не найден в архиве');
  return selected;
}

async function extractedFolderName(file: any, userId: string): Promise<string> {
  const base = basename(String(file.name), extname(String(file.name))).replace(/\.[^.]+$/, '') || 'Архив';
  const home = await destinationHome(file.folderId || null, userId, { scope: file.scope || 'SHARED', ownerId: file.ownerId || null });
  const names = await siblingNames(home.folderId, home.scope, home.ownerId);
  return uniqueName(`${base} (извлечено)`, '', names);
}

function planHash(file: any, entries: ArchiveEntry[], folderName: string, contentSha: string): string {
  return createHash('sha256').update(JSON.stringify({ id: file.id, contentSha, folderName, entries })).digest('hex');
}

async function destinationHome(folderId: string | null, _userId: string, hint?: { scope: string; ownerId: string | null }): Promise<any> {
  if (!folderId) return { folderId: null, scope: hint?.scope || 'SHARED', ownerId: hint?.ownerId || null, dir: hint?.scope === 'PERSONAL' ? '/personal/' : '/shared/' };
  const folder = await getPrisma().folder.findUnique({ where: { id: folderId }, select: { id: true, scope: true, ownerId: true, projectId: true } });
  if (!folder) throw new Error('Папка назначения не найдена');
  return { folderId, scope: folder.scope || 'SHARED', ownerId: folder.ownerId || null, projectId: folder.projectId, dir: folder.scope === 'PERSONAL' ? '/personal/' : '/shared/' };
}

async function createInHome(name: string, body: Buffer, home: any, userId: string, chunkBytes: number): Promise<any> {
  const prisma = getPrisma();
  const step = Math.max(64 * 1024, chunkBytes);
  return prisma.$transaction(async (tx: any) => {
    const siblings = await tx.fileNode.findMany({ where: { folderId: home.folderId, scope: home.scope, ownerId: home.ownerId, deletedAt: null }, select: { name: true } });
    const folders = await tx.folder.findMany({ where: { parentId: home.folderId, scope: home.scope, ownerId: home.ownerId, deletedAt: null }, select: { name: true } });
    const taken = new Set([...siblings, ...folders].map((x: any) => String(x.name).toLowerCase()));
    const actual = uniqueName(name.replace(/\.(zip|7z)$/i, ''), extname(name), taken);
    const row = await tx.fileNode.create({ data: { name: actual, filePath: `${home.dir}${actual}`, size: body.length, type: 'FILE', department: 'Unassigned', scope: home.scope, ownerId: home.ownerId, folderId: home.folderId, createdById: userId, updatedById: userId } });
    for (let i = 0, idx = 0; i < body.length; i += step, idx++) await tx.fileChunk.create({ data: { fileId: row.id, idx, data: body.subarray(i, i + step) } });
    return { id: row.id, name: row.name, size: body.length, folderId: row.folderId };
  }, { timeout: TIMEOUT });
}

async function createExtracted(prisma: any, home: any, projectId: string, rootName: string, selected: ArchiveEntry[], files: Array<{ path: string; size: number; full: string }>, root: string, userId: string, chunkBytes: number): Promise<any> {
  const contents: Array<{ path: string; bytes: Buffer }> = [];
  for (const item of files) contents.push({ path: safeArchivePath(item.path), bytes: await readFile(item.full) });
  const step = Math.max(64 * 1024, chunkBytes);
  return prisma.$transaction(async (tx: any) => {
    const parent = home.folderId ? await tx.folder.findUnique({ where: { id: home.folderId } }) : null;
    const allSiblingFolders = await tx.folder.findMany({ where: { parentId: home.folderId, scope: home.scope, ownerId: home.ownerId, deletedAt: null }, select: { name: true } });
    const allSiblingFiles = await tx.fileNode.findMany({ where: { folderId: home.folderId, scope: home.scope, ownerId: home.ownerId, deletedAt: null }, select: { name: true } });
    const occupied = new Set([...allSiblingFolders, ...allSiblingFiles].map((x: any) => String(x.name).toLowerCase()));
    const free = uniqueName(rootName, '', occupied);
    const actualProjectId = parent?.projectId || projectId;
    if (!actualProjectId) throw new Error('Папка назначения не найдена');
    const rootFolder = await tx.folder.create({ data: { name: free, projectId: actualProjectId, parentId: home.folderId, scope: home.scope, ownerId: home.ownerId } });
    const dirs = new Map<string, string>([['', rootFolder.id]]);
    const madeFiles: Array<{ id: string; name: string; size: number; path: string }> = [];
    const directoryPaths = new Set<string>();
    for (const entry of selected) if (entry.directory) directoryPaths.add(safeArchivePath(entry.path));
    for (const item of contents) {
      const parts = item.path.split('/'); parts.pop();
      let acc = '';
      for (const part of parts) { acc = acc ? `${acc}/${part}` : part; directoryPaths.add(acc); }
    }
    for (const path of [...directoryPaths].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))) {
      let parentId = rootFolder.id; let acc = '';
      for (const part of path.split('/')) {
        acc = acc ? `${acc}/${part}` : part;
        let id = dirs.get(acc);
        if (!id) {
          const f = await tx.folder.create({ data: { name: part, projectId: actualProjectId, parentId, scope: home.scope, ownerId: home.ownerId } });
          id = f.id; dirs.set(acc, id);
        }
        parentId = id;
      }
    }
    for (const item of contents) {
      const parts = item.path.split('/');
      const leaf = parts.pop()!;
      let parentId = rootFolder.id;
      let acc = '';
      for (const part of parts) {
        acc = acc ? `${acc}/${part}` : part;
        let id = dirs.get(acc);
        if (!id) {
          const f = await tx.folder.create({ data: { name: part, projectId: actualProjectId, parentId, scope: home.scope, ownerId: home.ownerId } });
          id = f.id; dirs.set(acc, id);
        }
        parentId = id;
      }
      const pathName = `${home.dir}${free}/${item.path}`;
      const row = await tx.fileNode.create({ data: { name: leaf, filePath: pathName, size: item.bytes.length, type: 'FILE', department: 'Unassigned', scope: home.scope, ownerId: home.ownerId, folderId: parentId, createdById: userId, updatedById: userId } });
      for (let i = 0, idx = 0; i < item.bytes.length; i += step, idx++) await tx.fileChunk.create({ data: { fileId: row.id, idx, data: item.bytes.subarray(i, i + step) } });
      madeFiles.push({ id: row.id, name: row.name, size: row.size, path: item.path });
    }
    return { folderId: rootFolder.id, folderName: free, files: madeFiles };
  }, { timeout: TIMEOUT });
}
