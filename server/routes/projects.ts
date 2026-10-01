import { isPrivilegedUser } from '../accessPolicy.js';
import type { Express, Request, Response } from 'express';
import { getPrisma } from '../context.js';
import { canSeeProject, registerProjectAccessGuard } from './members.js';
import { forgetProjectSelections } from './builder.js';

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

  app.put('/api/projects/:id', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    if (!(await enforce(req, res, 'project.manage'))) return;
    try {
      const { id } = req.params;
      const { name, code, customer, contractor, description, info, status } = req.body;
      const data: any = {};
      // Переименовать проект в пробелы — то же, что стереть имя: не даём
      if (name !== undefined) data.name = String(name).trim() || 'Без названия';
      if (code !== undefined) data.code = code;
      if (customer !== undefined) data.customer = customer;
      if (contractor !== undefined) data.contractor = contractor;
      if (description !== undefined) data.description = description;
      if (info !== undefined) data.info = info;
      if (status !== undefined) data.status = status;
      const project = await prisma.project.update({ where: { id }, data });
      res.json({ project });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/projects/:id', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    if (!(await enforce(req, res, 'project.manage'))) return;
    try {
      const { id } = req.params;
      const doomed = await prisma.project.findUnique({ where: { id } });
      await prisma.project.delete({
        where: { id }
      });
      await forgetProjectSelections(id);
      if (doomed) {
        await notifyAll('ПРОЕКТЫ', `Проект удалён: ${doomed.name}`,
          'Все его теги, файлы и документы удалены вместе с ним.', '/projects',
          String((req as any).authUser?.id || ''));
      }
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
