import type { Express, Request, Response } from 'express';
import { getPrisma, sendError } from '../context.js';

// Инженерный блокнот: заметки сотрудника (заголовок, текст Markdown, цвет,
// группа, опциональная привязка к оборудованию).
//
// Блокнот личный. Раньше заметки лежали общей кучей: любой сотрудник видел
// и правил чужие черновики, а «Мои заметки» на главном экране показывали
// записи соседа. Теперь у заметки есть владелец, а поделиться ею можно
// осознанно — на просмотр или на совместную правку.
//
// Заметки, созданные до этого разделения, остались без владельца. Их не
// прячем и не раздаём никому в собственность: они видны всем как «общие»,
// и любой может забрать такую заметку себе — данные важнее аккуратности.

type Access = 'owner' | 'edit' | 'read' | 'legacy' | 'none';

async function accessTo(noteId: string, userId: string): Promise<{ note: any; access: Access }> {
  const prisma = getPrisma();
  const note = await prisma.userNote.findUnique({ where: { id: noteId } });
  if (!note) return { note: null, access: 'none' };
  if (!note.ownerId) return { note, access: 'legacy' };
  if (note.ownerId === userId) return { note, access: 'owner' };
  const share = await prisma.noteShare.findFirst({ where: { noteId, userId } }).catch(() => null);
  if (share) return { note, access: share.canEdit ? 'edit' : 'read' };
  return { note, access: 'none' };
}

const canWrite = (a: Access) => a === 'owner' || a === 'edit' || a === 'legacy';

export function registerNoteRoutes(app: Express): void {
  // Список: свои, открытые мне и старые общие (свежие сверху)
  app.get('/api/notes', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      const me = (req as any).authUser;
      if (!me) return res.json({ notes: [] });

      const shares = await prisma.noteShare.findMany({ where: { userId: me.id } }).catch(() => [] as any[]);
      const sharedIds = (shares as any[]).map((s) => s.noteId);
      const notes = await prisma.userNote.findMany({
        where: { OR: [{ ownerId: me.id }, { ownerId: null }, { id: { in: sharedIds } }] },
        orderBy: { updatedAt: 'desc' },
      });

      // Кто ещё видит мои заметки — показываем прямо в списке, чтобы человек
      // не гадал, приватная запись или уже открыта половине отдела.
      const mine = (notes as any[]).filter((n) => n.ownerId === me.id).map((n) => n.id);
      const outgoing = mine.length
        ? await prisma.noteShare.findMany({ where: { noteId: { in: mine } } }).catch(() => [] as any[])
        : [];
      const sharedWith: Record<string, { userId: string; canEdit: boolean }[]> = {};
      for (const s of outgoing as any[]) {
        (sharedWith[s.noteId] = sharedWith[s.noteId] || []).push({ userId: s.userId, canEdit: s.canEdit });
      }
      const byId: Record<string, any> = {};
      for (const s of shares as any[]) byId[s.noteId] = s;

      res.json({
        notes: (notes as any[]).map((n) => ({
          ...n,
          mine: n.ownerId === me.id,
          legacy: !n.ownerId,
          canEdit: !n.ownerId || n.ownerId === me.id || !!byId[n.id]?.canEdit,
          sharedWith: sharedWith[n.id] || [],
        })),
      });
    } catch (err: any) { sendError(res, err); }
  });

  // Одна заметка
  app.get('/api/notes/:id', async (req: Request, res: Response) => {
    try {
      const me = (req as any).authUser;
      const { note, access } = await accessTo(req.params.id, String(me?.id || ''));
      if (!note) return res.status(404).json({ error: 'Заметка не найдена' });
      if (access === 'none') return res.status(403).json({ error: 'Это личная заметка другого сотрудника' });
      res.json({ note: { ...note, mine: access === 'owner', legacy: access === 'legacy', canEdit: canWrite(access) } });
    } catch (err: any) { sendError(res, err); }
  });

  // Создание — всегда своя
  app.post('/api/notes', async (req: Request, res: Response) => {
    try {
      const me = (req as any).authUser;
      const { title, content, color, equipmentId, groupName } = req.body;
      const note = await getPrisma().userNote.create({
        data: {
          // Заголовок из одних пробелов ничем не лучше пустого: в списке
          // заметка выглядела безымянной строкой, найти её было нечем
          title: String(title ?? '').trim() || 'Новая заметка',
          content: content || '',
          // Цвет по умолчанию — первый из набора в разделе «Блокнот». Раньше
          // здесь стоял yellow, которого в наборе нет: у такой заметки не
          // загорался кружок цвета в списке и ни один образец в выборе не
          // отмечался выбранным.
          color: color || 'bg-amber-50 dark:bg-amber-950/20 border-amber-200',
          equipmentId,
          groupName: groupName || null,
          ownerId: me?.id || null,
        },
      });
      res.json({ note: { ...note, mine: true, legacy: false, canEdit: true, sharedWith: [] } });
    } catch (err: any) { sendError(res, err); }
  });

  // Правка: владелец, тот, кому открыли на правку, и старые общие
  app.patch('/api/notes/:id', async (req: Request, res: Response) => {
    try {
      const me = (req as any).authUser;
      const { note, access } = await accessTo(req.params.id, String(me?.id || ''));
      if (!note) return res.status(404).json({ error: 'Заметка не найдена' });
      if (!canWrite(access)) {
        return res.status(403).json({ error: 'Заметка открыта вам только для чтения' });
      }
      const { title, content, color, equipmentId, groupName } = req.body;
      const updated = await getPrisma().userNote.update({
        where: { id: req.params.id },
        data: {
          title, content, color, equipmentId,
          // undefined — поле не меняем; пустая строка/null — убираем из группы
          groupName: groupName === undefined ? undefined : (groupName || null),
        },
      });
      res.json({ note: updated });
    } catch (err: any) { sendError(res, err); }
  });

  // Забрать старую общую заметку себе
  app.post('/api/notes/:id/claim', async (req: Request, res: Response) => {
    try {
      const me = (req as any).authUser;
      const { note, access } = await accessTo(req.params.id, String(me?.id || ''));
      if (!note) return res.status(404).json({ error: 'Заметка не найдена' });
      if (access !== 'legacy') return res.status(400).json({ error: 'У этой заметки уже есть владелец' });
      const updated = await getPrisma().userNote.update({ where: { id: note.id }, data: { ownerId: me.id } });
      res.json({ note: updated });
    } catch (err: any) { sendError(res, err); }
  });

  // С кем поделено
  app.get('/api/notes/:id/shares', async (req: Request, res: Response) => {
    try {
      const me = (req as any).authUser;
      const { note, access } = await accessTo(req.params.id, String(me?.id || ''));
      if (!note) return res.status(404).json({ error: 'Заметка не найдена' });
      if (access === 'none') return res.status(403).json({ error: 'Нет доступа к заметке' });
      const shares = await getPrisma().noteShare.findMany({ where: { noteId: note.id } });
      res.json({ shares });
    } catch (err: any) { sendError(res, err); }
  });

  // Поделиться: заменяем список целиком — так проще и понятнее, чем
  // добавлять и убирать по одному
  app.put('/api/notes/:id/shares', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      const me = (req as any).authUser;
      const { note, access } = await accessTo(req.params.id, String(me?.id || ''));
      if (!note) return res.status(404).json({ error: 'Заметка не найдена' });
      if (access !== 'owner') return res.status(403).json({ error: 'Делиться заметкой может только её владелец' });

      const incoming: { userId: string; canEdit?: boolean }[] = Array.isArray(req.body?.shares) ? req.body.shares : [];
      await prisma.noteShare.deleteMany({ where: { noteId: note.id } });
      for (const s of incoming) {
        if (!s?.userId || s.userId === me.id) continue;   // с собой делиться незачем
        await prisma.noteShare.create({
          data: { noteId: note.id, userId: String(s.userId), canEdit: !!s.canEdit },
        }).catch(() => {});
      }
      const shares = await prisma.noteShare.findMany({ where: { noteId: note.id } });
      res.json({ success: true, shares });
    } catch (err: any) { sendError(res, err); }
  });

  // Удаление — только владелец (и старые общие)
  app.delete('/api/notes/:id', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      const me = (req as any).authUser;
      const { note, access } = await accessTo(req.params.id, String(me?.id || ''));
      if (!note) return res.status(404).json({ error: 'Заметка не найдена' });
      if (access !== 'owner' && access !== 'legacy') {
        // Тому, с кем поделились, удаление не даём: пропажа чужой записи
        // выглядит как потеря данных. Он может только убрать её у себя.
        if (access === 'read' || access === 'edit') {
          await prisma.noteShare.deleteMany({ where: { noteId: note.id, userId: me.id } });
          return res.json({ success: true, removedShare: true });
        }
        return res.status(403).json({ error: 'Удалить заметку может только её владелец' });
      }
      await prisma.noteShare.deleteMany({ where: { noteId: note.id } }).catch(() => {});
      await prisma.userNote.delete({ where: { id: note.id } });
      res.json({ success: true });
    } catch (err: any) { sendError(res, err); }
  });
}
