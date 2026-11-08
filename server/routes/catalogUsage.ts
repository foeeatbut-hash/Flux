import type { Express, Request, Response } from 'express';
import { getPrisma, sendError } from '../context.js';
import { canSeeProject } from './members.js';
import { assertGlobalFamily } from '../catalogWorkspace.js';
import { isAdminActor } from '../projectAccess.js';

/**
 * Где используется модель каталога: проекты и ведомости Конструктора, в которых
 * есть позиции этой модели. Только чтение.
 *
 * Проекты, закрытые от человека составом, не показываются и не считаются:
 * иначе по числу позиций можно было бы узнать о чужом проекте.
 */
export interface CatalogUsageProject {
  projectId: string;
  projectName: string;
  projectCode: string;
  items: number;
  qty: number;
  lists: Array<{ id: string; name: string; items: number; qty: number }>;
}

const parse = <T>(s: string | null | undefined, fallback: T): T => {
  try { return s ? (JSON.parse(s) as T) : fallback; } catch { return fallback; }
};

export function registerCatalogUsageRoutes(app: Express): void {
  app.get('/api/catalog/family/:id/usage', async (req: Request, res: Response) => {
    try {
      const actor = (req as any).authUser;
      if (!actor?.id) return res.status(401).json({ error: 'Нужно войти в программу' });
      const prisma = getPrisma();
      const familyId = String(req.params.id);
      await assertGlobalFamily(prisma, 'family', familyId);
      let items: any[] = [];
      try {
        items = await prisma.selectionItem.findMany({ where: { familyId, deletedAt: null }, select: { listId: true, projectId: true, dataJson: true } });
      } catch {
        // Таблиц Конструктора может ещё не быть (его никто не открывал): это «не используется», а не ошибка
        return res.json({ usage: [], total: { projects: 0, items: 0, qty: 0 } });
      }
      const listIds = [...new Set(items.map((i) => i.listId))];
      const lists = listIds.length ? await prisma.selectionList.findMany({ where: { id: { in: listIds }, deletedAt: null }, select: { id: true, name: true, projectId: true } }) : [];
      const listById = new Map(lists.map((l: any) => [l.id, l]));
      const projectIds = [...new Set(lists.map((l: any) => l.projectId))] as string[];
      const projects = projectIds.length ? await prisma.project.findMany({ where: { id: { in: projectIds } } }) : [];
      const admin = isAdminActor(actor);
      const byProject = new Map<string, CatalogUsageProject>();
      for (const project of projects as any[]) {
        if (!(await canSeeProject(actor.id, project.id, admin))) continue;
        byProject.set(project.id, { projectId: project.id, projectName: project.name || '', projectCode: project.code || '', items: 0, qty: 0, lists: [] });
      }
      for (const item of items) {
        const list: any = listById.get(item.listId);
        const entry = list && byProject.get(list.projectId);
        if (!entry) continue;
        const qty = Number(parse<any>(item.dataJson, {}).qty) || 0;
        let row = entry.lists.find((l) => l.id === list.id);
        if (!row) { row = { id: list.id, name: list.name || 'Ведомость', items: 0, qty: 0 }; entry.lists.push(row); }
        row.items++; row.qty += qty; entry.items++; entry.qty += qty;
      }
      const usage = [...byProject.values()].filter((p) => p.items > 0).sort((a, b) => b.items - a.items || a.projectName.localeCompare(b.projectName, 'ru'));
      res.json({ usage, total: { projects: usage.length, items: usage.reduce((s, p) => s + p.items, 0), qty: usage.reduce((s, p) => s + p.qty, 0) } });
    } catch (err: any) { sendError(res, err, err.status || 500); }
  });
}
