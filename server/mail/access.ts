import type { Request } from 'express';
import { getPrisma } from '../context.js';

/**
 * Кто и что может делать с почтовым ящиком.
 *
 * Ящики двух родов, и правила у них разные:
 *
 *  - PERSONAL — личный. Заводит сотрудник сам, их может быть несколько.
 *    Видит и правит только владелец: чужую переписку не показываем никому,
 *    включая администратора. Это строже, чем в остальных разделах.
 *
 *  - SHARED — общая почта компании. Настраивается один раз тем, у кого есть
 *    право `mail.shared.manage`, и дальше видна всем сотрудникам: письма одни и те
 *    же у всех десятерых. Настройки менять может по-прежнему только тот, кому
 *    это право выдано, — иначе любой сотрудник сменил бы пароль ящика.
 */

export type MailRole = 'owner' | 'shared';

export interface MailAccess {
  acc: any;
  role: MailRole;
  /** true для общего ящика — вокруг него другая механика: личное «прочитано», взятие в работу */
  shared: boolean;
}

export const isShared = (acc: any): boolean => String(acc?.scope || 'PERSONAL') === 'SHARED';

/**
 * Ящик, к которому у человека есть доступ на чтение.
 * Чужой личный ящик — это «не найден», а не «нельзя»: сам факт наличия
 * ящика у коллеги — тоже сведения, которых знать незачем.
 */
export async function readableAccount(req: Request, id: string): Promise<MailAccess | null> {
  const prisma = getPrisma();
  const me = (req as any).authUser;
  if (!me || !id) return null;
  const acc = await prisma.mailAccount.findUnique({ where: { id } });
  if (!acc) return null;
  if (isShared(acc)) return { acc, role: 'shared', shared: true };
  if (acc.ownerId === me.id) return { acc, role: 'owner', shared: false };
  return null;
}

/** Все ящики, доступные человеку: свои личные и общий. */
export async function readableAccounts(req: Request): Promise<any[]> {
  const prisma = getPrisma();
  const me = (req as any).authUser;
  if (!me) return [];
  return prisma.mailAccount.findMany({
    where: { OR: [{ ownerId: me.id, scope: 'PERSONAL' }, { scope: 'SHARED' }] },
    orderBy: [{ scope: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
  });
}

// ── Личная отметка «прочитано» в общем ящике ─────────────────────────────────
//
// Флаг \Seen в IMAP один на весь ящик: открыл письмо один сотрудник — оно
// перестало быть непрочитанным у всех девяти. Для общей почты это неверно,
// поэтому у общего ящика «прочитано» своё у каждого и лежит у нас.
//
// Ключ — Message-ID из заголовка письма, а не наш id: наши строки создаются
// заново при пересинхронизации папки и при смене uidValidity, и отметки
// прочтения слетали бы вместе с ними.

export const msgKeyOf = (m: { messageId?: string | null; id: string }): string =>
  String(m.messageId || '') || `local:${m.id}`;

/** Какие письма этот человек уже видел. Ключи — как у msgKeyOf(). */
export async function seenKeys(accountId: string, userId: string): Promise<Set<string>> {
  const prisma = getPrisma();
  const rows = await prisma.mailSeenLocal.findMany({
    where: { accountId, userId }, select: { msgKey: true },
  });
  return new Set(rows.map((r: any) => r.msgKey));
}

/** Отметить прочитанным или снять отметку. */
export async function setSeenLocal(accountId: string, userId: string, keys: string[], on: boolean): Promise<void> {
  const prisma = getPrisma();
  const list = keys.filter(Boolean);
  if (!list.length) return;
  if (!on) {
    await prisma.mailSeenLocal.deleteMany({ where: { accountId, userId, msgKey: { in: list } } });
    return;
  }
  // createMany со skipDuplicates не поддержан частью адаптеров, поэтому
  // просто добавляем недостающие: набор небольшой, это дешевле разбора ошибок
  const have = await prisma.mailSeenLocal.findMany({
    where: { accountId, userId, msgKey: { in: list } }, select: { msgKey: true },
  });
  const known = new Set(have.map((r: any) => r.msgKey));
  for (const msgKey of list) {
    if (known.has(msgKey)) continue;
    await prisma.mailSeenLocal.create({ data: { accountId, userId, msgKey } }).catch(() => { /* гонка двух вкладок */ });
  }
}

/**
 * Непрочитанные по папкам с точки зрения конкретного человека.
 * Для общего ящика считается по личным отметкам, для личного — по флагу IMAP.
 */
export async function unreadByFolder(acc: any, userId: string): Promise<Record<string, number>> {
  const prisma = getPrisma();
  const out: Record<string, number> = {};
  if (!isShared(acc)) {
    const rows = await prisma.mailMessage.groupBy({
      by: ['folderId'], where: { accountId: acc.id, seen: false }, _count: { _all: true },
    }).catch(() => [] as any[]);
    for (const r of rows as any[]) out[r.folderId] = r._count?._all || 0;
    return out;
  }
  // Общий ящик: сверяем каждое письмо с личными отметками. Полей берём три —
  // при девяноста днях переписки это несколько тысяч строк, доли мегабайта.
  const [msgs, seen] = await Promise.all([
    prisma.mailMessage.findMany({
      where: { accountId: acc.id }, select: { id: true, folderId: true, messageId: true },
    }),
    seenKeys(acc.id, userId),
  ]);
  for (const m of msgs as any[]) {
    if (seen.has(msgKeyOf(m))) continue;
    out[m.folderId] = (out[m.folderId] || 0) + 1;
  }
  return out;
}

// ── Состояние переписки в общем ящике ────────────────────────────────────────

/** Состояния всех перечисленных цепочек одним запросом. */
export async function threadStates(accountId: string, keys: string[]): Promise<Map<string, any>> {
  const prisma = getPrisma();
  const list = Array.from(new Set(keys.filter(Boolean)));
  if (!list.length) return new Map();
  const rows = await prisma.mailThreadState.findMany({
    where: { accountId, threadKey: { in: list } },
  });
  return new Map(rows.map((r: any) => [r.threadKey, r]));
}

/** Запись в ленту действий: её видят все, кто работает с общим ящиком. */
export async function addActivity(
  accountId: string, threadKey: string,
  actor: { id: string; name?: string },
  kind: string, note = '',
): Promise<void> {
  const prisma = getPrisma();
  await prisma.mailActivity.create({
    data: {
      accountId, threadKey,
      userId: actor?.id || '', userName: actor?.name || '',
      kind, note: String(note || '').slice(0, 500),
    },
  }).catch(() => { /* лента не должна ронять основное действие */ });
}
