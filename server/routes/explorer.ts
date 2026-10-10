import type { Express, Request, Response } from 'express';
import { shareOf, ensureSharing, forgetFileShare } from '../fileSharing.js';
import { getPrisma } from '../context.js';
import { nextProjectId } from '../entityIds.js';
import { ensureDiskProject, ensureDiskRoot } from '../systemFolders.js';
import {
  FILE_NOT_FOUND, FOLDER_NOT_FOUND, canAccessFolder, canReadFile, canWriteFile, canManageFile, getMainAdminId,
  hiddenProjectIds, isFileOwnerOrAdmin, patchFileFields, personalScopeWhere,
} from '../fileAccess.js';

// Кто и какой файл видит — server/fileAccess.ts: одно правило и для списка, и
// для каждого маршрута, что берёт файл по номеру.

/** Безопасные поля сотрудника для подписи «кто изменил»: без хеша пароля */
const WHO = { select: { id: true, name: true, symbol: true } };

// Проводник: папки, файлы и корзина проекта.
//
// Вынесено из server.ts — обработчики самодостаточные и не трогают ни сокеты,
// ни лицензию, ни переключение базы. Prisma берётся лениво через getPrisma():
// клиент пересоздаётся при смене базы, поэтому захватывать его при импорте
// нельзя (см. комментарий в server/context.ts).

// true, если candidateId совпадает с rootId или лежит внутри поддерева rootId.
// Используется, чтобы не дать переместить папку саму в себя/в свою подпапку —
// иначе в parentId возникнет цикл и applyScopeRecursive уйдёт в бесконечную рекурсию.
async function isFolderInSubtree(candidateId: string, rootId: string): Promise<boolean> {
  const prisma = getPrisma();
  let cur: string | null = candidateId;
  const guard = new Set<string>();
  while (cur) {
    if (cur === rootId) return true;
    if (guard.has(cur)) break; // защита от уже существующего цикла в данных
    guard.add(cur);
    const f: { parentId: string | null } | null =
      await prisma.folder.findUnique({ where: { id: cur }, select: { parentId: true } });
    cur = f?.parentId || null;
  }
  return false;
}

// Рекурсивно проставляет раздел (общий/личный) папке, её файлам и подпапкам.
// Вынесено из тела registerExplorerRoutes и экспортируется ради рабочего стола
// (server/routes/desktop.ts): там папку тоже переносят между общим и личным
// разделом, и подпапки обязаны переехать вместе с ней — иначе внутри общей
// папки остаётся личное содержимое, невидимое всем, кроме владельца.
export async function applyScopeRecursive(folderId: string, scope: string, ownerId: string | null) {
  const prisma = getPrisma();
  await prisma.folder.update({ where: { id: folderId }, data: { scope, ownerId } as any });
  await prisma.fileNode.updateMany({ where: { folderId }, data: { scope, ownerId } as any });
  const children = await prisma.folder.findMany({ where: { parentId: folderId } });
  for (const child of children) {
    await applyScopeRecursive(child.id, scope, ownerId);
  }
}

export interface ExplorerDeps {
  /** Есть ли у сотрудника право. Считается там же, где для всех остальных */
  can: (user: any, feature: string) => boolean;
}

export function registerExplorerRoutes(app: Express, deps: ExplorerDeps): void {

/**
 * Запись на общий диск — по праву «Общий диск».
 *
 * Диск виден всем и лежит поверх проектов; если бы писать в него мог кто
 * угодно, он зарос бы за месяц, как всякая общая папка в сети. Проверка стоит
 * НА СЕРВЕРЕ, а не в окне: запрет, который живёт только в разметке, — не
 * запрет, его обходит одна строка в консоли браузера.
 *
 * Возвращает true, если запрос надо прекратить (ответ уже отправлен).
 */
async function deniedOnDisk(req: Request, res: Response, projectId: string | null | undefined): Promise<boolean> {
  if (!projectId) return false;
  const disk = await ensureDiskProject();
  if (projectId !== disk) return false;
  if (deps.can((req as any).authUser, 'disk.write')) return false;
  res.status(403).json({
    error: 'Общий диск открыт всем на чтение, а класть и удалять на нём — по праву «Общий диск». Его выдаёт администратор в разделе «Сотрудники».',
  });
  return true;
}

/**
 * Ограничение корзины файлов проектом.
 *
 * Своего проекта у файла нет — он наследует его от папки, поэтому фильтр идёт
 * через связь. Файл в корне раздела не принадлежит никакому проекту и остаётся
 * общим: его видно в любой корзине, иначе он не виден нигде.
 *
 * Без этого фильтра корзина брала ВСЕ удалённые файлы, а очистка корзины
 * одного проекта стирала удалённое во всех — при том, что рядом стоящий запрос
 * папок проектом ограничен. Расхождение тихое: заметно только тому, кто
 * хватился чужого файла.
 */
function trashFileWhere(projectWhere: any): any {
  const projectId = projectWhere?.projectId;
  if (!projectId) return {};
  return { OR: [{ folder: { projectId } }, { folderId: null }] };
}

/** В каком проекте лежит папка или файл — по нему и решается право диска */
async function projectOfFolder(folderId: string | null | undefined): Promise<string | null> {
  if (!folderId) return null;
  const row = await getPrisma().folder.findUnique({ where: { id: folderId }, select: { projectId: true } });
  return row?.projectId || null;
}

async function projectOfFile(fileId: string): Promise<string | null> {
  const row = await getPrisma().fileNode.findUnique({ where: { id: fileId }, select: { folderId: true } });
  return projectOfFolder(row?.folderId);
}

// Folders & Files (Explorer)

app.get('/api/projects/:projectId/folders', async (req: Request, res: Response) => {
  const prisma = getPrisma();
  const { projectId } = req.params;
  // Кто смотрит — только из сессии. Раньше это был `?actorId=` из запроса: подставив
  // номер Главного Администратора, любой вошедший получал все личные разделы
  const me = (req as any).authUser || null;
  const actorId = String(me?.id || '');
  try {
    const specific = !(!projectId || projectId === 'null' || projectId === 'undefined' || projectId === 'default');
    // Проекты с составом, куда человека не звали, в списке не показываются —
    // так же, как в переключателе проектов: иначе файлы такого проекта видны
    // в Проводнике при закрытом самом проекте
    const hidden = await hiddenProjectIds(prisma, me);
    const hiddenHere = specific && hidden.includes(projectId);
    const projectWhere = specific ? { projectId } : hidden.length ? { projectId: { notIn: hidden } } : {};

    // Диск заводим ДО запроса дерева: иначе при самом первом открытии его
    // корень в ответ не попадёт, и диск покажется пустым
    const diskProjectId = await ensureDiskProject();
    const diskRoot = await ensureDiskRoot();

    const mainAdminId = await getMainAdminId(prisma);
    const isMainAdmin = !!actorId && actorId === mainAdminId;

    // Личные папки/файлы видит только их владелец; Главный Администратор видит все
    const scopeWhere = personalScopeWhere(me, mainAdminId);

    // Удалённое лежит в корзине и в обычных списках не показывается
    // Содержимое в дерево не кладём. Раньше оно ехало вместе со списком — на
    // сотне чертежей это десятки мегабайт в каждом обновлении Проводника; а с
    // тех пор как содержимое лежит кусками, поля `content` у новых файлов и
    // вовсе нет. Предпросмотр берёт байты сам, по одному файлу
    const filesOmit = { omit: { content: true } };
    const folders = await prisma.folder.findMany({
      where: { ...projectWhere, ...scopeWhere, deletedAt: null, ...(hiddenHere ? { id: { in: [] as string[] } } : {}) },
      include: {
        files: {
          where: { deletedAt: null },
          ...filesOmit,
          // Не `true`: связь отдала бы всю запись сотрудника, с хешем пароля
          include: { mainTags: true, additionalTags: true, createdBy: WHO, updatedBy: WHO },
        },
      },
    });
    const rootFiles = await prisma.fileNode.findMany({
      where: { folderId: null, type: { not: 'CHAT_FILE' }, deletedAt: null, ...scopeWhere },
      ...filesOmit,
      include: { mainTags: true, additionalTags: true, createdBy: WHO, updatedBy: WHO },
    });

    // Главному Администратору отдаём список владельцев для подписей личных разделов
    let owners: Array<{ id: string; name: string; symbol: string }> = [];
    if (isMainAdmin) {
      const users = await prisma.user.findMany({ select: { id: true, name: true, symbol: true } });
      owners = users;
    }
    // Окно должно знать и проект диска (по нему оно относит содержимое к
    // третьему корню), и его корневую папку (в неё ложится всё, что человек
    // кладёт «прямо на диск»)
    res.json({
      folders, rootFiles, isMainAdmin, mainAdminId, owners,
      diskProjectId, diskFolderId: diskRoot.id,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Что из корзины видно этому человеку.
 *
 * Корзина брала все удалённые записи проекта, включая личные файлы других
 * сотрудников: имена и размеры чужого личного раздела читались из «мусора», а
 * «Очистить корзину» стирала чужое безвозвратно. Теперь корзина показывает и
 * чистит только то, что человеку видно в самом Проводнике.
 */
async function trashWhere(req: Request, projectId: string) {
  const prisma = getPrisma();
  const me = (req as any).authUser || null;
  const specific = !(!projectId || projectId === 'null' || projectId === 'undefined' || projectId === 'default');
  const hidden = await hiddenProjectIds(prisma, me);
  const projectWhere: any = specific ? { projectId } : hidden.length ? { projectId: { notIn: hidden } } : {};
  const sc = personalScopeWhere(me, await getMainAdminId(prisma));
  const restricted = Object.keys(sc).length > 0;
  return {
    empty: specific && hidden.includes(projectId),
    folders: { ...projectWhere, deletedAt: { not: null }, ...sc },
    files: {
      deletedAt: { not: null }, type: { not: 'CHAT_FILE' },
      AND: [trashFileWhere(projectWhere), ...(restricted ? [sc, { OR: [{ folderId: null }, { folder: sc }] }] : [])],
    },
  };
}

app.post('/api/folders', async (req: Request, res: Response) => {
  const prisma = getPrisma();
  try {
    let { name, projectId, parentId, scope, ownerId } = req.body;
    if (!projectId || projectId === 'null' || projectId === 'undefined' || projectId === 'default') {
      let firstProject = await prisma.project.findFirst({ where: { system: false } });
      if (!firstProject) {
        firstProject = await prisma.project.create({
          data: { id: await nextProjectId(prisma), name: 'Общий Проект' },
        });
      }
      projectId = firstProject.id;
    }
    if (await deniedOnDisk(req, res, projectId)) return;
    // Создать папку внутри чужой личной (или в скрытом проекте) нельзя: раньше
    // родитель не проверялся, и подпапка наследовала чужого владельца — так
    // можно было засорить чужой личный раздел, зная номер папки
    if (parentId && !(await canAccessFolder(prisma, (req as any).authUser, String(parentId)))) {
      return res.status(404).json({ error: FOLDER_NOT_FOUND });
    }
    // Вложенные папки наследуют раздел (общий/личный) родителя
    if (parentId) {
      const parent = await prisma.folder.findUnique({ where: { id: parentId } });
      if (parent) {
        scope = (parent as any).scope || 'SHARED';
        ownerId = (parent as any).ownerId || null;
      } else {
        // Родителя нет — наследовать нечего, а владелец из тела запроса не
        // доверяется: личная папка принадлежит тому, кто вошёл
        ownerId = null;
      }
    }
    // Владелец личной папки — только тот, кто вошёл. Раньше идентификатор
    // приходил из запроса, и любой вошедший мог завести папку «личную для
    // Иванова», а потом читать её как свою. Наследование от родителя выше
    // остаётся: подпапка личной папки принадлежит тому же человеку.
    const actorId = (req as any).authUser?.id || null;
    const isPersonal = scope === 'PERSONAL';
    const folder = await prisma.folder.create({
      data: {
        name, projectId, parentId,
        scope: isPersonal ? 'PERSONAL' : 'SHARED',
        ownerId: isPersonal ? (parentId ? (ownerId || actorId) : actorId) : null
      }
    });
    res.json({ folder });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/folders/:id', async (req: Request, res: Response) => {
  const prisma = getPrisma();
  // Системные папки (напр. «Конструктор») переименовывать/переносить нельзя
  const target = await prisma.folder.findUnique({ where: { id: req.params.id } });
  if (!target || !(await canAccessFolder(prisma, (req as any).authUser, req.params.id))) {
    return res.status(404).json({ error: FOLDER_NOT_FOUND });
  }
  if ((target as any)?.system && ('name' in req.body || 'parentId' in req.body)) {
    return res.status(403).json({ error: 'Это системная папка — её нельзя переименовать или переместить.' });
  }
  if (await deniedOnDisk(req, res, (target as any)?.projectId)) return;
  // Раньше тело уходило в Prisma целиком: через PATCH папке меняли scope,
  // ownerId и projectId — то есть забирали чужую личную папку или уводили её
  // в другой проект. Переименование — единственное, что делает окно; перенос
  // идёт отдельным маршрутом с проверкой (/api/files/copy)
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name) return res.status(400).json({ error: 'Нужно новое имя папки' });
  const folder = await prisma.folder.update({
    where: { id: req.params.id },
    data: { name },
    include: { files: { include: { mainTags: true, additionalTags: true } } }
  });
  res.json({ folder });
});

app.delete('/api/folders/:id', async (req: Request, res: Response) => {
  const prisma = getPrisma();
  const target = await prisma.folder.findUnique({ where: { id: req.params.id } });
  if (!target || !(await canAccessFolder(prisma, (req as any).authUser, req.params.id))) {
    return res.status(404).json({ error: FOLDER_NOT_FOUND });
  }
  if ((target as any)?.system) {
    return res.status(403).json({ error: 'Это системная папка — её нельзя удалить.' });
  }
  if (await deniedOnDisk(req, res, (target as any)?.projectId)) return;
  // Мягкое удаление: папка со всем содержимым уходит в корзину и
  // восстанавливается целиком. Файлы внутри не трогаем — они скрыты
  // вместе с папкой и вернутся вместе с ней.
  // Кто удалил — из сессии: `actorId` из запроса позволял записать удаление на другого
  await prisma.folder.update({
    where: { id: req.params.id },
    data: { deletedAt: new Date(), deletedById: (req as any).authUser?.id || null },
  });
  res.json({ success: true, trashed: true });
});

// ── Корзина Проводника ─────────────────────────────────────────────────────
// Удалённое хранится до явной очистки: в системе документов случайное
// удаление чертежа не должно быть необратимым.
app.get('/api/projects/:projectId/trash', async (req: Request, res: Response) => {
  const prisma = getPrisma();
  try {
    const { projectId } = req.params;
    const w = await trashWhere(req, projectId);
    if (w.empty) return res.json({ folders: [], files: [] });
    const [folders, files] = await Promise.all([
      prisma.folder.findMany({ where: w.folders, orderBy: { deletedAt: 'desc' } }),
      prisma.fileNode.findMany({
        where: w.files,
        orderBy: { deletedAt: 'desc' },
        include: { mainTags: true, additionalTags: true },
      }),
    ]);
    res.json({ folders, files });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

/**
 * Один файл: запись и — по старой памяти — содержимое строкой.
 *
 * Список файлов содержимое не отдаёт: на сотне чертежей это десятки мегабайт в
 * каждом ответе. Здесь оно есть, но новые файлы его не имеют вовсе — их
 * содержимое лежит кусками, и берут его потоком `/api/files/:id/raw`.
 *
 * `?meta=1` — только запись, без содержимого. Тому, кому нужны имя и путь
 * происхождения, незачем тащить через JSON весь файл.
 */
app.get('/api/files/:id', async (req: Request, res: Response) => {
  const prisma = getPrisma();
  try {
    const metaOnly = String(req.query.meta || '') === '1';
    const file = await prisma.fileNode.findUnique({
      where: { id: req.params.id },
      include: { mainTags: true, createdBy: { select: { id: true, name: true } } },
      ...(metaOnly ? { omit: { content: true } } : {}),
    });
    // Личное чужого и файл закрытого проекта — «не найден», как и несуществующий:
    // отказ другими словами подтвердил бы, что такой номер есть
    if (!file || !(await canReadFile(prisma, (req as any).authUser, file))) {
      return res.status(404).json({ error: FILE_NOT_FOUND });
    }
    // Вложения чата лежат в той же таблице, но читаются только участниками
    // переписки через /chat_files. По id отсюда их отдавать было нельзя: так
    // любой вошедший открывал вложение чужого личного чата
    if (file.deletedAt || file.type === 'CHAT_FILE') return res.status(404).json({ error: FILE_NOT_FOUND });
    res.json({ file });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.post('/api/files/:id/restore', async (req: Request, res: Response) => {
  const prisma = getPrisma();
  try {
    // Восстановить можно только то, что человеку видно; чужое — «не найдено»
    if (!(await canManageFile(prisma, (req as any).authUser, req.params.id))) {
      return res.status(404).json({ error: FILE_NOT_FOUND });
    }
    const file = await prisma.fileNode.update({ where: { id: req.params.id }, data: { deletedAt: null, deletedById: null } });
    // Если папка файла тоже в корзине — возвращаем и её, иначе файл
    // «восстановится» в невидимое место.
    if (file.folderId) {
      const folder = await prisma.folder.findUnique({ where: { id: file.folderId } });
      if (folder && (folder as any).deletedAt) {
        await prisma.folder.update({ where: { id: folder.id }, data: { deletedAt: null, deletedById: null } });
      }
    }
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.post('/api/folders/:id/restore', async (req: Request, res: Response) => {
  const prisma = getPrisma();
  try {
    if (!(await canAccessFolder(prisma, (req as any).authUser, req.params.id))) {
      return res.status(404).json({ error: FOLDER_NOT_FOUND });
    }
    await prisma.folder.update({ where: { id: req.params.id }, data: { deletedAt: null, deletedById: null } });
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/projects/:projectId/trash', async (req: Request, res: Response) => {
  const prisma = getPrisma();
  try {
    const { projectId } = req.params;
    const w = await trashWhere(req, projectId);
    if (w.empty) return res.json({ success: true, files: 0, folders: 0 });
    await ensureSharing(prisma);
    const { files, folders } = await prisma.$transaction(async (tx: any) => {
      const removing = await tx.fileNode.findMany({ where: w.files, select: { id: true } });
      for (const file of removing) await forgetFileShare(tx, file.id);
      const files = await tx.fileNode.deleteMany({ where: w.files });
      const folders = await tx.folder.deleteMany({ where: w.folders });
      return { files, folders };
    });
    res.json({ success: true, files: files.count, folders: folders.count });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.post('/api/files', async (req: Request, res: Response) => {
  const prisma = getPrisma();
  // Белый список полей (B6): не пишем произвольные поля из тела запроса
  const b = req.body || {};
  const data: any = {
    name: String(b.name || 'Без имени'),
    folderId: b.folderId || null,
    filePath: typeof b.filePath === 'string' ? b.filePath : `/shared/${b.name || ''}`,
    size: Number.isFinite(b.size) ? Math.max(0, Math.trunc(b.size)) : 0,
    type: typeof b.type === 'string' ? b.type : 'FILE',
    department: typeof b.department === 'string' ? b.department : 'Unassigned',
    content: typeof b.content === 'string' ? b.content : undefined,
    // Автор — вошедший, а не тот, кого назвали в теле: иначе файл записывался
    // «от имени» любого сотрудника, и в свойствах стоял чужой автор
    createdById: (req as any).authUser?.id || null,
    updatedById: (req as any).authUser?.id || null,
    // Откуда файл принесли из Windows: по этому пути выгрузка предложит ту же
    // папку, и файл, который ходит туда-сюда, ходит по одной тропинке
    ...(typeof b.origin === 'string' && b.origin ? { origin: b.origin.slice(0, 500) } : {}),
    ...(typeof b.refId === 'string' ? { refId: b.refId } : {}),
    ...(typeof b.revision === 'string' ? { revision: b.revision } : {}),
    ...(typeof b.statusCode === 'string' ? { statusCode: b.statusCode } : {}),
    ...(b.scope === 'PERSONAL' || b.scope === 'SHARED' ? { scope: b.scope } : {}),
  };
  // Класть файл в чужую личную папку или в закрытый проект нельзя: он
  // унаследовал бы чужого владельца, и вошедший писал бы в чужой раздел
  if (data.folderId && !(await canAccessFolder(prisma, (req as any).authUser, data.folderId))) {
    return res.status(404).json({ error: FOLDER_NOT_FOUND });
  }
  // Файл внутри папки наследует её раздел (общий/личный)
  if (data.folderId) {
    try {
      const parent = await prisma.folder.findUnique({ where: { id: data.folderId } });
      if (parent) {
        data.scope = (parent as any).scope || 'SHARED';
        data.ownerId = (parent as any).ownerId || null;
      }
    } catch {}
  } else {
    // Личный файл в корне раздела принадлежит тому, кто вошёл, а не тому, чей
    // идентификатор прислали: иначе «личный» ничего не значит
    data.scope = data.scope === 'PERSONAL' ? 'PERSONAL' : 'SHARED';
    data.ownerId = data.scope === 'PERSONAL' ? ((req as any).authUser?.id || null) : null;
  }
  if (await deniedOnDisk(req, res, await projectOfFolder(data.folderId))) return;
  const file = await prisma.fileNode.create({
    data,
    include: { mainTags: true, additionalTags: true, createdBy: WHO, updatedBy: WHO }
  });
  res.json({ file });
});

app.post('/api/files/copy', async (req: Request, res: Response) => {
  const prisma = getPrisma();
  // targetScope/targetOwnerId передаются при перемещении в корень раздела «Общий»/«Личный».
  // При перемещении внутрь папки раздел наследуется от неё.
  const { ids, targetFolderId, isCut, targetScope, targetOwnerId } = req.body;
  const me = (req as any).authUser || null;
  try {
    // Всё, что переносят или копируют, и куда кладут, должно быть человеку
    // видно. Раньше проверялся только общий диск: чужой личный файл можно было
    // «перенести» в свой раздел (и стать его владельцем) или скопировать себе,
    // зная номер. Проверка до первой записи: половина пачки не переезжает
    const list: string[] = Array.isArray(ids) ? ids.map((x: any) => String(x)) : [];
    for (const id of list) {
      const isFile = await prisma.fileNode.findUnique({ where: { id }, select: { id: true } });
      const okItem = isFile
        ? (isCut ? await canManageFile(prisma, me, id) : await canReadFile(prisma, me, id))
        : await canAccessFolder(prisma, me, id);
      if (!okItem) return res.status(404).json({ success: false, error: FILE_NOT_FOUND });
      if (isCut && isFile && await shareOf(prisma, id)) return res.status(409).json({ success: false, error: 'Общая рабочая версия остаётся в папке «Общий доступ». Перемещайте локальный оригинал или создайте копию.' });
    }
    if (targetFolderId && !(await canAccessFolder(prisma, me, String(targetFolderId)))) {
      return res.status(404).json({ success: false, error: FOLDER_NOT_FOUND });
    }
    // Куда кладём — раз; откуда уносим при перемещении — два: унести чужое с
    // общего диска без права так же нельзя, как и положить туда своё
    if (await deniedOnDisk(req, res, await projectOfFolder(targetFolderId))) return;
    if (isCut) {
      for (const id of (Array.isArray(ids) ? ids : [])) {
        const from = await projectOfFile(String(id)) || await projectOfFolder(String(id));
        if (await deniedOnDisk(req, res, from)) return;
      }
    }
    let scope: string | null = null;
    let ownerId: string | null = null;
    if (targetFolderId) {
      const target = await prisma.folder.findUnique({ where: { id: targetFolderId } });
      if (target) {
        scope = (target as any).scope || 'SHARED';
        ownerId = (target as any).ownerId || null;
      }
    } else if (targetScope) {
      scope = targetScope === 'PERSONAL' ? 'PERSONAL' : 'SHARED';
      // Владелец личного раздела — вошедший. Чужого назначить может только
      // Главный Администратор, который и так видит все личные разделы; от
      // остальных `targetOwnerId` делал бы вызывающего хозяином чужих файлов
      const isMain = !!me?.id && me.id === await getMainAdminId(prisma);
      ownerId = scope === 'PERSONAL' ? ((isMain && targetOwnerId) || me?.id || null) : null;
    }

    for (const id of list) {
      if (isCut) {
        // Just move it
        const file = await prisma.fileNode.findUnique({ where: { id } });
        if (file) {
          await prisma.fileNode.update({
            where: { id },
            data: { folderId: targetFolderId, ...(scope ? { scope, ownerId } as any : {}) }
          });
        } else {
          // Нельзя вложить папку в саму себя или в свою же подпапку — это создаёт
          // цикл в дереве. Такой id молча пропускаем, остальные перемещаем.
          if (targetFolderId && await isFolderInSubtree(targetFolderId, id)) {
            continue;
          }
          await prisma.folder.update({ where: { id }, data: { parentId: targetFolderId } });
          if (scope) await applyScopeRecursive(id, scope, ownerId);
        }
      } else {
        // Copy (files only for simplicity)
        const file = await prisma.fileNode.findUnique({ where: { id }, include: { mainTags: true, additionalTags: true } });
        if (file) {
          const { id: _, mainTags, additionalTags, updatedAt, createdById, updatedById, ...fileData } = file;
          await prisma.fileNode.create({
            data: {
              ...fileData,
              name: fileData.name + ' - Copy',
              folderId: targetFolderId,
              ...(scope ? { scope, ownerId } as any : {}),
              mainTags: { connect: mainTags.map(t => ({ id: t.id })) },
              additionalTags: { connect: additionalTags.map(t => ({ id: t.id })) }
            }
          });
        }
      }
    }
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.patch('/api/files/:id', async (req: Request, res: Response) => {
  const prisma = getPrisma();
  const me = (req as any).authUser || null;
  const current = await prisma.fileNode.findUnique({ where: { id: req.params.id }, select: {
    id: true, scope: true, ownerId: true, folderId: true, type: true, createdById: true,
  } });
  if (!current || !(await canManageFile(prisma, me, current))) return res.status(404).json({ error: FILE_NOT_FOUND });
  if (await deniedOnDisk(req, res, await projectOfFile(req.params.id))) return;
  // Только известные поля (server/fileAccess.ts): тело запроса раньше шло в
  // Prisma целиком, вместе со scope, ownerId и content
  const patch = patchFileFields(req.body, {
    actorId: String(me.id), current,
    ownerOrAdmin: isFileOwnerOrAdmin(me, current),
    actorIsMainAdmin: me.id === await getMainAdminId(prisma),
  });
  if (patch.error) return res.status(patch.error.status).json({ error: patch.error.message });
  if (await shareOf(prisma, String(current.id)) && ('scope' in req.body || 'ownerId' in req.body)) return res.status(409).json({ error: 'Права опубликованного файла меняются через «Общий доступ»' });
  if (typeof patch.data.ownerId === 'string' && patch.data.ownerId !== me.id
    && !(await prisma.user.findUnique({ where: { id: patch.data.ownerId }, select: { id: true } }))) {
    return res.status(400).json({ error: 'Такого сотрудника нет' });
  }
  const { mainTagIds, additionalTagIds } = patch;
  const file = await prisma.fileNode.update({
    where: { id: req.params.id },
    data: {
      ...patch.data,
      ...(mainTagIds ? { mainTags: { set: mainTagIds.map((id: string) => ({ id })) } } : {}),
      ...(additionalTagIds ? { additionalTags: { set: additionalTagIds.map((id: string) => ({ id })) } } : {})
    },
    omit: { content: true },
    include: { mainTags: true, additionalTags: true, createdBy: WHO, updatedBy: WHO }
  });
  res.json({ file });
});

app.delete('/api/files/:id', async (req: Request, res: Response) => {
  const prisma = getPrisma();
  const target = await prisma.fileNode.findUnique({ where: { id: req.params.id }, select: {
    id: true, scope: true, ownerId: true, folderId: true, type: true, createdById: true,
  } });
  if (!target || !(await canManageFile(prisma, (req as any).authUser, target))) {
    return res.status(404).json({ error: FILE_NOT_FOUND });
  }
  if (await deniedOnDisk(req, res, await projectOfFolder((target as any)?.folderId))) return;
  // Мягкое удаление: файл уходит в корзину проводника и восстановим.
  // Безвозвратно чистит только «Очистить корзину».
  // Кто удалил — из сессии: `actorId` из запроса позволял записать удаление на другого
  await prisma.fileNode.update({
    where: { id: req.params.id },
    data: { deletedAt: new Date(), deletedById: (req as any).authUser?.id || null },
  });
  res.json({ success: true, trashed: true });
});
}
