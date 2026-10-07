import type { Express, Request, Response } from 'express';
import { getPrisma } from '../context.js';
import { isPrivilegedUser } from '../accessPolicy.js';
import { canSeeProject } from './members.js';
import { readTagHistory, tagFieldLabel, TAG_CHANGE_KIND, type TagChangeRow } from '../tagHistory.js';
import { buildPassport } from '../tagPassportData.js';
import { readableAccounts } from '../mail/access.js';

/**
 * Паспорт тега: всё, что известно о теге, одним запросом, и история его
 * изменений.
 *
 * Права — те же, что у остальных запросов к тегам: доступ к проекту тега. Общий
 * страж по адресу (`projectEntityAccess.ts`) проверяет проект существующего тега,
 * но удалённого тега в базе нет, а история его осталась, — поэтому здесь проект
 * берётся и из самой истории: иначе по идентификатору удалённого тега любой
 * вошедший прочитал бы чужие правки.
 */

const NO_ACCESS = { error: 'Нет доступа к проекту. Попросите добавить вас в состав.' };

async function mayUseProject(req: Request, projectId: string): Promise<boolean> {
  const me = (req as any).authUser;
  return canSeeProject(String(me?.id || ''), projectId, isPrivilegedUser(me));
}

export interface TagHistoryItem extends TagChangeRow {
  /** Подпись поля для человека: «Наименование», «Закупка: этап» */
  fieldLabel: string;
  /** Имя автора; пусто, если пользователя больше нет или правка пришла не из-под сессии */
  userName: string;
}

/** История тега с подписанными полями и именами авторов. */
export async function tagHistoryItems(prisma: any, tagId: string, limit?: number): Promise<TagHistoryItem[]> {
  const rows = await readTagHistory(prisma, tagId, { limit });
  const ids = [...new Set(rows.map((r) => r.userId).filter((v): v is string => !!v))];
  const names = new Map<string, string>();
  if (ids.length) {
    const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
    for (const u of users) names.set(String(u.id), String(u.name || ''));
  }
  return rows.map((r) => ({ ...r, fieldLabel: r.field ? tagFieldLabel(r.field) : '', userName: r.userId ? (names.get(r.userId) || '') : '' }));
}

export function registerTagPassportRoutes(app: Express): void {
  // История изменений тега, новое сверху. Работает и для удалённого тега.
  app.get('/api/tags/:id/history', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    try {
      const tagId = String(req.params.id || '');
      const tag = await prisma.tag.findUnique({ where: { id: tagId }, select: { projectId: true } });
      const items = await tagHistoryItems(prisma, tagId, Number(req.query.limit) || undefined);
      // Проект — по тегу, а если его уже нет, по самой истории
      const projectId = tag?.projectId || items[0]?.projectId || '';
      if (projectId && !(await mayUseProject(req, projectId))) return res.status(403).json(NO_ACCESS);
      res.json({ history: items });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Не удалось прочитать историю тега' });
    }
  });

  // Паспорт тега: сам тег, примечания всех источников, закупка, состав и дубли
  // кода, «где используется» (без ВДР) и история — одним запросом.
  // Права: доступ к проекту тега. Общий страж по адресу уже проверил его для
  // существующего тега; проверка здесь — второй замок на случай, если страж
  // однажды переедет.
  app.get('/api/tags/:id/passport', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    try {
      const tagId = String(req.params.id || '');
      const tag = await prisma.tag.findUnique({ where: { id: tagId } });
      // Тег закрытого проекта сюда не доходит: страж отвечает 403 раньше, чем выясняется, есть ли он
      if (!tag) return res.status(404).json({ error: 'Тег не найден' });
      if (!(await mayUseProject(req, tag.projectId))) return res.status(403).json(NO_ACCESS);
      const me = (req as any).authUser;
      // 2000 — потолок чтения: «создан» лежит в самом конце ленты, и он нужен шапке
      const all = await tagHistoryItems(prisma, tagId, 2000);
      let mailAccountIds: string[] = [];
      try { mailAccountIds = (await readableAccounts(req)).map((a: any) => a.id); } catch { /* почты нет — писем в паспорте нет */ }
      const passport = await buildPassport(prisma, tag, { userId: me?.id, mailAccountIds }, all);
      const born = [...all].reverse().find((r) => r.kind === TAG_CHANGE_KIND.created);
      const last = all[0];
      res.json({
        ...passport,
        // Автор создания — из истории; у тега, заведённого до истории, его нет
        created: { at: born?.at || passport.tag.createdAt, by: born?.userName || '' },
        updated: { at: last?.at || passport.tag.updatedAt, by: last?.userName || '' },
        history: all.slice(0, 500),
        historyTotal: all.length,
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Не удалось собрать паспорт тега' });
    }
  });
}
