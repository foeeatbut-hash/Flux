/**
 * Санитизация сервисных ответов Flux Guide при чтении (F-ACL-03).
 *
 * Правило: у сервисного ответа, привязанного к проекту, при КАЖДОМ чтении
 * (история, поиск, сокет, цитата) сервер пере-проверяет права получателя.
 * Нет доступа — тело заменяется типизированным состоянием access_revoked:
 * «Данные этого ответа сейчас недоступны», без чисел, имён и вложений.
 */
import { getPrisma } from '../context.js';
import { canSeeProject } from '../routes/members.js';
import { isAdminActor } from '../projectAccess.js';

const REVOKED_TEXT = 'Данные этого ответа сейчас недоступны';
const SERVICE_SENDER_ID = 'flux-guide-service';
const UNKNOWN_SCOPE = '__guide_scope_unknown__';

interface SanitizableRow {
  id: string;
  senderId?: string;
  content?: string;
  attachments?: unknown[];
  guideReply?: { projectId: string; kind: string } | null;
  replyTo?: SanitizableRow | null;
  [key: string]: unknown;
}

/**
 * Заменяет содержимое сервисных ответов, привязанных к проекту, если текущему
 * пользователю проект недоступен. Остальные сообщения не трогает.
 */
export async function sanitizeGuideReplies<T extends SanitizableRow>(rows: T[], viewerId: string, isAdmin: boolean): Promise<T[]> {
  const projectIds = new Set<string>();
  const collect = (row: SanitizableRow | null | undefined): void => {
    if (!row) return;
    if (row.guideReply?.projectId) projectIds.add(row.guideReply.projectId);
    collect(row.replyTo);
  };
  rows.forEach(collect);
  if (!projectIds.size) return rows;

  // Одна проверка на проект за батч
  const allowed = new Map<string, boolean>();
  for (const pid of projectIds) {
    allowed.set(pid, pid !== UNKNOWN_SCOPE && await canSeeProject(viewerId, pid, isAdmin));
  }

  const sanitize = <R extends SanitizableRow>(row: R): R => {
    const pid = row.guideReply?.projectId;
    if (!pid || allowed.get(pid)) {
      return row.replyTo ? { ...row, replyTo: sanitize(row.replyTo) } : row;
    }
    return {
      ...row,
      content: REVOKED_TEXT,
      attachments: [],
      guideAccessRevoked: true,
      replyTo: row.replyTo ? sanitize(row.replyTo) : row.replyTo,
    } as R;
  };
  return rows.map(sanitize);
}

export const isRevokedText = (content: string): boolean => content === REVOKED_TEXT;

/**
 * Миграция прежних плоских F-ответов: у каждого сообщения сервисного
 * отправителя без записи GuideReply она создаётся с проектом его разговора.
 * Вызывается при старте роутов Guide; идемпотентна. Обычные сообщения
 * сотрудников не затрагиваются.
 */
export async function backfillGuideReplies(): Promise<number> {
  const prisma = getPrisma();
  const service = await prisma.user.findUnique({ where: { id: SERVICE_SENDER_ID }, select: { id: true } });
  if (!service) return 0;
  let migrated = 0;
  while (true) {
    const rows = await prisma.chatMessage.findMany({
      where: { senderId: SERVICE_SENDER_ID, guideReply: null },
      select: { id: true, chatGroupId: true, receiverId: true, replyToId: true, linkedProjectId: true },
      orderBy: { createdAt: 'asc' },
      take: 500,
    });
    if (!rows.length) break;
    for (const row of rows as any[]) {
      let projectId = row.linkedProjectId || UNKNOWN_SCOPE;
      if (row.chatGroupId) {
        const g = await prisma.chatGroup.findUnique({ where: { id: row.chatGroupId }, select: { projectId: true } });
        projectId = g?.projectId || UNKNOWN_SCOPE;
      } else if (row.replyToId) {
        // Ответ в личном чате: проект берём из исходного запроса по группе, иначе пусто
        const req = await prisma.chatMessage.findUnique({ where: { id: row.replyToId }, select: { chatGroupId: true } });
        if (req?.chatGroupId) {
          const g = await prisma.chatGroup.findUnique({ where: { id: req.chatGroupId }, select: { projectId: true } });
          projectId = g?.projectId || projectId;
        }
      }
      await prisma.guideReply.upsert({
        where: { messageId: row.id },
        update: { projectId, kind: 'legacy' },
        create: { messageId: row.id, projectId, kind: 'legacy' },
      });
      migrated += 1;
    }
  }
  return migrated;
}

export { SERVICE_SENDER_ID, REVOKED_TEXT, UNKNOWN_SCOPE };
