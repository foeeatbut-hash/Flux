import type { Server as SocketIOServer } from 'socket.io';
import { getPrisma } from './context.js';
import { canSeeProject } from './routes/members.js';
import { isAdminActor } from './projectAccess.js';

/** Событие проекта адресуется только текущему составу, без кэша комнат. */
export async function emitProjectEvent(io: SocketIOServer, projectId: string, event: string, payload: unknown, excludeSocketId?: string): Promise<void> {
  try {
    const prisma = getPrisma();
    const sockets = await io.fetchSockets();
    const ids = [...new Set(sockets.map(s => String((s as any).userId || s.data?.userId || '')).filter(Boolean))];
    if (!ids.length) return;
    const [members, users] = await Promise.all([
      prisma.projectMember.findMany({ where: { projectId }, select: { userId: true } }),
      prisma.user.findMany({ where: { id: { in: ids }, isActive: true }, select: { id: true, role: true, validUntil: true } }),
    ]);
    const joined = new Set(members.map((m: any) => m.userId));
    const allowed = new Set(users.filter((u: any) => (!u.validUntil || new Date(u.validUntil).getTime() >= Date.now()) && (isAdminActor(u) || !joined.size || joined.has(u.id))).map((u: any) => u.id));
    for (const socket of sockets) if (socket.id !== excludeSocketId && allowed.has((socket as any).userId || socket.data?.userId)) socket.emit(event, payload);
  } catch (_) { /* отказ БД не должен превращаться в рассылку всем */ }
}

/** Клиент сообщает только идентификатор; содержание берём из записанной сущности. */
export async function relayProjectEvent(io: SocketIOServer, actor: any, socketId: string, event: 'tag:linked' | 'tag:updated' | 'equipment:conflict', input: any): Promise<boolean> {
  if (!actor?.id || actor.isActive === false) return false;
  const prisma = getPrisma();
  let projectId: string;
  let payload: any;
  if (event === 'equipment:conflict') {
    if (typeof input?.componentId !== 'string' || input.componentId.length > 200) return false;
    const row = await prisma.componentElement.findUnique({ where: { id: input.componentId }, include: { monoblock: { include: { system: true } } } });
    if (!row?.hasConflict) return false;
    projectId = row.monoblock.system.projectId;
    payload = { componentId: row.id, systemId: row.monoblock.system.id, projectId, message: `Конфликт в установке «${row.monoblock.system.name}», элемент «${row.name}»`, changeDetails: row.conflictLog || 'Параметры изменены в ревизии файла' };
  } else {
    if (typeof input?.tagId !== 'string' || input.tagId.length > 200) return false;
    const row = await prisma.tag.findUnique({ where: { id: input.tagId }, select: { id: true, projectId: true } });
    if (!row) return false;
    projectId = row.projectId;
    payload = { tagId: row.id, projectId, timestamp: new Date().toISOString() };
  }
  if (!(await canSeeProject(actor.id, projectId, isAdminActor(actor)))) return false;
  await emitProjectEvent(io, projectId, event, payload, socketId);
  return true;
}
