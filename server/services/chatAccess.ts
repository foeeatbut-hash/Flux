import { getPrisma } from '../context.js';
import { canSeeProject } from '../routes/members.js';
import { isAdminActor } from '../projectAccess.js';
import { isPrivilegedUser } from '../accessPolicy.js';
const SERVICE_USER_ID = 'flux-guide-service';

export const actorId = (req: any): string => String(req?.authUser?.id || '');

export async function isGroupMember(userId: string, groupId: string): Promise<boolean> {
  const prisma = getPrisma();
  if (!userId || !groupId) return false;
  const group = await prisma.chatGroup.findUnique({
    where: { id: String(groupId) },
    select: { ownerId: true, projectId: true, members: { where: { id: userId }, select: { id: true } } },
  });
  if (!group || !(group.ownerId === userId || group.members.length > 0)) return false;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
  return !group.projectId || await canSeeProject(userId, group.projectId, isPrivilegedUser(user));
}

export async function isChatParticipant(userId: string, message: any): Promise<boolean> {
  if (!userId) return false;
  if (message?.chatGroupId) return isGroupMember(userId, message.chatGroupId);
  if (message?.senderId === SERVICE_USER_ID) {
    const id = message.replyToId || message.replyTo?.id;
    if (!id) return false;
    const request = await getPrisma().chatMessage.findUnique({
      where: { id: String(id) },
      select: { senderId: true, receiverId: true, chatGroupId: true, guideRequest: true },
    });
    return !!request?.guideRequest && !request.chatGroupId &&
      (request.senderId === userId || request.receiverId === userId);
  }
  return message?.senderId === userId || message?.receiverId === userId;
}

/** Is this stored row part of the direct conversation between the two users? */
export async function isDirectConversationMessage(message: any, userA: string, userB: string): Promise<boolean> {
  if (!message || message.chatGroupId) return false;
  if (message.senderId === SERVICE_USER_ID) {
    const id = message.replyToId || message.replyTo?.id;
    if (!id) return false;
    const request = await getPrisma().chatMessage.findUnique({
      where: { id: String(id) },
      select: { senderId: true, receiverId: true, chatGroupId: true, guideRequest: true },
    });
    return !!request?.guideRequest && !request.chatGroupId &&
      ((request.senderId === userA && request.receiverId === userB) || (request.senderId === userB && request.receiverId === userA));
  }
  return (message.senderId === userA && message.receiverId === userB) ||
    (message.senderId === userB && message.receiverId === userA);
}

export async function canReadChatMessage(userId: string, user: any, message: any): Promise<boolean> {
  if (!(await isChatParticipant(userId, message))) return false;
  let projectId = String(message?.guideReply?.projectId || message?.linkedProjectId || '');
  if (!projectId && message?.linkedElementId) {
    const element = await getPrisma().componentElement.findUnique({
      where: { id: message.linkedElementId },
      select: { monoblock: { select: { system: { select: { projectId: true } } } } },
    });
    projectId = String(element?.monoblock?.system?.projectId || '');
  }
  return !projectId || await canSeeProject(userId, projectId, isAdminActor(user));
}

export async function sanitizeProjectReferences<T extends any[]>(rows: T, viewerId: string, user: any): Promise<T> {
  const prisma = getPrisma();
  const elementIds = [...new Set(rows.map((row: any) => row.linkedElementId).filter(Boolean))];
  const elements = elementIds.length ? await prisma.componentElement.findMany({
    where: { id: { in: elementIds } },
    select: { id: true, monoblock: { select: { system: { select: { projectId: true } } } } },
  }) : [];
  const elementProjects = new Map((elements as any[]).map((element) => [element.id, element.monoblock?.system?.projectId || '']));
  const projectIds = [...new Set(rows.map((row: any) => row.guideReply?.projectId || row.linkedProjectId || elementProjects.get(row.linkedElementId) || '').filter(Boolean))];
  const allowed = new Map<string, boolean>();
  for (const projectId of projectIds) allowed.set(projectId, await canSeeProject(viewerId, projectId, isAdminActor(user)));
  const sanitize = (row: any): any => {
    const projectId = row.guideReply?.projectId || row.linkedProjectId || elementProjects.get(row.linkedElementId) || '';
    const replyTo = row.replyTo ? sanitize(row.replyTo) : row.replyTo;
    if (!projectId || allowed.get(projectId)) return { ...row, ...(replyTo ? { replyTo } : {}) };
    return {
      ...row,
      content: row.guideReply?.projectId ? 'Данные этого ответа сейчас недоступны' : row.content,
      attachments: [], linkedProjectId: null, linkedElementId: null, linkedElement: null, replyTo,
    };
  };
  return rows.map(sanitize) as T;
}
