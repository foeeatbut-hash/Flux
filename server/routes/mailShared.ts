import type { Express, Request, Response } from 'express';
import { getPrisma, sendError, notifyUser } from '../context.js';
import { readableAccount, addActivity } from '../mail/access.js';

/**
 * Общий рабочий ящик: работа вдесятером над одной перепиской.
 *
 * Обычный почтовый клиент рассчитан на одного человека, и в общем ящике это
 * сразу видно: десять сотрудников открывают одни и те же письма, не зная, что
 * на письмо уже ответил кто-то другой. Двое пишут одно и то же разными
 * словами, а третье письмо не берёт никто — каждый думает, что взяли до него.
 *
 * Поэтому поверх писем лежат две вещи, которых в IMAP нет:
 *
 *  - «взял в работу» — переписка помечается за сотрудником, и остальные это
 *    видят прямо в списке, до того как начнут отвечать;
 *  - лента действий — кто взял, кто ответил, кто оставил пометку. Пометка
 *    видна всем и остаётся в программе: почтовый сервер о ней не знает.
 *
 * Ключ везде — цепочка, а не письмо: в работу берут разговор целиком.
 */

const str = (v: any, max = 300) => String(v ?? '').trim().slice(0, max);

const STATUSES = ['NEW', 'IN_PROGRESS', 'ANSWERED', 'CLOSED'];

/** Доступ к общему ящику. Личный сюда не пускаем: там эта механика не нужна. */
async function sharedAccount(req: Request, accountId: string) {
  const access = await readableAccount(req, accountId);
  if (!access || !access.shared) return null;
  return access.acc;
}

/** Состояние переписки: создаём при первом обращении. */
async function stateOf(accountId: string, threadKey: string) {
  const prisma = getPrisma();
  const found = await prisma.mailThreadState.findFirst({ where: { accountId, threadKey } });
  if (found) return found;
  return prisma.mailThreadState.create({ data: { accountId, threadKey } });
}

/** Кого предупредить о перемене: всех, кто уже отметился в этой переписке. */
async function othersInThread(accountId: string, threadKey: string, exceptId: string): Promise<string[]> {
  const prisma = getPrisma();
  const rows = await prisma.mailActivity.findMany({
    where: { accountId, threadKey }, select: { userId: true },
  }).catch(() => [] as any[]);
  const ids = new Set((rows as any[]).map((r) => r.userId).filter(Boolean));
  ids.delete(exceptId);
  return Array.from(ids);
}

export function registerMailSharedRoutes(app: Express): void {
  /** Взять переписку в работу или отпустить её. */
  app.post('/api/mail/shared/claim', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      const me = (req as any).authUser;
      if (!me) return res.status(401).json({ error: 'Требуется вход' });

      const accountId = str(req.body?.accountId, 60);
      const threadKey = str(req.body?.threadKey, 500);
      const on = req.body?.on !== false;
      const acc = await sharedAccount(req, accountId);
      if (!acc || !threadKey) return res.status(404).json({ error: 'Переписка не найдена' });

      const st = await stateOf(acc.id, threadKey);

      // Переписку, взятую другим, не перехватываем молча: человек должен
      // понимать, что вмешивается в чужую работу
      if (on && st.claimedById && st.claimedById !== me.id) {
        return res.status(409).json({
          error: `Переписку уже ведёт ${st.claimedByName || 'другой сотрудник'}`,
          claimedByName: st.claimedByName,
        });
      }
      // Отпустить может тот, кто взял
      if (!on && st.claimedById && st.claimedById !== me.id) {
        return res.status(403).json({ error: 'Отпустить может тот, кто взял переписку' });
      }

      const next = await prisma.mailThreadState.update({
        where: { id: st.id },
        data: on
          ? {
              claimedById: me.id, claimedByName: me.name || me.symbol || '',
              claimedAt: new Date(),
              status: st.status === 'NEW' ? 'IN_PROGRESS' : st.status,
            }
          : { claimedById: '', claimedByName: '', claimedAt: null },
      });
      await addActivity(acc.id, threadKey, me, on ? 'CLAIMED' : 'RELEASED');
      res.json({ state: next });
    } catch (err) { sendError(res, err); }
  });

  /** Состояние переписки: новая, в работе, отвечено, закрыта. */
  app.post('/api/mail/shared/status', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      const me = (req as any).authUser;
      if (!me) return res.status(401).json({ error: 'Требуется вход' });

      const accountId = str(req.body?.accountId, 60);
      const threadKey = str(req.body?.threadKey, 500);
      const status = str(req.body?.status, 20).toUpperCase();
      const acc = await sharedAccount(req, accountId);
      if (!acc || !threadKey) return res.status(404).json({ error: 'Переписка не найдена' });
      if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Неизвестное состояние' });

      const st = await stateOf(acc.id, threadKey);
      const next = await prisma.mailThreadState.update({ where: { id: st.id }, data: { status } });
      await addActivity(acc.id, threadKey, me, 'STATUS', status);

      for (const uid of await othersInThread(acc.id, threadKey, me.id)) {
        await notifyUser(uid, 'ПОЧТА', `${me.name || 'Сотрудник'}: ${labelOf(status)}`,
          'Общая рабочая почта', '/mail');
      }
      res.json({ state: next });
    } catch (err) { sendError(res, err); }
  });

  /** Пометка коллегам — живёт в программе, на почтовый сервер не уходит. */
  app.post('/api/mail/shared/note', async (req: Request, res: Response) => {
    try {
      const me = (req as any).authUser;
      if (!me) return res.status(401).json({ error: 'Требуется вход' });

      const accountId = str(req.body?.accountId, 60);
      const threadKey = str(req.body?.threadKey, 500);
      const note = str(req.body?.note, 500);
      const acc = await sharedAccount(req, accountId);
      if (!acc || !threadKey) return res.status(404).json({ error: 'Переписка не найдена' });
      if (!note) return res.status(400).json({ error: 'Пустая пометка' });

      await addActivity(acc.id, threadKey, me, 'NOTE', note);
      for (const uid of await othersInThread(acc.id, threadKey, me.id)) {
        await notifyUser(uid, 'ПОЧТА', `${me.name || 'Сотрудник'} оставил пометку`, note, '/mail');
      }
      const prisma = getPrisma();
      const activity = await prisma.mailActivity.findMany({
        where: { accountId: acc.id, threadKey }, orderBy: { createdAt: 'asc' }, take: 50,
      });
      res.json({ activity });
    } catch (err) { sendError(res, err); }
  });

  /** Сводка по общему ящику: сколько ничьих, сколько за мной, сколько в работе. */
  app.get('/api/mail/shared/summary', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      const me = (req as any).authUser;
      const acc = await sharedAccount(req, str(req.query.accountId as string, 60));
      if (!acc || !me) return res.json({ summary: null });

      const states = await prisma.mailThreadState.findMany({ where: { accountId: acc.id } });
      const mine = states.filter((s: any) => s.claimedById === me.id && s.status !== 'CLOSED').length;
      const busy = states.filter((s: any) => s.claimedById && s.claimedById !== me.id && s.status !== 'CLOSED').length;
      const answered = states.filter((s: any) => s.status === 'ANSWERED').length;
      res.json({ summary: { mine, busy, answered, total: states.length } });
    } catch (err) { sendError(res, err); }
  });
}

function labelOf(status: string): string {
  if (status === 'IN_PROGRESS') return 'взял переписку в работу';
  if (status === 'ANSWERED') return 'ответил на письмо';
  if (status === 'CLOSED') return 'закрыл переписку';
  return 'вернул переписку в новые';
}
