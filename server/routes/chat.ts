import { isPrivilegedUser } from '../accessPolicy.js';
import type { Express, Request, Response } from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import path from 'path';
import { getPrisma, notifyUser } from '../context.js';
import { signLink, hardenFileResponse } from '../security.js';
import { mayEditGroup, ownerForNewGroup } from '../projectAccess.js';
import { canSeeProject, hiddenProjectsOf } from './members.js';

// Корпоративный мессенджер: личные и групповые чаты, вложения, реакции,
// закрепы, пересылка и подсказки по тегам.
//
// Вынесено из server.ts. Помощники, которыми пользуется и остальной server.ts,
// передаются при подключении, а не импортируются обратно — это был бы круг.

interface ChatDeps {
  /** Сокет-сервер живёт в server.ts: события чата уходят по его комнатам */
  io: SocketIOServer;
}

// Помощникам ниже сокет нужен вне обработчиков, поэтому он лежит на уровне модуля
let io: SocketIOServer;

// Выдача вложения из БД. Статика /chat_files (выше) обслуживает старые файлы
// на диске; сюда попадают только новые пути вида /chat_files/{id}/{имя}
const CHAT_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8'
};

// Helper to auto-sync Chat Group for every Project
async function ensureProjectChatGroups() {
  const prisma = getPrisma();
  try {
    // У общего диска чата быть не должно: это хранилище, а не проект
    const projects = await prisma.project.findMany({ where: { system: false } });
    const users = await prisma.user.findMany();
    // Системный канал «Ошибки» — в нём по умолчанию состоят все пользователи
    const errName = 'Ошибки';
    let errGroup = await prisma.chatGroup.findFirst({ where: { name: errName, type: 'CHANNEL' } });
    if (!errGroup) {
      await prisma.chatGroup.create({
        data: {
          name: errName,
          type: 'CHANNEL',
          color: 'rose',
          description: 'Системный канал для отправки логов и сообщений об ошибках',
          members: { connect: users.map(u => ({ id: u.id })) }
        }
      });
    } else {
      await prisma.chatGroup.update({
        where: { id: errGroup.id },
        data: { members: { connect: users.map(u => ({ id: u.id })) } }
      });
    }
    for (const p of projects) {
      const projectMembers = await prisma.projectMember.findMany({ where: { projectId: p.id }, select: { userId: true } });
      const allowed = projectMembers.length ? users.filter(u => projectMembers.some(m => m.userId === u.id) || isPrivilegedUser(u)) : users;
      const members = allowed.map(u => ({ id: u.id }));
      const g = await prisma.chatGroup.findFirst({ where: { projectId: p.id } });
      if (!g) {
        await prisma.chatGroup.create({
          data: {
            name: `Проект: ${p.name}`,
            type: 'PROJECT',
            projectId: p.id,
            members: { connect: members }
          }
        });
      } else {
        await prisma.chatGroup.update({
          where: { id: g.id },
          data: {
            name: `Проект: ${p.name}`,
            members: { set: members }
          }
        });
      }
    }
  } catch (err) {
    console.warn('[ensureProjectChatGroups] err:', err);
  }
}

// Реакция на сообщение (переключение эмодзи для пользователя)
// Участник ли пользователь диалога/группы, которой принадлежит сообщение.
// Личка: отправитель или получатель. Группа: член группы (или владелец).
/**
 * Кому адресовано событие чата: участникам диалога или членам группы.
 * Возвращает имена личных комнат сокетов.
 */
async function chatRooms(msg: { senderId: string; receiverId: string | null; chatGroupId: string | null }): Promise<string[]> {
  const prisma = getPrisma();
  const ids = new Set<string>();
  if (msg.senderId) ids.add(String(msg.senderId));
  if (msg.receiverId) ids.add(String(msg.receiverId));
  if (msg.chatGroupId) {
    const g = await prisma.chatGroup.findUnique({
      where: { id: msg.chatGroupId },
      select: { ownerId: true, projectId: true, members: { select: { id: true } } },
    });
    if (g) {
      if (g.ownerId) ids.add(String(g.ownerId));
      for (const m of g.members) ids.add(String(m.id));
    }
  }
  const candidates = [...ids];
  if (msg.chatGroupId) {
    const group = await prisma.chatGroup.findUnique({ where: { id: msg.chatGroupId }, select: { projectId: true } });
    if (group?.projectId) {
      const checked = await Promise.all(candidates.map(async id => {
        const user = await prisma.user.findUnique({ where: { id }, select: { role: true } });
        return await canSeeProject(id, group.projectId, isPrivilegedUser(user)) ? id : null;
      }));
      return checked.filter(Boolean).map(id => `user:${id}`);
    }
  }
  return candidates.map((id) => `user:${id}`);
}

/** Событие чата — только участникам, а не всей сети */
async function emitChat(
  event: string,
  msg: { senderId: string; receiverId: string | null; chatGroupId: string | null },
  payload: any,
) {
  try {
    const rooms = await chatRooms(msg);
    if (!rooms.length) return;
    io.to(rooms).emit(event, payload);
  } catch (err) {
    console.error('[Socket] не удалось разослать событие чата:', err);
  }
}

// Кто на самом деле обращается. Личность берём из проверенного токена сессии,
// а не из тела запроса: раньше обработчики чата верили полю userId/senderId,
// присланному клиентом, и любой вошедший сотрудник мог прочитать чужую
// переписку, написать от чужого имени или удалить чужое сообщение — достаточно
// было подставить идентификатор коллеги, а он виден в списке сотрудников.
function actorId(req: Request): string {
  return String((req as any).authUser?.id || '');
}

/** Состоит ли сотрудник в группе (владелец тоже считается участником) */
async function isGroupMember(userId: string, groupId: string): Promise<boolean> {
  const prisma = getPrisma();
  if (!userId || !groupId) return false;
  const g = await prisma.chatGroup.findUnique({
    where: { id: String(groupId) },
    select: { ownerId: true, projectId: true, members: { where: { id: userId }, select: { id: true } } },
  });
  if (!g || !(g.ownerId === userId || g.members.length > 0)) return false;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
  return !g.projectId || await canSeeProject(userId, g.projectId, isPrivilegedUser(user));
}

async function isChatParticipant(userId: string, msg: { senderId: string; receiverId: string | null; chatGroupId: string | null }): Promise<boolean> {
  const prisma = getPrisma();
  if (!userId) return false;
  if (msg.chatGroupId) return isGroupMember(userId, msg.chatGroupId);
  return msg.senderId === userId || msg.receiverId === userId;
}

export function registerChatRoutes(app: Express, deps: ChatDeps): void {
  io = deps.io;
  // --- CORPORATE MESSENGER CHAT API ---

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
      const tail = await prisma.chatMessage.findMany({
        where: {
          OR: [
            { senderId: String(senderId), receiverId: String(receiverId) },
            { senderId: String(receiverId), receiverId: String(senderId) }
          ]
        },
        include: {
          attachments: true,
          sender: { select: { id: true, name: true, symbol: true, role: true } },
          receiver: { select: { id: true, name: true, symbol: true, role: true } },
          linkedElement: true,
          replyTo: { select: { id: true, content: true, sender: { select: { id: true, name: true } } } }
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
      });

      res.json(tail.reverse());
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 2. Send message
  app.post('/api/chat/messages', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    try {
      const { senderId, receiverId, content, linkedElementId, linkedProjectId, attachments, replyToId } = req.body;
      if (!senderId || !receiverId) {
        return res.status(400).json({ error: 'senderId and receiverId are required' });
      }
      // Писать можно только от своего имени
      if (actorId(req) !== String(senderId)) {
        return res.status(403).json({ error: 'Сообщение можно отправить только от своего имени' });
      }

      if (replyToId) {
        const reply = await prisma.chatMessage.findUnique({ where: { id: String(replyToId) } });
        if (!reply || !(await isChatParticipant(actorId(req), reply)) || reply.chatGroupId || ![reply.senderId, reply.receiverId].includes(String(receiverId))) return res.status(403).json({ error: 'Ответ должен ссылаться на сообщение этого диалога' });
      }

      const msg = await prisma.chatMessage.create({
        data: {
          senderId: String(senderId),
          receiverId: String(receiverId),
          content: String(content || ''),
          linkedElementId: linkedElementId ? String(linkedElementId) : null,
          linkedProjectId: linkedProjectId ? String(linkedProjectId) : null,
          replyToId: replyToId ? String(replyToId) : null,
        }
      });

      // Create attachments if provided
      if (attachments && Array.isArray(attachments)) {
        for (const att of attachments) {
          await prisma.chatAttachment.create({
            data: {
              messageId: msg.id,
              fileName: String(att.fileName),
              filePath: String(att.filePath),
              fileSize: Number(att.fileSize || 0)
            }
          });
        }
      }

      const fullMessage = await prisma.chatMessage.findUnique({
        where: { id: msg.id },
        include: {
          attachments: true,
          sender: { select: { id: true, name: true, symbol: true, role: true } },
          receiver: { select: { id: true, name: true, symbol: true, role: true } },
          linkedElement: true,
          replyTo: { select: { id: true, content: true, sender: { select: { id: true, name: true } } } }
        }
      });

      // Личное уведомление получателю (категория ЧАТ)
      await notifyUser(String(receiverId), 'ЧАТ', `Новое сообщение от ${(fullMessage as any)?.sender?.name || 'сотрудника'}`, String(content || '').slice(0, 80), `/chat?from=${senderId}`);

      // Только участникам диалога, а не всей сети
      await emitChat('chat:message_received', fullMessage as any, fullMessage);

      res.json(fullMessage);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Редактирование своего сообщения
  app.put('/api/chat/messages/:id', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    try {
      const { id } = req.params;
      const { content } = req.body;
      const msg = await prisma.chatMessage.findUnique({ where: { id } });
      if (!msg) {
        return res.status(404).json({ error: 'Сообщение не найдено' });
      }
      // Автора берём из сессии: присланному userId верить нельзя
      if (msg.senderId !== actorId(req)) {
        return res.status(403).json({ error: 'Можно редактировать только свои сообщения' });
      }
      const updated = await prisma.chatMessage.update({
        where: { id },
        data: { content: String(content || ''), editedAt: new Date() },
        include: {
          attachments: true,
          sender: { select: { id: true, name: true, symbol: true, role: true } },
          receiver: { select: { id: true, name: true, symbol: true, role: true } },
          linkedElement: true,
          replyTo: { select: { id: true, content: true, sender: { select: { id: true, name: true } } } }
        }
      });
      await emitChat('chat:message_updated', updated as any, updated);
      res.json(updated);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Удаление своего сообщения
  app.delete('/api/chat/messages/:id', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    try {
      const { id } = req.params;
      const msg = await prisma.chatMessage.findUnique({ where: { id } });
      if (!msg) {
        return res.status(404).json({ error: 'Сообщение не найдено' });
      }
      // Автора берём из сессии, а не из параметра запроса
      if (msg.senderId !== actorId(req)) {
        return res.status(403).json({ error: 'Можно удалять только свои сообщения' });
      }
      // Вложения в БД (пути /chat_files/{fileNodeId}/{имя}) удаляем вместе с сообщением
      try {
        const atts = await prisma.chatAttachment.findMany({ where: { messageId: id } });
        const nodeIds = atts
          .map((a: any) => (String(a.filePath || '').match(/^\/chat_files\/([^/]+)\//) || [])[1])
          .filter(Boolean);
        if (nodeIds.length) await prisma.fileNode.deleteMany({ where: { id: { in: nodeIds }, type: 'CHAT_FILE' } });
      } catch (_) {}
      await prisma.chatMessage.delete({ where: { id } });
      await emitChat('chat:message_deleted', msg as any, { id });
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 3. Upload file — вложение хранится в БД (FileNode type=CHAT_FILE), а не на
  // диске: в совместном режиме файл обязан открываться у всех пользователей
  app.post('/api/chat/upload', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    try {
      const { fileName, base64Data } = req.body;
      if (!fileName || !base64Data) {
        return res.status(400).json({ error: 'fileName and base64Data are required' });
      }

      // Санитизация имени: только базовое имя, без разделителей и «..»/«.»
      let base = path.basename(String(fileName || '')).replace(/[\/\\]/g, '').trim();
      if (!base || base === '.' || base === '..') base = `file_${Date.now()}`;

      let b64 = String(base64Data);
      if (b64.includes(',')) b64 = b64.split(',')[1]; // отрезаем data:-префикс
      const size = Math.floor(b64.length * 3 / 4);

      const node = await prisma.fileNode.create({
        data: {
          name: base,
          type: 'CHAT_FILE',
          filePath: `/chat/${base}`,
          size,
          content: b64,
          department: 'CHAT'
        }
      });

      res.json({
        success: true,
        filePath: `/chat_files/${node.id}/${encodeURIComponent(base)}`,
        fileName: base,
        fileSize: size
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
  /**
   * Ссылка на вложение для внешнего браузера — на десять минут и только
   * участнику переписки. Сам адрес вложения без подписи или токена больше не
   * открывается (server/security.ts), поэтому переслать его «навсегда» нельзя.
   */
  app.get('/api/chat/file-link', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    try {
      const me = (req as any).authUser;
      const filePath = String(req.query.path || '');
      if (!me || !filePath.startsWith('/chat_files/')) return res.status(400).json({ error: 'Не указан файл' });
      const att = await prisma.chatAttachment.findMany({
        where: { filePath },
        select: { message: { select: { senderId: true, receiverId: true, chatGroup: { select: { members: { select: { id: true } } } } } } },
        take: 20,
      });
      const mine = att.some((a: any) =>
        a.message.senderId === me.id || a.message.receiverId === me.id ||
        (a.message.chatGroup?.members || []).some((m: any) => m.id === me.id));
      if (!mine && !isPrivilegedUser(me)) return res.status(404).json({ error: 'Файл не найден' });
      res.json({ url: signLink(filePath) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/chat_files/:id/:name', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    try {
      const node = await prisma.fileNode.findUnique({ where: { id: String(req.params.id) } });
      if (!node || node.type !== 'CHAT_FILE' || !node.content) {
        return res.status(404).json({ error: 'Файл не найден' });
      }
      const buffer = Buffer.from(node.content, 'base64');
      const ext = path.extname(node.name).toLowerCase();
      const type = CHAT_MIME[ext] || 'application/octet-stream';
      res.setHeader('Content-Type', type);
      res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(node.name)}`);
      hardenFileResponse(res, type);
      res.send(buffer);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Search ComponentElement by tag string
  /**
   * Куда ведёт тег, отправленный в чат.
   *
   * Раньше искали только среди элементов оборудования — и тег, который есть в
   * реестре, но ещё не привязан к позиции, объявлялся «не зарегистрированным в
   * базе». Человек видел ошибку про несуществующий тег, глядя на тег, который
   * сам же и завёл час назад.
   *
   * Ищем в обоих местах и говорим, что нашли: элемент — открывать в
   * «Оборудовании», тег — в «Тегах». Не нашли ни там ни там — так и отвечаем,
   * не выдумывая причину.
   */
  app.get('/api/chat/search-element', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    try {
      const { tag, projectId } = req.query;
      if (!tag) {
        return res.status(400).json({ error: 'tag is required' });
      }
      const cleanTag = String(tag);
      const hidden = await hiddenProjectsOf(actorId(req), isPrivilegedUser((req as any).authUser));
      const visible = { notIn: hidden };
      const element = await prisma.componentElement.findFirst({
        where: {
          monoblock: { system: { projectId: projectId ? String(projectId) : visible } },
          OR: [
            { itemCode: cleanTag },
            { name: cleanTag },
            { id: cleanTag },
            { tags: { some: { identifier: { contains: cleanTag } } } }
          ]
        },
        include: {
          tags: true,
          monoblock: { include: { system: true } }
        }
      });

      // Тег реестра ищем и в текущем проекте, и вне его: тег из соседнего
      // проекта — это не «не найден», это другой разговор, и сказать о нём надо
      // прямо, а не отправлять человека искать самому
      const pid = projectId ? String(projectId) : '';
      const tagRow = await prisma.tag.findFirst({
        where: { identifier: cleanTag, projectId: pid || visible },
        select: { id: true, identifier: true, projectId: true },
      });
      const elsewhere = tagRow || !pid ? null : await prisma.tag.findFirst({
        where: { identifier: cleanTag, projectId: visible },
        select: { id: true, identifier: true, projectId: true, project: { select: { name: true } } },
      });

      res.json({ element, tag: tagRow, elsewhere });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Autocomplete tags/components in chat
  app.get('/api/chat/autocomplete-tags', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    try {
      const { query, projectId } = req.query;
      const cleanQuery = query ? String(query).toLowerCase() : '';
      const cleanProjId = projectId ? String(projectId) : undefined;
      const hidden = await hiddenProjectsOf(actorId(req), isPrivilegedUser((req as any).authUser));

      const suggestions: Array<{ text: string; description: string; elementId?: string }> = [];

      // 1. Fetch tags matching cleanQuery
      const tags = await prisma.tag.findMany({
        where: {
          projectId: cleanProjId || { notIn: hidden },
          identifier: { contains: cleanQuery }
        },
        take: 15
      });

      for (const t of tags) {
        suggestions.push({
          text: t.identifier,
          description: `BIM/KKS Тег: ${t.fluid || ''} (${t.department || ''})`
        });
      }

      // 2. Fetch component elements matching cleanQuery
      const elements = await prisma.componentElement.findMany({
        where: {
          monoblock: { system: { projectId: cleanProjId || { notIn: hidden } } },
          OR: [
            { itemCode: { contains: cleanQuery } },
            { name: { contains: cleanQuery } }
          ]
        },
        include: {
          monoblock: {
            include: {
              system: true
            }
          }
        },
        take: 20
      });

      for (const el of elements) {
        const systemName = el.monoblock?.system?.name || '';
        const monoName = el.monoblock?.name || '';
        suggestions.push({
          text: el.itemCode || el.name,
          description: `Оборудование: ${el.name} | [${systemName} > ${monoName}]`,
          elementId: el.id
        });
      }

      // Deduplicate suggestions by text
      const seen = new Set<string>();
      const uniqueSuggestions = suggestions.filter(s => {
        const key = s.text.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      res.json(uniqueSuggestions);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get group list
  app.get('/api/chat/groups', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    try {
      await ensureProjectChatGroups();
      const me = (req as any).authUser;
      const hidden = await hiddenProjectsOf(actorId(req), isPrivilegedUser(me));
      const groups = await prisma.chatGroup.findMany({
        where: { AND: [
          { OR: [{ ownerId: actorId(req) }, { members: { some: { id: actorId(req) } } }] },
          { OR: [{ projectId: null }, { projectId: { notIn: hidden } }] },
        ] },
        include: {
          members: { select: { id: true, name: true, symbol: true, role: true } },
          project: { select: { id: true, name: true } }
        },
        orderBy: { createdAt: 'desc' }
      });
      res.json(groups);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Создание своей группы или канала
  app.post('/api/chat/groups', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    try {
      const { name, type, memberIds, description, color } = req.body;
      const me = (req as any).authUser;
      if (!me?.id) return res.status(401).json({ success: false, message: 'Требуется вход' });
      // Владелец — создающий (из сессии): присланный ownerId позволял назначить
      // владельцем кого угодно, а значит и записать чужой группе чужого хозяина
      const ownerId = ownerForNewGroup(String(me.id), isPrivilegedUser(me), req.body?.ownerId);
      if (!name || !String(name).trim()) {
        return res.status(400).json({ error: 'Укажите название' });
      }
      const safeType = (type === 'CHANNEL' || type === 'CUSTOM') ? type : 'CUSTOM';
      const ids: string[] = Array.isArray(memberIds) ? memberIds.map(String) : [];
      // владелец всегда участник
      if (ownerId && !ids.includes(String(ownerId))) ids.push(String(ownerId));
      const group = await prisma.chatGroup.create({
        data: {
          name: String(name).trim(),
          type: safeType,
          description: String(description || ''),
          color: String(color || 'indigo'),
          ownerId,
          members: { connect: ids.map(id => ({ id })) },
        },
        include: { members: { select: { id: true, name: true, symbol: true, role: true } } },
      });
      res.json({ success: true, group });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // Изменение группы/канала: название, описание, цвет, участники, владелец
  app.put('/api/chat/groups/:id', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    try {
      const { id } = req.params;
      const { name, description, color, memberIds, ownerId } = req.body;
      const me = (req as any).authUser;
      if (!me?.id) return res.status(401).json({ success: false, message: 'Требуется вход' });
      // Кто правит, решает сессия, а не userId из тела: без присланного userId
      // проверка владельца пропускалась, и любой мог сменить ownerId чужой группы
      const group = await prisma.chatGroup.findUnique({ where: { id }, select: { id: true, type: true, ownerId: true } });
      if (!group) return res.status(404).json({ success: false, message: 'Группа не найдена' });
      if (group.type === 'PROJECT') {
        return res.status(400).json({ success: false, message: 'Системную группу проекта изменить нельзя' });
      }
      // менять (и передавать владение) может владелец или администратор
      if (!mayEditGroup(String(me.id), isPrivilegedUser(me), group.ownerId)) {
        return res.status(403).json({ success: false, message: 'Изменять может только владелец или администратор' });
      }
      const data: any = {};
      if (typeof name === 'string' && name.trim()) data.name = name.trim();
      if (typeof description === 'string') data.description = description;
      if (typeof color === 'string' && color) data.color = color;
      if (ownerId) data.ownerId = String(ownerId);
      if (Array.isArray(memberIds)) {
        data.members = { set: memberIds.map((m: string) => ({ id: String(m) })) };
      }
      const updated = await prisma.chatGroup.update({
        where: { id }, data,
        include: { members: { select: { id: true, name: true, symbol: true, role: true } } },
      });
      res.json({ success: true, group: updated });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // Удаление группы/канала (нельзя удалять системную группу проекта)
  app.delete('/api/chat/groups/:id', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    try {
      const { id } = req.params;
      const me = (req as any).authUser;
      if (!me?.id) return res.status(401).json({ success: false, message: 'Требуется вход' });
      // ?userId= из адреса игнорируется: владельца определяет сессия
      const group = await prisma.chatGroup.findUnique({ where: { id }, select: { id: true, type: true, ownerId: true } });
      if (!group) return res.status(404).json({ success: false, message: 'Группа не найдена' });
      if (group.type === 'PROJECT') {
        return res.status(400).json({ success: false, message: 'Системную группу проекта удалить нельзя' });
      }
      if (!mayEditGroup(String(me.id), isPrivilegedUser(me), group.ownerId)) {
        return res.status(403).json({ success: false, message: 'Удалить может только владелец или администратор' });
      }
      await prisma.chatGroup.delete({ where: { id } });
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  app.post('/api/chat/messages/:id/react', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    try {
      const { id } = req.params;
      const { emoji } = req.body;
      const userId = actorId(req); // кто реагирует — из сессии, а не из тела
      if (!userId || !emoji) return res.status(400).json({ error: 'нужен вход и emoji' });
      const msg = await prisma.chatMessage.findUnique({ where: { id } });
      if (!msg) return res.status(404).json({ error: 'Сообщение не найдено' });
      if (!(await isChatParticipant(userId, msg))) {
        return res.status(403).json({ error: 'Реагировать можно только в своих диалогах и группах' });
      }
      let reactions: Record<string, string[]> = {};
      try { reactions = msg.reactions ? JSON.parse(msg.reactions) : {}; } catch (_) { reactions = {}; }
      const list = reactions[emoji] || [];
      const uidStr = String(userId);
      if (list.includes(uidStr)) {
        reactions[emoji] = list.filter(u => u !== uidStr);
        if (reactions[emoji].length === 0) delete reactions[emoji];
      } else {
        reactions[emoji] = [...list, uidStr];
      }
      const updated = await prisma.chatMessage.update({
        where: { id }, data: { reactions: JSON.stringify(reactions) },
      });
      await emitChat('chat:message_updated', msg as any, { id, reactions: updated.reactions });
      res.json({ success: true, reactions: updated.reactions });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Закрепление / открепление сообщения (только участником диалога/группы)
  app.post('/api/chat/messages/:id/pin', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    try {
      const { id } = req.params;
      const userId = actorId(req); // закрепляющий — из сессии
      const msg = await prisma.chatMessage.findUnique({ where: { id } });
      if (!msg) return res.status(404).json({ error: 'Сообщение не найдено' });
      if (!(await isChatParticipant(userId, msg))) {
        return res.status(403).json({ error: 'Закреплять можно только в своих диалогах и группах' });
      }
      const updated = await prisma.chatMessage.update({ where: { id }, data: { pinned: !msg.pinned } });
      await emitChat('chat:message_updated', msg as any, { id, pinned: updated.pinned });
      res.json({ success: true, pinned: updated.pinned });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Пересылка сообщения в другой чат (группу или личку)
  app.post('/api/chat/forward', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    try {
      const { messageId, senderId, toGroupId, toReceiverId } = req.body;
      if (!messageId || !senderId || (!toGroupId && !toReceiverId)) {
        return res.status(400).json({ error: 'Не указано сообщение или цель пересылки' });
      }
      const src = await prisma.chatMessage.findUnique({
        where: { id: String(messageId) },
        include: { sender: { select: { name: true } }, attachments: true },
      });
      if (!src) return res.status(404).json({ error: 'Исходное сообщение не найдено' });
      const me = actorId(req);
      if (String(senderId) !== me || !(await isChatParticipant(me, src))) return res.status(403).json({ error: 'Нельзя пересылать чужую переписку или писать от чужого имени' });
      if (!!toGroupId === !!toReceiverId) return res.status(400).json({ error: 'Выберите один диалог для пересылки' });
      if (toGroupId && !(await isGroupMember(me, String(toGroupId)))) return res.status(403).json({ error: 'Вы не состоите в этой группе' });
      if (toGroupId) {
        const target = await prisma.chatGroup.findUnique({ where: { id: String(toGroupId) } });
        if (target?.type === 'CHANNEL' && target.ownerId && target.ownerId !== me && !isPrivilegedUser((req as any).authUser)) return res.status(403).json({ error: 'В канал может писать только владелец или администратор' });
      }
      const created = await prisma.chatMessage.create({
        data: {
          senderId: String(senderId),
          chatGroupId: toGroupId ? String(toGroupId) : null,
          receiverId: toReceiverId ? String(toReceiverId) : null,
          content: src.content,
          linkedElementId: src.linkedElementId,
          linkedProjectId: src.linkedProjectId,
          forwardedFrom: src.forwardedFrom || src.sender?.name || 'Сообщение',
          // Вложения пересылаются вместе с текстом (файл на диске общий — копируем записи)
          attachments: src.attachments.length ? {
            create: src.attachments.map((a: any) => ({ fileName: a.fileName, filePath: a.filePath, fileSize: a.fileSize })),
          } : undefined,
        },
      });
      const full = await prisma.chatMessage.findUnique({
        where: { id: created.id },
        include: {
          attachments: true,
          sender: { select: { id: true, name: true, symbol: true, role: true } },
          receiver: { select: { id: true, name: true, symbol: true, role: true } },
          linkedElement: true,
          replyTo: { select: { id: true, content: true, sender: { select: { id: true, name: true } } } },
        },
      });
      await emitChat('chat:message_received', full as any, full);
      res.json({ success: true, message: full });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Очистка истории переписки (группа целиком или личный диалог)
  app.delete('/api/chat/conversation', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    try {
      const groupId = String(req.query.groupId || '');
      const a = String(req.query.userA || '');
      const b = String(req.query.userB || '');
      if (groupId) {
        const group = await prisma.chatGroup.findUnique({ where: { id: groupId }, select: { ownerId: true, projectId: true } });
        if (!group || !mayEditGroup(actorId(req), isPrivilegedUser((req as any).authUser), group.ownerId) || !(await isGroupMember(actorId(req), groupId))) return res.status(403).json({ error: 'Очистить группу может её владелец или администратор-участник' });
        const r = await prisma.chatMessage.deleteMany({ where: { chatGroupId: groupId } });
        return res.json({ success: true, deleted: r.count });
      }
      if (a && b) {
        if (actorId(req) !== a && actorId(req) !== b) return res.status(403).json({ error: 'Это чужая переписка' });
        const r = await prisma.chatMessage.deleteMany({
          where: { OR: [{ senderId: a, receiverId: b }, { senderId: b, receiverId: a }] },
        });
        return res.json({ success: true, deleted: r.count });
      }
      res.status(400).json({ success: false, message: 'Не указан диалог для очистки' });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // Get messages for group
  app.get('/api/chat/group-messages', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    try {
      const { groupId } = req.query;
      if (!groupId) {
        return res.status(400).json({ error: 'groupId is required' });
      }
      // Переписку группы читает только тот, кто в ней состоит
      if (!(await isGroupMember(actorId(req), String(groupId)))) {
        return res.status(403).json({ error: 'Вы не состоите в этой группе' });
      }
      // Как и в личной переписке — только хвост: групповые чаты живут дольше всех
      const limit = Math.min(2000, Math.max(20, Number(req.query.limit) || 300));
      const tail = await prisma.chatMessage.findMany({
        where: { chatGroupId: String(groupId) },
        include: {
          attachments: true,
          sender: { select: { id: true, name: true, symbol: true, role: true } },
          linkedElement: true,
          replyTo: { select: { id: true, content: true, sender: { select: { id: true, name: true } } } }
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
      });
      res.json(tail.reverse());
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Send message to group
  app.post('/api/chat/group-messages', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    try {
      const { senderId, groupId, content, linkedElementId, linkedProjectId, attachments, replyToId } = req.body;
      if (!senderId || !groupId) {
        return res.status(400).json({ error: 'senderId and groupId are required' });
      }
      // От своего имени и только в свою группу
      if (actorId(req) !== String(senderId)) {
        return res.status(403).json({ error: 'Сообщение можно отправить только от своего имени' });
      }
      if (!(await isGroupMember(String(senderId), String(groupId)))) {
        return res.status(403).json({ error: 'Вы не состоите в этой группе' });
      }

      // В каналах публиковать может только владелец или администратор
      const grp = await prisma.chatGroup.findUnique({ where: { id: String(groupId) } });
      if (grp && grp.type === 'CHANNEL') {
        const u = await prisma.user.findUnique({ where: { id: String(senderId) } });
        if (grp.ownerId && grp.ownerId !== String(senderId) && !isPrivilegedUser(u)) {
          return res.status(403).json({ error: 'В канал может писать только владелец или администратор' });
        }
      }

      if (replyToId) {
        const reply = await prisma.chatMessage.findUnique({ where: { id: String(replyToId) } });
        if (!reply || !(await isChatParticipant(actorId(req), reply)) || reply.chatGroupId !== String(groupId)) return res.status(403).json({ error: 'Ответ должен ссылаться на сообщение этой группы' });
      }

      const msg = await prisma.chatMessage.create({
        data: {
          senderId: String(senderId),
          chatGroupId: String(groupId),
          content: String(content || ''),
          linkedElementId: linkedElementId ? String(linkedElementId) : null,
          linkedProjectId: linkedProjectId ? String(linkedProjectId) : null,
          replyToId: replyToId ? String(replyToId) : null,
        }
      });

      if (attachments && Array.isArray(attachments)) {
        for (const att of attachments) {
          await prisma.chatAttachment.create({
            data: {
              messageId: msg.id,
              fileName: String(att.fileName),
              filePath: String(att.filePath),
              fileSize: Number(att.fileSize || 0)
            }
          });
        }
      }

      const fullMessage = await prisma.chatMessage.findUnique({
        where: { id: msg.id },
        include: {
          attachments: true,
          sender: { select: { id: true, name: true, symbol: true, role: true } },
          linkedElement: true,
          replyTo: { select: { id: true, content: true, sender: { select: { id: true, name: true } } } }
        }
      });

      // Только членам группы
      await emitChat('chat:message_received', fullMessage as any, fullMessage);

      res.json(fullMessage);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
