import { isPrivilegedUser } from '../accessPolicy.js';
import type { Express, Request, Response } from 'express';
import { getPrisma } from '../context.js';
import { canSeeProject, registerProjectAccessGuard } from './members.js';
import { forgetProjectSelections } from './builder.js';
import { nextProjectId } from '../entityIds.js';
import { cleanupEquipmentDocumentBindingLedger } from './equipmentDocumentBindings.js';
import { cleanupProjectFolderBindingLedger } from './projectFolderBindings.js';
import { deleteProjectData } from '../projectDelete.js';
import { ensureSharing, forgetFileShare } from '../fileSharing.js';
import { expectedVersionOf, guardedWrite, guardedDelete, sendRecordGone, sendGuardRefusal } from '../versionGuard.js';
import { badVersion } from '../equipmentStale.js';
import { projectOpenCascade } from '../projectOpenCascade.js';
import { editChangedText, deleteChangedText } from '../../src/lib/refusalTexts.js';

// Проекты: список с учётом состава, создание, правка и удаление.
//
// Вынесено из server.ts. Проверка прав (enforce) и рассылка уведомлений
// команде (notifyAll) нужны и остальному server.ts, поэтому передаются при
// подключении, а не импортируются обратно — это был бы круг.

interface ProjectDeps {
  /** Страж эндпоинта: сам отвечает 401/403 и возвращает false */
  enforce: (req: Request, res: Response, feature: string) => Promise<boolean>;
  /** Уведомление всей команде, кроме инициатора */
  notifyAll: (category: string, title: string, body?: string, targetRoute?: string, exceptUserId?: string) => Promise<void>;
}

export function registerProjectRoutes(app: Express, deps: ProjectDeps): void {
  const { enforce, notifyAll } = deps;
  // Проверка видимости проекта — один общий слой на все маршруты данных проекта,
  // подключённые ниже по server.ts (теги, справочники, ведомости, реестр ВДР…)
  registerProjectAccessGuard(app);
  app.get('/api/projects', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    // Служебный проект «Общий диск» — не проект, а место хранения: в
    // переключателе он ни к чему, и переключиться «в диск» человек не должен
    const projects = await prisma.project.findMany({ where: { system: false } });
    // Человек видит только те проекты, в которые его позвали. Проект, куда ещё
    // никого не звали, виден всем: включать ограничение задним числом на базе,
    // которая о составе не знает, — значит отобрать у отдела всё разом
    const me = (req as any).authUser || null;
    const isAdmin = isPrivilegedUser(me);
    const mine: any[] = [];
    for (const p of projects) {
      if (await canSeeProject(me?.id || '', p.id, isAdmin)) mine.push(p);
    }
    res.json({ projects: mine });
  });

  app.post('/api/projects', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    if (!(await enforce(req, res, 'project.manage'))) return;
    const { name, code, customer, contractor, description, info } = req.body;
    const project = await prisma.project.create({
      data: {
        id: await nextProjectId(prisma),
        // Имя из одних пробелов ничем не лучше пустого: в переключателе проектов
        // такая строка выглядела пустой и выбрать её вслепую было нельзя
        name: String(name ?? '').trim() || 'Без названия',
        code: code || '',
        customer: customer || '',
        contractor: contractor || '',
        description: description || '',
        info: info || '',
        status: 'ACTIVE'
      }
    });
    // Новый проект — событие для всей команды: люди должны узнать о нём
    // из программы, а не из разговора в коридоре.
    await notifyAll('ПРОЕКТЫ', `Новый проект: ${project.name}`,
      project.customer ? `Заказчик: ${project.customer}` : '', '/projects',
      String((req as any).authUser?.id || ''));
    res.json({ project });
  });

  // Правка проекта под сверкой версии: `expectedVersion` в теле — целая версия, которую
  // клиент видел. Проект изменили — 409 `VERSION_CONFLICT` с текущей записью в `current`,
  // проекта нет — 404 `RECORD_GONE`; без версии запись сверяется с чтением сервера.
  app.put('/api/projects/:id', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    if (!(await enforce(req, res, 'project.manage'))) return;
    try {
      const { id } = req.params;
      const { name, code, customer, contractor, description, info, status } = req.body;
      const expectedVersion = expectedVersionOf(req.body?.expectedVersion);
      if (expectedVersion === null) return badVersion(res);
      const data: any = {};
      // Переименовать проект в пробелы — то же, что стереть имя: не даём
      if (name !== undefined) data.name = String(name).trim() || 'Без названия';
      if (code !== undefined) data.code = code;
      if (customer !== undefined) data.customer = customer;
      if (contractor !== undefined) data.contractor = contractor;
      if (description !== undefined) data.description = description;
      if (info !== undefined) data.info = info;
      if (status !== undefined) data.status = status;
      const done = await guardedWrite(prisma, {
        model: 'project', id, expectedVersion, goneNoun: 'project',
        staleMessage: (current) => editChangedText('project', current?.name),
        build: () => ({ data }),
      });
      if (!done) return sendRecordGone(res, 'project');
      res.json({ project: done.after });
    } catch (err: any) {
      if (sendGuardRefusal(res, err)) return;
      res.status(500).json({ error: err.message });
    }
  });

  // Удаление проекта: версия в строке запроса (`?expectedVersion=`, у DELETE тела нет).
  // Проект и всё, что уйдёт с ним, не должны быть открыты у коллеги (409 `RECORD_OPEN`);
  // каскад и сама строка — одна транзакция: либо проект исчез целиком, либо не тронут.
  // Повторное удаление находит пустоту и отвечает успехом (`alreadyGone`).
  app.delete('/api/projects/:id', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    if (!(await enforce(req, res, 'project.manage'))) return;
    try {
      const { id } = req.params;
      const expectedVersion = expectedVersionOf(req.query.expectedVersion);
      if (expectedVersion === null) return badVersion(res);
      const doomed = await prisma.project.findUnique({ where: { id } });
      // Общий диск — не проект, а место хранения: его удаление унесло бы файлы всего отдела
      if (doomed?.system) return res.status(400).json({ error: 'Служебный проект удалить нельзя' });
      if (doomed) await ensureSharing(prisma);
      const userId = String((req as any).authUser?.id || '');
      let removed: Record<string, number> = {};
      const gone = await guardedDelete(prisma, {
        model: 'project', id, expectedVersion,
        staleMessage: (current) => deleteChangedText('project', current?.name),
        // Открытое у коллег внутри проекта — в cascade: тегов в проекте могут быть тысячи,
        // поэтому обход идёт от чужих отметок (server/projectOpenCascade.ts)
        openCheck: { userId, cascade: (db, current) => projectOpenCascade(db, userId, current.id) },
        // Каскад и журналы привязок — в той же транзакции, что и строка проекта (её
        // снимает guardedDelete последней, под версией). Время — как у прежнего удаления
        before: async (db: any) => {
          removed = await deleteProjectData(db, id, forgetFileShare, { keepProjectRow: true });
          await cleanupEquipmentDocumentBindingLedger(db, id);
          await cleanupProjectFolderBindingLedger(db, id);
        },
        transaction: { timeout: 120_000, maxWait: 30_000 },
      });
      await forgetProjectSelections(id);
      if (!gone) return res.json({ success: true, alreadyGone: true, removed: {} });
      removed.project = 1;
      await notifyAll('ПРОЕКТЫ', `Проект удалён: ${gone.before.name}`,
        'Все его теги, файлы и документы удалены вместе с ним.', '/projects',
        userId);
      res.json({ success: true, removed });
    } catch (err: any) {
      if (sendGuardRefusal(res, err)) return;
      res.status(500).json({ error: err.message });
    }
  });
}
