import type { Express, Request, Response } from 'express';
import { getPrisma, resolveProjectId, sendError } from '../context.js';
import { syncMirror } from './constructor.js';
import { applyScopeRecursive } from './explorer.js';
import { ensureDeskFolder, ensureOfficeOnDesk } from '../systemFolders.js';

// Рабочий стол.
//
// Стол — не отдельное хранилище, а две системные папки Проводника:
//
//   Личный → Рабочий стол   (scope PERSONAL, ownerId = сотрудник)
//   Общий  → Рабочий стол   (scope SHARED,   ownerId = null)
//
// Стол показывает содержимое обеих слитно, значки из общей помечены. Так
// отвечен вопрос «где лежит то, что я положил на стол»: в Проводнике, в папке
// с тем же названием, и туда же можно прийти из Проводника. Заводить для стола
// третье место хранения — значит завести файлы, которых нет в архиве проекта,
// а в системе документации такого быть не должно.
//
// Ярлыки разделов программы («Справочник», «Оборудование») сюда не попадают:
// это не файлы, они живут в настройках сотрудника и в Проводнике не видны.
//
// Prisma берётся лениво через getPrisma() — клиент пересоздаётся при смене базы
// (см. server/context.ts).

export function registerDesktopRoutes(app: Express): void {
  const authUserOf = (req: Request): any => (req as any).authUser || null;

  // Личный стол — только свой. Идентификатор владельца берётся из сессии, а не
  // из запроса: иначе «личный» ничего не значит — идентификаторы коллег видны
  // в списке сотрудников, и чужой стол читался бы одним запросом.
  const deskOwner = (req: Request): string | null => authUserOf(req)?.id || null;

  app.get('/api/desktop', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    try {
      // Документы Flux Office лежат на столе — если они ещё в старой папке,
      // перевозим их один раз, иначе стол показал бы пустое место
      await ensureOfficeOnDesk();
      const projectId = await resolveProjectId(String(req.query.projectId || ''));
      const me = deskOwner(req);
      const shared = await ensureDeskFolder(projectId, 'SHARED', null);
      const personal = me ? await ensureDeskFolder(projectId, 'PERSONAL', me) : null;
      const ids = [shared.id, ...(personal ? [personal.id] : [])];

      const [files, folders, trashCount] = await Promise.all([
        // Теги и тот, кто менял последним, нужны прямо на столе: значок обязан
        // показывать не только имя файла, но и то, ради чего в Flux вообще
        // ведут документацию, — ревизию, статус и владельца
        prisma.fileNode.findMany({
          where: { folderId: { in: ids }, deletedAt: null },
          orderBy: { name: 'asc' },
          include: { mainTags: true, updatedBy: true, createdBy: true },
        }),
        prisma.folder.findMany({
          where: { parentId: { in: ids }, deletedAt: null },
          orderBy: { name: 'asc' },
        }),
        // Число на значке корзины: пустая она или нет, видно не заходя в неё.
        // Считаем и папки — в корзине Проводника лежат и они, и показывать
        // «пусто» на непустой корзине нельзя
        Promise.all([
          prisma.fileNode.count({ where: { deletedAt: { not: null }, type: { not: 'CHAT_FILE' } } }),
          prisma.folder.count({ where: { projectId, deletedAt: { not: null } } }),
        ]).then(([f, d]: number[]) => f + d),
      ]);

      res.json({ sharedFolderId: shared.id, personalFolderId: personal?.id || null, files, folders, trashCount });
    } catch (err: any) { sendError(res, err); }
  });

  app.post('/api/desktop/folder', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    try {
      const projectId = await resolveProjectId(String(req.body?.projectId || ''));
      const me = deskOwner(req);
      const scope = req.body?.scope === 'SHARED' || !me ? 'SHARED' : 'PERSONAL';
      const parent = await ensureDeskFolder(projectId, scope, me);
      const folder = await prisma.folder.create({
        data: {
          name: String(req.body?.name || 'Новая папка').slice(0, 200),
          projectId, parentId: parent.id,
          scope, ownerId: scope === 'PERSONAL' ? me : null,
        },
      });
      res.json({ folder });
    } catch (err: any) { sendError(res, err); }
  });

  // Документ, созданный на столе, — обычный документ Конструктора: его видно и
  // в разделе «Конструктор», и в Проводнике. Отличается только тем, что зеркало
  // лежит не в системной папке «Конструктор», а в папке стола.
  app.post('/api/desktop/doc', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    try {
      const projectId = await resolveProjectId(String(req.body?.projectId || ''));
      const me = authUserOf(req);
      const kind = ['DOC', 'TEXT', 'NOTE'].includes(String(req.body?.kind || '')) ? String(req.body.kind) : 'DOC';
      // Заметка — всегда своя: она и заводится как личная запись
      const scope = kind === 'NOTE' || !me ? 'PERSONAL' : (req.body?.scope === 'SHARED' ? 'SHARED' : 'PERSONAL');
      if (scope === 'PERSONAL' && !me?.id) return res.status(401).json({ error: 'Нужно войти в программу.' });

      const doc = await prisma.constructorDoc.create({
        data: {
          projectId,
          name: String(req.body?.name || 'Новый документ').slice(0, 200),
          named: true,
          kind,
          scope,
          ownerId: me?.id || null,
          createdById: me?.id || null,
          updatedById: me?.id || null,
        },
      });
      // Зеркало заводим общими правилами Конструктора, затем переносим на стол.
      // Дальнейшие правки документа зеркало с места не сдвинут: syncMirror
      // сохраняет папку, пока не менялся раздел.
      await syncMirror(doc);
      const folder = await ensureDeskFolder(projectId, scope as any, me?.id || null);
      const mirror = await prisma.fileNode.findFirst({ where: { type: 'CONSTRUCTOR', refId: doc.id } });
      if (mirror) await prisma.fileNode.update({ where: { id: mirror.id }, data: { folderId: folder.id } });
      res.json({ doc, file: mirror ? { ...mirror, folderId: folder.id } : null });
    } catch (err: any) { sendError(res, err); }
  });

  // «Выложить на общий стол» и обратно. Это перенос между двумя папками
  // Проводника — тот же, что перетаскиванием в самом Проводнике, поэтому
  // никакой особой записи здесь нет: меняется папка и раздел.
  app.post('/api/desktop/move', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    try {
      const projectId = await resolveProjectId(String(req.body?.projectId || ''));
      const me = deskOwner(req);
      const to = req.body?.to === 'SHARED' ? 'SHARED' : 'PERSONAL';
      if (to === 'PERSONAL' && !me) return res.status(401).json({ error: 'Нужно войти в программу.' });
      const target = await ensureDeskFolder(projectId, to, me);
      const id = String(req.body?.id || '');

      const file = await prisma.fileNode.findFirst({ where: { id } });
      if (file) {
        // Забрать с общего стола чужое нельзя: положивший его коллега не должен
        // однажды обнаружить, что документ уехал в чей-то личный раздел
        if (file.scope === 'SHARED' && to === 'PERSONAL' && file.createdById && file.createdById !== me) {
          return res.status(403).json({ error: 'Этот файл положил на общий стол другой сотрудник — забрать его себе нельзя.' });
        }
        await prisma.fileNode.update({
          where: { id }, data: { folderId: target.id, scope: to, ownerId: to === 'PERSONAL' ? me : null },
        });
        if (file.type === 'CONSTRUCTOR' && file.refId) {
          await prisma.constructorDoc.update({
            where: { id: file.refId }, data: { scope: to, ownerId: to === 'PERSONAL' ? me : null },
          }).catch(() => { /* документ мог быть удалён — зеркало починит Конструктор */ });
        }
        return res.json({ success: true });
      }

      const folder = await prisma.folder.findFirst({ where: { id } });
      if (!folder) return res.status(404).json({ error: 'Не найдено.' });
      if (folder.system) return res.status(403).json({ error: 'Это системная папка — её нельзя перенести.' });
      await prisma.folder.update({ where: { id }, data: { parentId: target.id } });
      // Не только сама папка: всё содержимое, включая подпапки. Иначе внутри
      // общей папки останется личное — видимое одному владельцу
      await applyScopeRecursive(id, to, to === 'PERSONAL' ? me : null);
      res.json({ success: true });
    } catch (err: any) { sendError(res, err); }
  });
}
