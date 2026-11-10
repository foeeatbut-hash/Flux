/**
 * Вход в Flux Studio: пускает вход владельца или ЯВНОЕ право «Разработка подпрограмм».
 *
 * Права проверяет сервер, а не окно: окно может быть любым, в том числе чужим
 * клиентом с украденным токеном обычного сотрудника. Общая проверка прав (userCan)
 * здесь намеренно не используется: она отдаёт администратору любое право, кроме
 * admin.*, а в Studio администратор без явно выданного module.develop (в личных
 * правах или в его должностях) не входит — разработка выдаётся отдельно.
 */
import type { Express, Request, Response } from 'express';

export interface StudioDeps {
  getPrisma: () => any;
  /** Действующие права человека: личные поверх прав его должностей (как effectivePermsOf на сервере) */
  permissionsOf: (user: any) => Promise<Record<string, any>>;
}

/** Предел списка своих подпрограмм: у одного разработчика их не сотни, а ответ не должен расти без границы */
export const STUDIO_MODULE_LIMIT = 200;

/** Явное и действующее право: включено, не просрочено, профиль активен и не истёк */
export function explicitlyAllowed(user: any, perms: Record<string, any>, feature: string, now = Date.now()): boolean {
  if (!user) return false;
  if (user.role === 'OWNER') return true;
  if (user.isActive === false) return false;
  if (user.validUntil && new Date(user.validUntil).getTime() < now) return false;
  const entry = perms?.[feature];
  if (!entry || entry.enabled !== true) return false;
  return !entry.until || new Date(entry.until).getTime() >= now;
}

/** Единая проверка «явное право разработки»: её берут и вход, и разделы разработчика, и отправка запроса */
export function developerGate(deps: Pick<StudioDeps, 'permissionsOf'>) {
  return async (req: Request): Promise<boolean> => {
    const user = (req as any).authUser;
    if (!user) return false;
    if (user.role === 'OWNER') return true;
    return explicitlyAllowed(user, await deps.permissionsOf(user), 'module.develop');
  };
}
export const refuseDeveloper = (res: Response) => res.status(403).json({
  error: 'Flux Studio открывается с правом «Разработка подпрограмм». Попросите администратора выдать его.',
});

export function registerStudioRoutes(app: Express, deps: StudioDeps): void {
  const mayDevelop = developerGate(deps);
  const refuse = refuseDeveloper;

  app.get('/api/studio/session', async (req: Request, res: Response) => {
    if (!await mayDevelop(req)) return refuse(res);
    const user = (req as any).authUser;
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, owner: user.role === 'OWNER', user: { id: String(user.id), name: String(user.name || '') } });
  });

  /** Свои подпрограммы: последняя отправленная версия, состояние и честное число отправок (считает база, а не выборка) */
  app.get('/api/studio/modules', async (req: Request, res: Response) => {
    if (!await mayDevelop(req)) return refuse(res);
    const user = (req as any).authUser;
    const db = deps.getPrisma();
    const authorId = String(user.id);
    const groups: any[] = await db.moduleRequest.groupBy({
      by: ['moduleId'], where: { authorId }, _count: { _all: true }, _max: { createdAt: true },
      orderBy: { _max: { createdAt: 'desc' } }, take: STUDIO_MODULE_LIMIT,
    });
    const modules = [];
    for (const group of groups) {
      const last = await db.moduleRequest.findFirst({
        where: { authorId, moduleId: group.moduleId }, orderBy: { createdAt: 'desc' }, select: { moduleId: true, version: true, state: true, createdAt: true },
      });
      if (last) modules.push({ ...last, requests: group._count._all });
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({ modules });
  });
}
