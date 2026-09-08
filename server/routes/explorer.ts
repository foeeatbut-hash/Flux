import type { Express, Request, Response } from 'express';
import { getPrisma } from '../context.js';

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

export function registerExplorerRoutes(app: Express): void {
// Folders & Files (Explorer)
// «Главный Администратор» — единственный: самый первый созданный пользователь с ролью ADMIN.
// Пользователи, которым админ выдал права/роль позже, главными не считаются.
async function getMainAdminId(): Promise<string | null> {
  const prisma = getPrisma();
  try {
    const admin = await prisma.user.findFirst({
      where: { role: 'ADMIN' },
      orderBy: { createdAt: 'asc' }
    });
    return admin ? admin.id : null;
  } catch {
    return null;
  }
}

app.get('/api/projects/:projectId/folders', async (req: Request, res: Response) => {
  const prisma = getPrisma();
  const { projectId } = req.params;
  const actorId = String(req.query.actorId || '');
  try {
    const projectWhere = (!projectId || projectId === 'null' || projectId === 'undefined' || projectId === 'default')
      ? {}
      : { projectId };

    const mainAdminId = await getMainAdminId();
    const isMainAdmin = !!actorId && actorId === mainAdminId;

    // Личные папки/файлы видит только их владелец; Главный Администратор видит все
    const scopeWhere = isMainAdmin
      ? {}
      : actorId
        ? { OR: [{ scope: { not: 'PERSONAL' } }, { ownerId: actorId }] }
        : { scope: { not: 'PERSONAL' } };

    // Удалённое лежит в корзине и в обычных списках не показывается
    const folders = await prisma.folder.findMany({
      where: { ...projectWhere, ...scopeWhere, deletedAt: null },
      include: { files: { where: { deletedAt: null }, include: { mainTags: true, additionalTags: true, createdBy: true, updatedBy: true } } }
    });
    const rootFiles = await prisma.fileNode.findMany({
      where: { folderId: null, type: { not: 'CHAT_FILE' }, deletedAt: null, ...scopeWhere },
      include: { mainTags: true, additionalTags: true, createdBy: true, updatedBy: true }
    });

    // Главному Администратору отдаём список владельцев для подписей личных разделов
    let owners: Array<{ id: string; name: string; symbol: string }> = [];
    if (isMainAdmin) {
      const users = await prisma.user.findMany({ select: { id: true, name: true, symbol: true } });
      owners = users;
    }
    res.json({ folders, rootFiles, isMainAdmin, mainAdminId, owners });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/folders', async (req: Request, res: Response) => {
  const prisma = getPrisma();
  try {
    let { name, projectId, parentId, scope, ownerId } = req.body;
    if (!projectId || projectId === 'null' || projectId === 'undefined' || projectId === 'default') {
      let firstProject = await prisma.project.findFirst();
      if (!firstProject) {
        firstProject = await prisma.project.create({
          data: { name: 'Общий Проект' }
        });
      }
      projectId = firstProject.id;
    }
    // Вложенные папки наследуют раздел (общий/личный) родителя
    if (parentId) {
      const parent = await prisma.folder.findUnique({ where: { id: parentId } });
      if (parent) {
        scope = (parent as any).scope || 'SHARED';
        ownerId = (parent as any).ownerId || null;
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
        ownerId: isPersonal ? (parentId ? (ownerId || null) : actorId) : null
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
  if ((target as any)?.system && ('name' in req.body || 'parentId' in req.body)) {
    return res.status(403).json({ error: 'Это системная папка — её нельзя переименовать или переместить.' });
  }
  const folder = await prisma.folder.update({
    where: { id: req.params.id },
    data: req.body,
    include: { files: { include: { mainTags: true, additionalTags: true } } }
  });
  res.json({ folder });
});

app.delete('/api/folders/:id', async (req: Request, res: Response) => {
  const prisma = getPrisma();
  const target = await prisma.folder.findUnique({ where: { id: req.params.id } });
  if ((target as any)?.system) {
    return res.status(403).json({ error: 'Это системная папка — её нельзя удалить.' });
  }
  // Мягкое удаление: папка со всем содержимым уходит в корзину и
  // восстанавливается целиком. Файлы внутри не трогаем — они скрыты
  // вместе с папкой и вернутся вместе с ней.
  await prisma.folder.update({
    where: { id: req.params.id },
    data: { deletedAt: new Date(), deletedById: String(req.query.actorId || req.body?.actorId || '') || null },
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
    const projectWhere = (!projectId || projectId === 'null' || projectId === 'undefined' || projectId === 'default') ? {} : { projectId };
    const [folders, files] = await Promise.all([
      prisma.folder.findMany({ where: { ...projectWhere, deletedAt: { not: null } }, orderBy: { deletedAt: 'desc' } }),
      prisma.fileNode.findMany({
        where: { deletedAt: { not: null }, type: { not: 'CHAT_FILE' } },
        orderBy: { deletedAt: 'desc' },
        include: { mainTags: true, additionalTags: true },
      }),
    ]);
    res.json({ folders, files });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

/**
 * Один файл целиком, вместе с содержимым.
 *
 * Список файлов содержимое не отдаёт — на сотне чертежей это десятки мегабайт
 * в каждом ответе. Редактору ПДФ нужен именно файл, поэтому для него отдельный
 * маршрут, а не «добавим content в список».
 */
app.get('/api/files/:id', async (req: Request, res: Response) => {
  const prisma = getPrisma();
  try {
    const file = await prisma.fileNode.findUnique({
      where: { id: req.params.id },
      include: { mainTags: true, createdBy: { select: { id: true, name: true } } },
    });
    if (!file || file.deletedAt) return res.status(404).json({ error: 'Файл не найден' });
    res.json({ file });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.post('/api/files/:id/restore', async (req: Request, res: Response) => {
  const prisma = getPrisma();
  try {
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
    await prisma.folder.update({ where: { id: req.params.id }, data: { deletedAt: null, deletedById: null } });
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/projects/:projectId/trash', async (req: Request, res: Response) => {
  const prisma = getPrisma();
  try {
    const { projectId } = req.params;
    const projectWhere = (!projectId || projectId === 'null' || projectId === 'undefined' || projectId === 'default') ? {} : { projectId };
    const files = await prisma.fileNode.deleteMany({ where: { deletedAt: { not: null }, type: { not: 'CHAT_FILE' } } });
    const folders = await prisma.folder.deleteMany({ where: { ...projectWhere, deletedAt: { not: null } } });
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
    createdById: b.createdById || null,
    updatedById: b.updatedById || b.createdById || null,
    // Откуда файл принесли из Windows: по этому пути выгрузка предложит ту же
    // папку, и файл, который ходит туда-сюда, ходит по одной тропинке
    ...(typeof b.origin === 'string' && b.origin ? { origin: b.origin.slice(0, 500) } : {}),
    ...(typeof b.refId === 'string' ? { refId: b.refId } : {}),
    ...(typeof b.revision === 'string' ? { revision: b.revision } : {}),
    ...(typeof b.statusCode === 'string' ? { statusCode: b.statusCode } : {}),
    ...(b.scope === 'PERSONAL' || b.scope === 'SHARED' ? { scope: b.scope } : {}),
  };
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
  const file = await prisma.fileNode.create({
    data,
    include: { mainTags: true, additionalTags: true, createdBy: true, updatedBy: true }
  });
  res.json({ file });
});

app.post('/api/files/copy', async (req: Request, res: Response) => {
  const prisma = getPrisma();
  // targetScope/targetOwnerId передаются при перемещении в корень раздела «Общий»/«Личный».
  // При перемещении внутрь папки раздел наследуется от неё.
  const { ids, targetFolderId, isCut, targetScope, targetOwnerId } = req.body;
  try {
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
      ownerId = scope === 'PERSONAL' ? (targetOwnerId || null) : null;
    }

    for (const id of ids) {
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
  const { mainTagIds, additionalTagIds, ...updateData } = req.body;
  const file = await prisma.fileNode.update({
    where: { id: req.params.id },
    data: {
      ...updateData,
      ...(mainTagIds ? { mainTags: { set: mainTagIds.map((id: string) => ({ id })) } } : {}),
      ...(additionalTagIds ? { additionalTags: { set: additionalTagIds.map((id: string) => ({ id })) } } : {})
    },
    include: { mainTags: true, additionalTags: true, createdBy: true, updatedBy: true }
  });
  res.json({ file });
});

app.delete('/api/files/:id', async (req: Request, res: Response) => {
  const prisma = getPrisma();
  // Зеркало документа Конструктора — не самостоятельный файл: удаление
  // выполняется в самом Конструкторе (там корзина с восстановлением)
  const target = await prisma.fileNode.findUnique({ where: { id: req.params.id } });
  if ((target as any)?.type === 'CONSTRUCTOR') {
    return res.status(403).json({ error: 'Это документ Flux Office — удалите его в «Таблице» или «Документе» (там есть корзина).' });
  }
  // Мягкое удаление: файл уходит в корзину проводника и восстановим.
  // Безвозвратно чистит только «Очистить корзину».
  await prisma.fileNode.update({
    where: { id: req.params.id },
    data: { deletedAt: new Date(), deletedById: String(req.query.actorId || req.body?.actorId || '') || null },
  });
  res.json({ success: true, trashed: true });
});
}
