/**
 * Вход в Flux Studio: пускает право «Разработка подпрограмм» или вход владельца.
 *
 * Права проверяет сервер, а не окно Studio: окно может быть любым, в том числе
 * чужим клиентом с украденным токеном обычного сотрудника. Администратор без
 * этого права в Studio не входит — доступ к разработке выдаётся отдельно.
 */
import type { Express, Request, Response } from 'express';

export interface StudioDeps {
  getPrisma: () => any;
  can?: (user: any, feature: string) => boolean;
}

/** Предел списка своих подпрограмм: у одного разработчика их не сотни, а ответ не должен расти без границы */
export const STUDIO_MODULE_LIMIT = 200;

export function registerStudioRoutes(app: Express, deps: StudioDeps): void {
  const mayDevelop = (req: Request): boolean => {
    const user = (req as any).authUser;
    return user?.role === 'OWNER' || (deps.can ? deps.can(user, 'module.develop') : false);
  };
  const refuse = (res: Response) => res.status(403).json({
    error: 'Flux Studio открывается с правом «Разработка подпрограмм». Попросите администратора выдать его.',
  });

  app.get('/api/studio/session', (req: Request, res: Response) => {
    if (!mayDevelop(req)) return refuse(res);
    const user = (req as any).authUser;
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, owner: user.role === 'OWNER', user: { id: String(user.id), name: String(user.name || '') } });
  });

  /** Свои подпрограммы: последняя отправленная версия и состояние запроса на публикацию */
  app.get('/api/studio/modules', async (req: Request, res: Response) => {
    if (!mayDevelop(req)) return refuse(res);
    const user = (req as any).authUser;
    const rows: any[] = await deps.getPrisma().moduleRequest.findMany({
      where: { authorId: String(user.id) }, orderBy: { createdAt: 'desc' }, take: 1000,
      select: { moduleId: true, version: true, state: true, createdAt: true },
    });
    const byModule = new Map<string, { moduleId: string; version: string; state: string; createdAt: Date; requests: number }>();
    for (const row of rows) {
      const known = byModule.get(row.moduleId);
      if (known) known.requests++;
      else if (byModule.size < STUDIO_MODULE_LIMIT) byModule.set(row.moduleId, { ...row, requests: 1 });
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({ modules: [...byModule.values()] });
  });
}
