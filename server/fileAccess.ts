import { isPrivilegedUser } from './accessPolicy.js';
/**
 * Кто и какой файл может читать и менять.
 *
 * Зачем отдельный модуль. Видимость файлов решалась только в одном месте —
 * при сборке списка Проводника (server/routes/explorer.ts). Маршруты, которые
 * берут файл по номеру (`/api/files/:id`, `/raw`, редакторы Flux Office,
 * версии, перенос), правило не повторяли: личный файл, скрытый в списке,
 * отдавался любому вошедшему, кто знал или угадал его номер. Номера видны в
 * ссылках, в письмах и в журнале, так что «не показывается в списке» защитой
 * не было.
 *
 * Правило здесь одно и ровно то же, что у списка:
 *   - личное (scope PERSONAL) видит владелец и Главный Администратор — самый
 *     первый созданный администратор; остальные администраторы личное чужих
 *     в списке не видят, поэтому и по номеру не получают;
 *   - файл в папке наследует видимость папки и проекта;
 *   - проект с составом виден только его участникам (canSeeProject).
 *
 * Отказ всегда выглядит как «не найдено»: ответ «это чужой файл» сам
 * подтверждает, что такой номер существует.
 *
 * Чистая часть (decideFileAccess, personalScopeWhere, patchFileFields) не
 * ходит в базу — её проверяет scripts/test-file-access.ts без сервера. База
 * берётся тем, кто вызывает: клиент Prisma пересоздаётся при смене базы, и
 * держать его в модуле нельзя (см. server/context.ts).
 */
import { canSeeProject, hiddenProjectsOf } from './routes/members.js';

/** Кто действует. Берётся только из сессии (authUser), никогда из запроса */
export interface Actor { id?: string | null; role?: string | null }

export interface FileFacts {
  id?: string;
  scope?: string | null;
  ownerId?: string | null;
  folderId?: string | null;
  type?: string | null;
  createdById?: string | null;
}

export interface FolderFacts {
  scope?: string | null;
  ownerId?: string | null;
  projectId?: string | null;
}

export const FILE_NOT_FOUND = 'Файл не найден';
export const FOLDER_NOT_FOUND = 'Папка не найдена';

/**
 * Главный Администратор — единственный: самый первый созданный
 * пользователь с ролью ADMIN. Выданная позже роль администратора главным не
 * делает. Именно он видит в Проводнике все личные разделы.
 */
export async function getMainAdminId(prisma: any): Promise<string | null> {
  try {
    const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' }, orderBy: { createdAt: 'asc' }, select: { id: true } });
    return admin ? admin.id : null;
  } catch {
    return null;
  }
}

/** Личное видно владельцу и Главному Администратору; общее — всем */
export function personalVisible(
  user: Actor | null | undefined, mainAdminId: string | null, scope?: string | null, ownerId?: string | null,
): boolean {
  if (scope !== 'PERSONAL') return true;
  if (!user?.id) return false;
  if (mainAdminId && user.id === mainAdminId) return true;
  // Личное без владельца — ничьё; видит его только Главный Администратор,
  // как и в списке
  return !!ownerId && ownerId === user.id;
}

/**
 * Условие Prisma «эти личные записи человеку видны» — то самое, по которому
 * собирается список Проводника. Вынесено, чтобы корзина, рабочий стол и
 * список не разошлись в том, кому что показывать.
 */
export function personalScopeWhere(user: Actor | null | undefined, mainAdminId: string | null): any {
  if (user?.id && mainAdminId && user.id === mainAdminId) return {};
  if (user?.id) return { OR: [{ scope: { not: 'PERSONAL' } }, { ownerId: user.id }] };
  return { scope: { not: 'PERSONAL' } };
}

/**
 * Решение по одному файлу. Чистая функция: всё, что нужно знать о базе, уже
 * передано в аргументах.
 */
export function decideFileAccess(a: {
  user: Actor | null | undefined;
  mainAdminId: string | null;
  file: FileFacts | null | undefined;
  /** Папка файла; null — файл в корне раздела */
  folder: FolderFacts | null | undefined;
  /** Виден ли пользователю проект папки; для файла в корне — true */
  projectVisible: boolean;
}): boolean {
  const { user, mainAdminId, file, folder } = a;
  if (!user?.id || !file) return false;
  // Вложения чата читаются только участниками переписки, через /chat_files
  if (file.type === 'CHAT_FILE') return false;
  if (!personalVisible(user, mainAdminId, file.scope, file.ownerId)) return false;
  // Раздел файла в папке определяет папка: список показывает файлы внутри
  // видимой папки, не глядя на их собственную отметку
  if (folder && !personalVisible(user, mainAdminId, folder.scope, folder.ownerId)) return false;
  return a.projectVisible;
}

const FILE_SELECT = { id: true, scope: true, ownerId: true, folderId: true, type: true, createdById: true };

async function factsOf(prisma: any, file: FileFacts | string | null | undefined): Promise<FileFacts | null> {
  if (!file) return null;
  if (typeof file !== 'string') return file;
  try { return await prisma.fileNode.findUnique({ where: { id: file }, select: FILE_SELECT }); } catch { return null; }
}

async function folderFactsOf(prisma: any, folderId: string | null | undefined): Promise<FolderFacts | null> {
  if (!folderId) return null;
  try {
    return await prisma.folder.findUnique({ where: { id: folderId }, select: { scope: true, ownerId: true, projectId: true } });
  } catch { return null; }
}

/** Читает ли пользователь файл. `file` — запись или просто номер */
export async function canReadFile(prisma: any, user: Actor | null | undefined, file: FileFacts | string | null | undefined): Promise<boolean> {
  const f = await factsOf(prisma, file);
  if (!f || !user?.id) return false;
  const folder = await folderFactsOf(prisma, f.folderId);
  const projectVisible = folder?.projectId
    ? await canSeeProject(user.id, folder.projectId, isPrivilegedUser(user))
    : true;
  return decideFileAccess({ user, mainAdminId: await getMainAdminId(prisma), file: f, folder, projectVisible });
}

/**
 * Пишет ли пользователь в файл. Сегодня правило то же, что у чтения: кто не
 * видит файл, тот его и не правит. Право на общий диск — отдельная проверка
 * (deniedOnDisk в explorer.ts, mayWrite в server.ts), она поверх этой.
 * Отдельной функцией, чтобы у записи было где ужесточиться, не трогая чтение.
 */
export async function canWriteFile(prisma: any, user: Actor | null | undefined, file: FileFacts | string | null | undefined): Promise<boolean> {
  return canReadFile(prisma, user, file);
}

/** Видит и может ли класть в папку: чужая личная папка и скрытый проект — нет */
export async function canAccessFolder(prisma: any, user: Actor | null | undefined, folderId: string | null | undefined): Promise<boolean> {
  if (!user?.id) return false;
  if (!folderId) return true;
  const folder = await folderFactsOf(prisma, folderId);
  if (!folder) return false;
  if (!personalVisible(user, await getMainAdminId(prisma), folder.scope, folder.ownerId)) return false;
  return folder.projectId ? canSeeProject(user.id, folder.projectId, isPrivilegedUser(user)) : true;
}

/**
 * Проекты с составом, куда пользователя не звали. Список Проводника исключает
 * их так же, как переключатель проектов, — иначе файл виден в списке, но не
 * открывается, или наоборот. Правило одно на всех — server/routes/members.ts;
 * при сбое проверки оно бросает, и маршрут отвечает ошибкой, а не всем списком.
 */
export async function hiddenProjectIds(_prisma: any, user: Actor | null | undefined): Promise<string[]> {
  return hiddenProjectsOf(String(user?.id || ''), isPrivilegedUser(user));
}

/** Владелец файла для целей смены раздела: хозяин личного, автор общего — или администратор */
export function isFileOwnerOrAdmin(user: Actor | null | undefined, file: FileFacts): boolean {
  if (!user?.id) return false;
  if (isPrivilegedUser(user)) return true;
  if (file.scope === 'PERSONAL') return !!file.ownerId && file.ownerId === user.id;
  return !!file.createdById && file.createdById === user.id;
}

/** Поля, которые клиент вправе менять через PATCH /api/files/:id */
export const FILE_PATCH_FIELDS = ['name', 'revision', 'statusCode', 'department'] as const;

export interface FilePatch {
  /** Готовое `data` для Prisma; пусто, если менять нечего */
  data: Record<string, any>;
  mainTagIds?: string[];
  additionalTagIds?: string[];
  /** Если отказ — код и текст для человека */
  error?: { status: number; message: string };
}

const idList = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every((x) => typeof x === 'string' && x) ? (v as string[]) : null;

/**
 * Белый список полей PATCH файла.
 *
 * Тело запроса раньше уходило в Prisma как есть (`...updateData`): любой
 * вошедший мог одним запросом сменить `scope`/`ownerId` (забрать чужой личный
 * файл или выложить свой в общий), подменить `content`, `filePath`,
 * `createdById`, `deletedAt`. Теперь берётся только то, что реально шлёт окно
 * (имя, ревизия, статус, отдел, теги); раздел и владелец — лишь по праву
 * владельца, а «кто изменил» всегда сессия, а не тело.
 */
export function patchFileFields(
  body: any,
  ctx: { actorId: string; current: FileFacts; ownerOrAdmin: boolean; actorIsMainAdmin?: boolean },
): FilePatch {
  const b = body && typeof body === 'object' ? body : {};
  const data: Record<string, any> = { updatedById: ctx.actorId };
  const bad = (message: string, status = 400): FilePatch => ({ data: {}, error: { status, message } });

  for (const key of FILE_PATCH_FIELDS) {
    if (!(key in b)) continue;
    const v = b[key];
    if (typeof v !== 'string') return bad(`Поле «${key}» должно быть строкой`);
    const s = v.slice(0, 500);
    if (key === 'name' && !s.trim()) return bad('Имя файла не может быть пустым');
    data[key] = s;
  }

  const wantsScope = 'scope' in b;
  const wantsOwner = 'ownerId' in b;
  if (wantsScope || wantsOwner) {
    if (!ctx.ownerOrAdmin) return bad('Раздел и владельца файла меняет только его владелец или администратор', 403);
    const scope = wantsScope ? b.scope : ctx.current.scope;
    if (scope !== 'SHARED' && scope !== 'PERSONAL') return bad('Раздел — SHARED или PERSONAL');
    data.scope = scope;
    if (scope === 'SHARED') {
      data.ownerId = null;
    } else {
      // Чужого владельца назначает только Главный Администратор: он и так
      // видит все личные разделы. Остальные кладут личное только на себя
      const want = wantsOwner && typeof b.ownerId === 'string' && b.ownerId ? b.ownerId : '';
      if (want && want !== ctx.actorId && !ctx.actorIsMainAdmin) {
        return bad('Личным файл можно сделать только своим', 403);
      }
      data.ownerId = want || (ctx.current.scope === 'PERSONAL' && ctx.current.ownerId) || ctx.actorId;
    }
  }

  const out: FilePatch = { data };
  if ('mainTagIds' in b) {
    const ids = idList(b.mainTagIds);
    if (!ids) return bad('mainTagIds — список номеров тегов');
    out.mainTagIds = ids;
  }
  if ('additionalTagIds' in b) {
    const ids = idList(b.additionalTagIds);
    if (!ids) return bad('additionalTagIds — список номеров тегов');
    out.additionalTagIds = ids;
  }
  return out;
}
