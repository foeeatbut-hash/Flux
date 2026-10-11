import type { Express, Request, Response } from 'express';
import { getPrisma } from '../context.js';
import { isPrivilegedUser } from '../accessPolicy.js';
import { isAdminActor } from '../projectAccess.js';
import { canSeeProject } from './members.js';
import { sanitizeGuideReplies } from '../services/guideReplies.js';
import { SERVICE_USER_ID } from '../services/guideF.js';
import { actorId, canReadChatMessage, isChatParticipant, isGroupMember, sanitizeProjectReferences } from '../services/chatAccess.js';

const directPeerId = (row: any, me: string): string | null => row.senderId === SERVICE_USER_ID
  ? row.replyTo?.senderId === me ? row.replyTo.receiverId : row.replyTo?.receiverId === me ? row.replyTo.senderId : null
  : row.senderId === me ? row.receiverId : row.receiverId === me ? row.senderId : null;

export function registerChatHistoryRoutes(app: Express): void {
  /** Индекс разговоров строится из постоянной истории, а непрочитанное —
   * из серверных уведомлений; локальный список людей не является историей чатов. */
  app.get('/api/chat/index', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    const me = actorId(req);
    if (!me) return res.status(401).json({ error: 'Нужен вход' });
    try {
      const groups = await prisma.chatGroup.findMany({
        where: { OR: [{ ownerId: me }, { members: { some: { id: me } } }] },
        include: { members: { select: { id: true } } },
        orderBy: { createdAt: 'asc' },
      });
      const visibleGroups = [] as any[];
      for (const group of groups as any[]) if (await isGroupMember(me, group.id)) visibleGroups.push(group);

      const directRows = await prisma.chatMessage.findMany({
        where: { OR: [
          { chatGroupId: null, OR: [{ senderId: me }, { receiverId: me }] },
          { senderId: SERVICE_USER_ID, chatGroupId: null, replyTo: { is: { guideRequest: true, OR: [{ senderId: me }, { receiverId: me }] } } },
        ] },
        select: { senderId: true, receiverId: true, replyTo: { select: { senderId: true, receiverId: true } } },
      });
      const peerIds = [...new Set((directRows as any[]).map((row) => directPeerId(row, me))
        .filter((id): id is string => !!id && id !== me && id !== 'flux-guide-service'))];
      const peers = await prisma.user.findMany({ where: { id: { in: peerIds }, role: { not: 'SERVICE' } }, select: { id: true, name: true, symbol: true } });
      const groupsResult = await Promise.all(visibleGroups.map(async (group) => {
        const latest = await prisma.chatMessage.findFirst({ where: { chatGroupId: group.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], include: { guideReply: { select: { projectId: true, kind: true } } } });
        const guideSafe = latest ? (await sanitizeGuideReplies([latest as any], me, isAdminActor((req as any).authUser)))[0] : null;
        const safe = guideSafe ? (await sanitizeProjectReferences([guideSafe], me, (req as any).authUser))[0] : null;
        const unread = await prisma.notification.count({ where: { userId: me, category: 'ЧАТ', isRead: false, targetRoute: { contains: `group=${group.id}` } } });
        return { id: `group=${group.id}`, type: 'GROUP', title: group.name, groupId: group.id, lastMessage: safe?.content || '', lastMessageAt: safe?.createdAt || null, unreadCount: unread };
      }));
      const directsResult = await Promise.all((peers as any[]).map(async (peer) => {
        const latest = await prisma.chatMessage.findFirst({
          where: { OR: [
            { chatGroupId: null, OR: [{ senderId: me, receiverId: peer.id }, { senderId: peer.id, receiverId: me }] },
            { senderId: SERVICE_USER_ID, receiverId: peer.id, chatGroupId: null, replyTo: { is: { guideRequest: true, senderId: me, receiverId: peer.id } } },
            { senderId: SERVICE_USER_ID, receiverId: me, chatGroupId: null, replyTo: { is: { guideRequest: true, senderId: peer.id, receiverId: me } } },
          ] },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], include: { guideReply: { select: { projectId: true, kind: true } } },
        });
        const guideSafe = latest ? (await sanitizeGuideReplies([latest as any], me, isAdminActor((req as any).authUser)))[0] : null;
        const safe = guideSafe ? (await sanitizeProjectReferences([guideSafe], me, (req as any).authUser))[0] : null;
        const unread = await prisma.notification.count({ where: { userId: me, category: 'ЧАТ', isRead: false, targetRoute: { contains: `from=${peer.id}` } } });
        return { id: `from=${peer.id}`, type: 'DIRECT', title: peer.name, peerId: peer.id, lastMessage: safe?.content || '', lastMessageAt: safe?.createdAt || null, unreadCount: unread };
      }));
      const chats = [...groupsResult, ...directsResult].sort((a, b) => new Date(b.lastMessageAt || 0).getTime() - new Date(a.lastMessageAt || 0).getTime());
      res.json({ chats });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  /** Полнотекстовый для человека поиск идёт по всей доступной истории; сначала
   * проверяем ACL и только затем строим сниппеты, чтобы закрытый ответ не стал
   * подсказкой даже по самому совпавшему слову. */
  app.get('/api/chat/search', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    const me = actorId(req);
    const q = String(req.query.q || '').trim().toLocaleLowerCase('ru-RU');
    if (!me) return res.status(401).json({ error: 'Нужен вход' });
    if (!q || q.length > 200) return res.status(400).json({ error: 'Укажите запрос длиной до 200 символов' });
    try {
      const groups = await prisma.chatGroup.findMany({ where: { OR: [{ ownerId: me }, { members: { some: { id: me } } }] }, select: { id: true } });
      const groupIds: string[] = [];
      for (const group of groups as any[]) if (await isGroupMember(me, group.id)) groupIds.push(group.id);
      const peers = await prisma.chatMessage.findMany({ where: { OR: [
        { chatGroupId: null, OR: [{ senderId: me }, { receiverId: me }] },
        { senderId: SERVICE_USER_ID, chatGroupId: null, replyTo: { is: { guideRequest: true, OR: [{ senderId: me }, { receiverId: me }] } } },
      ] }, select: { senderId: true, receiverId: true, replyTo: { select: { senderId: true, receiverId: true } } } });
      const peerIds = [...new Set((peers as any[]).map((row) => directPeerId(row, me)).filter((id) => id && id !== me && id !== SERVICE_USER_ID))];
      const chatId = String(req.query.chatId || '');
      const scopedGroupIds = chatId.startsWith('group=') ? groupIds.filter((id) => id === chatId.slice(6)) : chatId ? [] : groupIds;
      const scopedPeerIds = chatId.startsWith('from=') ? peerIds.filter((id) => id === chatId.slice(5)) : chatId ? [] : peerIds;
      if (chatId && !scopedGroupIds.length && !scopedPeerIds.length) return res.status(404).json({ results: [], total: 0, truncated: false });
      if (!scopedGroupIds.length && !scopedPeerIds.length) return res.json({ results: [], total: 0, truncated: false });
      const variants = [...new Set([q, q.toLocaleLowerCase('ru-RU'), q.toLocaleUpperCase('ru-RU'), q.charAt(0).toLocaleUpperCase('ru-RU') + q.slice(1)])];
      const where: any = { OR: [
        ...(scopedGroupIds.length ? [{ chatGroupId: { in: scopedGroupIds } }] : []),
        ...(scopedPeerIds.length ? [
          { chatGroupId: null, senderId: me, receiverId: { in: scopedPeerIds } },
          { chatGroupId: null, senderId: { in: scopedPeerIds }, receiverId: me },
          { senderId: SERVICE_USER_ID, receiverId: { in: scopedPeerIds }, chatGroupId: null, replyTo: { is: { guideRequest: true, senderId: me, receiverId: { in: scopedPeerIds } } } },
          { senderId: SERVICE_USER_ID, receiverId: me, chatGroupId: null, replyTo: { is: { guideRequest: true, senderId: { in: scopedPeerIds }, receiverId: me } } },
        ] : []),
      ] };
      const rows = await prisma.chatMessage.findMany({
        where: { AND: [where, { OR: variants.map((value) => ({ content: { contains: value } })) }] },
        include: { sender: { select: { id: true, name: true, symbol: true } }, guideReply: { select: { projectId: true, kind: true } }, replyTo: { select: { id: true, content: true, senderId: true, receiverId: true, chatGroupId: true, guideReply: { select: { projectId: true, kind: true } } } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1000,
      });
      const guideSafe = await sanitizeGuideReplies(rows as any[], me, isAdminActor((req as any).authUser));
      const safe = await sanitizeProjectReferences(guideSafe as any[], me, (req as any).authUser);
      const matching = safe.filter((row: any) => String(row.content || '').toLocaleLowerCase('ru-RU').includes(q));
      const matchingGroups = [...new Set(matching.map((row: any) => row.chatGroupId).filter(Boolean))];
      const names = await prisma.chatGroup.findMany({ where: { id: { in: matchingGroups } }, select: { id: true, name: true } });
      const groupNames = new Map((names as any[]).map((g) => [g.id, g.name]));
      const peerNames = new Map((peers as any[]).flatMap((row) => [row.senderId, row.receiverId]).filter((id) => peerIds.includes(id)).map((id) => [id, '']));
      const users = await prisma.user.findMany({ where: { id: { in: peerIds } }, select: { id: true, name: true } });
      for (const user of users as any[]) peerNames.set(user.id, user.name);
      const total = matching.length;
      const offset = Math.max(0, Math.min(5000, Number(req.query.offset) || 0));
      const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 30));
      const results = matching.slice(offset, offset + limit).map((row: any) => {
        const groupId = row.chatGroupId || null;
        const peerId = groupId ? null : directPeerId(row, me);
        const content = String(row.content || '');
        const hit = content.toLocaleLowerCase('ru-RU').indexOf(q);
        const start = Math.max(0, hit - 60);
        const snippet = `${start ? '…' : ''}${content.slice(start, Math.min(content.length, hit + q.length + 100))}${hit + q.length + 100 < content.length ? '…' : ''}`;
        return { chatId: groupId ? `group=${groupId}` : `from=${peerId}`, messageId: row.id, snippet, createdAt: row.createdAt, type: groupId ? 'GROUP' : 'DIRECT', title: groupId ? groupNames.get(groupId) || '' : peerNames.get(peerId) || '', groupId, peerId };
      });
      res.json({ results, total, truncated: offset + limit < total || rows.length === 1000 });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // 1. Get messages between two users
  app.get('/api/chat/messages', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    try {
      const { senderId, receiverId } = req.query;
      if (!senderId || !receiverId) {
        return res.status(400).json({ error: 'senderId and receiverId are required' });
      }
      // Читать переписку может только её участник
      const me = actorId(req);
      if (me !== String(senderId) && me !== String(receiverId)) {
        return res.status(403).json({ error: 'Это чужая переписка' });
      }

      // Отдаём хвост переписки, а не всю целиком: клиент перечитывает её при
      // каждом событии сокета и раз в 12 секунд страховочным опросом, и на
      // многолетней переписке это заметная нагрузка на сервер, сеть и отрисовку.
      // Берём последние N в обратном порядке и переворачиваем — так работает
      // индекс по дате, в отличие от смещения от начала
      const limit = Math.min(2000, Math.max(20, Number(req.query.limit) || 300));
      const before = req.query.before ? new Date(String(req.query.before)) : null;
      const beforeId = String(req.query.beforeId || '');
      if (before && Number.isNaN(before.getTime())) return res.status(400).json({ error: 'Некорректный курсор истории' });
      const cursor = before ? { OR: [{ createdAt: { lt: before } }, ...(beforeId ? [{ createdAt: before, id: { lt: beforeId } }] : [])] } : null;
      const tail = await prisma.chatMessage.findMany({
        where: { AND: [
          { OR: [
            { chatGroupId: null, senderId: String(senderId), receiverId: String(receiverId) },
            { chatGroupId: null, senderId: String(receiverId), receiverId: String(senderId) },
            { chatGroupId: null, senderId: SERVICE_USER_ID, receiverId: String(receiverId), replyTo: { is: { guideRequest: true, senderId: String(senderId), receiverId: String(receiverId) } } },
            { chatGroupId: null, senderId: SERVICE_USER_ID, receiverId: String(senderId), replyTo: { is: { guideRequest: true, senderId: String(receiverId), receiverId: String(senderId) } } },
          ] },
          ...(cursor ? [cursor] : []),
        ] },
        include: {
          attachments: true,
          sender: { select: { id: true, name: true, symbol: true, role: true } },
          receiver: { select: { id: true, name: true, symbol: true, role: true } },
          guideReply: { select: { projectId: true, kind: true } },
          linkedElement: true,
          replyTo: { select: { id: true, content: true, senderId: true, receiverId: true, chatGroupId: true, guideReply: { select: { projectId: true, kind: true } }, sender: { select: { id: true, name: true } } } }
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
      });

      const guideSafe = await sanitizeGuideReplies(tail as any[], actorId(req), isAdminActor((req as any).authUser));
      const safe = await sanitizeProjectReferences(guideSafe as any[], actorId(req), (req as any).authUser);
      res.json((safe as any[]).slice().reverse());
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Точечная загрузка результата поиска за пределами открытого фрагмента истории.
  app.get('/api/chat/messages/:id', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    try {
      const message = await prisma.chatMessage.findUnique({
        where: { id: String(req.params.id) },
        include: { attachments: true, sender: { select: { id: true, name: true, symbol: true, role: true } }, receiver: { select: { id: true, name: true, symbol: true, role: true } }, guideReply: { select: { projectId: true, kind: true } }, linkedElement: true, replyTo: { select: { id: true, content: true, senderId: true, receiverId: true, chatGroupId: true, guideReply: { select: { projectId: true, kind: true } }, sender: { select: { id: true, name: true } } } } },
      });
      if (!message || !(await isChatParticipant(actorId(req), message))) return res.status(404).json({ error: 'Сообщение не найдено' });
      const [guideSafe] = await sanitizeGuideReplies([message as any], actorId(req), isAdminActor((req as any).authUser));
      const [safe] = await sanitizeProjectReferences([guideSafe], actorId(req), (req as any).authUser);
      res.json(safe);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  /** Вложения из всей серверной истории, а не только текущей страницы сообщений. */
  app.get('/api/chat/attachments', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    const me = actorId(req);
    const type = String(req.query.type || '');
    const conversationId = String(req.query.conversationId || '');
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 50));
    const offset = Math.max(0, Math.min(10000, Number(req.query.offset) || 0));
    if (!me) return res.status(401).json({ error: 'Нужен вход' });
    if (!conversationId || !['DIRECT', 'GROUP'].includes(type)) return res.status(400).json({ error: 'Укажите тип и разговор' });
    try {
      let where: any;
      if (type === 'GROUP') {
        if (!(await isGroupMember(me, conversationId))) return res.status(404).json({ error: 'Разговор не найден' });
        where = { message: { chatGroupId: conversationId } };
      } else {
        if (conversationId === me || conversationId === 'flux-guide-service') return res.status(404).json({ error: 'Разговор не найден' });
        const peer = await prisma.user.findUnique({ where: { id: conversationId }, select: { id: true, role: true } });
        if (!peer || peer.role === 'SERVICE') return res.status(404).json({ error: 'Разговор не найден' });
        where = { message: { chatGroupId: null, OR: [{ senderId: me, receiverId: conversationId }, { senderId: conversationId, receiverId: me }] } };
      }
      if (type === 'DIRECT') where = { OR: [
        where,
        { message: { chatGroupId: null, senderId: SERVICE_USER_ID, receiverId: conversationId, replyTo: { is: { guideRequest: true, senderId: me, receiverId: conversationId } } } },
        { message: { chatGroupId: null, senderId: SERVICE_USER_ID, receiverId: me, replyTo: { is: { guideRequest: true, senderId: conversationId, receiverId: me } } } },
      ] };
      const rows = await prisma.chatAttachment.findMany({
        where,
        include: { message: { select: { id: true, createdAt: true, senderId: true, receiverId: true, chatGroupId: true, linkedProjectId: true, linkedElementId: true, replyToId: true, guideReply: { select: { projectId: true } } } } },
        orderBy: [{ message: { createdAt: 'desc' } }, { id: 'desc' }],
        take: 1000,
      });
      const accessible = [] as any[];
      for (const row of rows as any[]) if (await canReadChatMessage(me, (req as any).authUser, row.message)) accessible.push(row);
      const items = accessible.slice(offset, offset + limit).map((row) => ({ id: row.id, fileName: row.fileName, fileSize: row.fileSize, filePath: row.filePath, messageId: row.message.id, createdAt: row.message.createdAt }));
      res.json({ items, total: accessible.length, truncated: offset + limit < accessible.length || rows.length === 1000 });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  /** Точные теги, упомянутые во всей доступной истории разговора. */
  app.get('/api/chat/tags', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    const me = actorId(req);
    const type = String(req.query.type || '');
    const conversationId = String(req.query.conversationId || '');
    if (!me) return res.status(401).json({ error: 'Нужен вход' });
    if (!conversationId || !['DIRECT', 'GROUP'].includes(type)) return res.status(400).json({ error: 'Укажите тип и разговор' });
    try {
      let where: any;
      const projectIds = new Set<string>();
      if (type === 'GROUP') {
        if (!(await isGroupMember(me, conversationId))) return res.status(404).json({ error: 'Разговор не найден' });
        const group = await prisma.chatGroup.findUnique({ where: { id: conversationId }, select: { projectId: true } });
        if (group?.projectId) projectIds.add(group.projectId);
        where = { chatGroupId: conversationId };
      } else {
        if (conversationId === me || conversationId === 'flux-guide-service') return res.status(404).json({ error: 'Разговор не найден' });
        const peer = await prisma.user.findUnique({ where: { id: conversationId }, select: { id: true, role: true } });
        if (!peer || peer.role === 'SERVICE') return res.status(404).json({ error: 'Разговор не найден' });
        where = { OR: [
          { chatGroupId: null, senderId: me, receiverId: conversationId },
          { chatGroupId: null, senderId: conversationId, receiverId: me },
          { chatGroupId: null, senderId: SERVICE_USER_ID, receiverId: conversationId, replyTo: { is: { guideRequest: true, senderId: me, receiverId: conversationId } } },
          { chatGroupId: null, senderId: SERVICE_USER_ID, receiverId: me, replyTo: { is: { guideRequest: true, senderId: conversationId, receiverId: me } } },
        ] };
      }
      const rows = await prisma.chatMessage.findMany({
        where,
        include: { guideReply: { select: { projectId: true, kind: true } }, linkedElement: { include: { tags: { select: { identifier: true, projectId: true } } } } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 10000,
      });
      const guideSafe = await sanitizeGuideReplies(rows as any[], me, isAdminActor((req as any).authUser));
      const safe = await sanitizeProjectReferences(guideSafe as any[], me, (req as any).authUser);
      const visibleProjects = await prisma.project.findMany({ where: { system: false }, select: { id: true } });
      for (const project of visibleProjects as any[]) if (await canSeeProject(me, project.id, isAdminActor((req as any).authUser))) projectIds.add(project.id);
      for (const row of safe as any[]) {
        if (row.linkedProjectId) projectIds.add(row.linkedProjectId);
        if (row.guideReply?.projectId) projectIds.add(row.guideReply.projectId);
        for (const tag of row.linkedElement?.tags || []) if (tag.projectId) projectIds.add(tag.projectId);
      }
      const tagRows = projectIds.size ? await prisma.tag.findMany({ where: { projectId: { in: [...projectIds] } }, select: { identifier: true, projectId: true } }) : [];
      const found = new Map<string, { identifier: string; projectId: string; messageIds: Set<string>; createdAt: Date }>();
      for (const row of safe as any[]) {
        const content = String(row.content || '').toLocaleLowerCase('ru-RU');
        const add = (identifier: string, projectId: string) => {
          const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])${identifier.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&').replace(/-/g, '\\-')}(?=$|[^\\p{L}\\p{N}])`, 'iu');
          if (!pattern.test(String(row.content || ''))) return;
          const key = `${projectId}\\u0000${identifier}`;
          const hit = found.get(key) || { identifier, projectId, messageIds: new Set<string>(), createdAt: row.createdAt };
          hit.messageIds.add(row.id);
          found.set(key, hit);
        };
        for (const tag of tagRows as any[]) if (content && content.includes(String(tag.identifier).toLocaleLowerCase('ru-RU'))) add(tag.identifier, tag.projectId);
        for (const tag of row.linkedElement?.tags || []) add(tag.identifier, tag.projectId || '');
      }
      const all = [...found.values()].sort((a, b) => a.identifier.localeCompare(b.identifier, 'ru-RU'));
      const items = all.slice(0, 1000).map((tag) => ({ identifier: tag.identifier, projectId: tag.projectId, messageIds: [...tag.messageIds], createdAt: tag.createdAt }));
      res.json({ items, total: all.length, truncated: all.length > items.length || rows.length === 10000 });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

}
