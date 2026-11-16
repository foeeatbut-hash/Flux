import type { Express, Request, Response } from 'express';
import { getPrisma, resolveProjectId, sendError } from '../context.js';
import { applyScopeRecursive, withoutContent } from './explorer.js';
import { ensureDeskFolder, ensureOfficeOnDesk } from '../systemFolders.js';
import { assertExpectedVersion, expectedVersionOf, guardedWrite, sendRecordGone, sendGuardRefusal } from '../versionGuard.js';
import { badVersion } from '../equipmentStale.js';
import { editChangedText } from '../../src/lib/refusalTexts.js';
import { FOLDER_NOT_FOUND, canAccessFolder, canWriteFile, getMainAdminId, personalScopeWhere } from '../fileAccess.js';

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
      const mainAdminId = await getMainAdminId(prisma);
      const ids = [shared.id, ...(personal ? [personal.id] : [])];

      const [files, folders, trashCount] = await Promise.all([
        // Теги и тот, кто менял последним, нужны прямо на столе: значок обязан
        // показывать не только имя файла, но и то, ради чего в Flux вообще
        // ведут документацию, — ревизию, статус и владельца
        prisma.fileNode.findMany({
          where: { folderId: { in: ids }, deletedAt: null },
          orderBy: { name: 'asc' },
          // Не `true`: связь отдала бы всю запись сотрудника, с хешем пароля
          include: {
            mainTags: true,
            updatedBy: { select: { id: true, name: true, symbol: true } },
            createdBy: { select: { id: true, name: true, symbol: true } },
          },
        }),
        prisma.folder.findMany({
          where: { parentId: { in: ids }, deletedAt: null },
          orderBy: { name: 'asc' },
        }),
        // Число на значке корзины: пустая она или нет, видно не заходя в неё.
        // Считаем и папки — в корзине Проводника лежат и они, и показывать
        // «пусто» на непустой корзине нельзя
        Promise.all([
          // Считаем только то, что человеку видно в корзине: чужие удалённые
          // личные файлы в число не входят (и не выдают, что они были)
          prisma.fileNode.count({ where: { deletedAt: { not: null }, type: { not: 'CHAT_FILE' }, ...personalScopeWhere(authUserOf(req), mainAdminId) } }),
          prisma.folder.count({ where: { projectId, deletedAt: { not: null }, ...personalScopeWhere(authUserOf(req), mainAdminId) } }),
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

  // «Выложить на общий стол» и обратно. Это перенос между двумя папками
  // Проводника — тот же, что перетаскиванием в самом Проводнике, поэтому
  // никакой особой записи здесь нет: меняется папка и раздел.
  //
  // Файл переносится под сверкой версии: `expectedVersion` в теле — целая версия, которую
  // показывал стол. Файл изменили — 409 `VERSION_CONFLICT` с записью (без содержимого) в
  // `current`; файла нет или он человеку не виден — 404 `RECORD_GONE`. Нечитаемая версия — 400.
  // Версию присылают только за файл: у папки её нет, и перенос папки сверки не знает.
  app.post('/api/desktop/move', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    try {
      const expectedVersion = expectedVersionOf(req.body?.expectedVersion);
      if (expectedVersion === null) return badVersion(res);
      const projectId = await resolveProjectId(String(req.body?.projectId || ''));
      const me = deskOwner(req);
      const to = req.body?.to === 'SHARED' ? 'SHARED' : 'PERSONAL';
      if (to === 'PERSONAL' && !me) return res.status(401).json({ error: 'Нужно войти в программу.' });
      const id = String(req.body?.id || '');

      const file = await prisma.fileNode.findFirst({ where: { id }, omit: { content: true } });
      // Переносить можно только то, что человеку видно и что он вправе менять.
      // Раньше номер чужого личного файла или папки принимался как есть, и
      // перенос «на свой стол» делал вызывающего его владельцем (ownerId ниже
      // берётся из сессии) — то есть отнимал файл у хозяина. Чужой и исчезнувший
      // файл отвечают одинаково: иначе ответ подтверждал бы, что такой номер есть
      if (file && !(await canWriteFile(prisma, authUserOf(req), file))) return sendRecordGone(res, 'file');
      // Версию присылают только за файл: нет файла, а версия есть — его уже удалили
      if (!file && expectedVersion !== undefined) return sendRecordGone(res, 'file');
      if (!file && !(await canAccessFolder(prisma, authUserOf(req), id))) {
        return res.status(404).json({ error: FOLDER_NOT_FOUND });
      }
      if (file) {
        // Забрать с общего стола чужое нельзя: положивший его коллега не должен
        // однажды обнаружить, что документ уехал в чей-то личный раздел
        if (file.scope === 'SHARED' && to === 'PERSONAL' && file.createdById && file.createdById !== me) {
          return res.status(403).json({ error: 'Этот файл положил на общий стол другой сотрудник — забрать его себе нельзя.' });
        }
        // Папка стола заводится, если её ещё нет, — побочное действие: делаем его только по свежей записи
        assertExpectedVersion(file, expectedVersion, (current) => editChangedText('file', current?.name));
        const target = await ensureDeskFolder(projectId, to, me);
        const done = await guardedWrite(prisma, {
          model: 'fileNode', id, expectedVersion, goneNoun: 'file',
          staleMessage: (current) => editChangedText('file', current?.name),
          build: () => ({ data: { folderId: target.id, scope: to, ownerId: to === 'PERSONAL' ? me : null } }),
        });
        if (!done) return sendRecordGone(res, 'file');
        return res.json({ success: true, version: done.after.version });
      }

      const target = await ensureDeskFolder(projectId, to, me);
      const folder = await prisma.folder.findFirst({ where: { id } });
      if (!folder) return res.status(404).json({ error: 'Не найдено.' });
      if (folder.system) return res.status(403).json({ error: 'Это системная папка — её нельзя перенести.' });
      await prisma.folder.update({ where: { id }, data: { parentId: target.id } });
      // Не только сама папка: всё содержимое, включая подпапки. Иначе внутри
      // общей папки останется личное — видимое одному владельцу
      await applyScopeRecursive(id, to, to === 'PERSONAL' ? me : null);
      res.json({ success: true });
    } catch (err: any) {
      if (sendGuardRefusal(res, err, withoutContent)) return;
      sendError(res, err);
    }
  });
}
