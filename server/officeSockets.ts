/**
 * Все сокетные части Flux Office одним вызовом из connection: комната файла
 * (кто в файле, кто записывает — officeRooms.ts), совместная правка общего
 * файла (officeCollab.ts — Документ, officeSheetCollab.ts — Таблица) и главные процессы редакторов на сервере
 * (officeHostApps.ts). В server.ts — одна строка: он и так самый большой
 * файл проекта и расти не должен.
 */
import type { Server, Socket } from 'socket.io';
import { setupOfficeRooms, officeHub } from './officeRooms.js';
import { setupOfficeCollab, collabShared } from './officeCollab.js';
import { setupOfficeHostApps, officeHostFileId } from './officeHostApps.js';
import { setupOfficeSheetCollab } from './officeSheetCollab.js';
import { isCollaborativeFile } from './routes/officeFiles.js';
import { fileBytes } from './routes/fileChunks.js';
import { getPrisma } from './context.js';
import { attachIo } from './officeIo.js';
import { shareOf, shareAllows, SHARE_WRITE_GUARD } from './fileSharing.js';
import { canReadFile, canWriteFile } from './fileAccess.js';

export interface OfficeSocketDeps {
  getAuthUser: (id: string) => Promise<any>;
  /** '' — можно писать файл; тот же ответ, что у сохранения */
  mayWriteFile: (req: any, fileId: string) => Promise<string>;
}

export function setupOfficeSockets(io: Server, socket: Socket, deps: OfficeSocketDeps): { gone: (reason: string) => void } {
  const prisma = () => getPrisma();
  const watched = new Map<string, string>();
  const mutations = new Set(['office:y', 'office:x-op', 'office:take', 'office:saved', 'office:save-request']);
  // Роль участника, записанная при входе, устаревает после отзыва. Проверка
  // каждого пакета и периодическая сверка работают и между разными серверами.
  socket.use(async ([event, payload, ...tail], next) => {
    const hostFileId = officeHostFileId(socket.id, payload?.session);
    const fileId = String(event).startsWith('office:ipc') || event === 'office:save-copy' || event === 'office:host-close'
      ? hostFileId : typeof payload?.fileId === 'string' ? payload.fileId : '';
    if (!String(event).startsWith('office:') || !fileId || event === 'office:leave' || event === 'office:host-close') return next();
    try {
      const user = await deps.getAuthUser((socket as any).userId);
      if (!(await canReadFile(prisma(), user, fileId))) throw Error('Доступ к файлу отозван');
      if (mutations.has(event)) {
        const denied = await deps.mayWriteFile({ authUser: user }, fileId);
        if (denied) throw Error(denied);
      }
      const share = await shareOf(prisma(), fileId);
      if (mutations.has(event)) {
        if (share && !shareAllows(share, user.id, true)) throw Error('Доступ к записи отозван');
        Object.defineProperty(payload, SHARE_WRITE_GUARD, { value: { actorId: user.id, ...(share ? { epoch: Number(share.epoch) } : {}) } });
      }
      if (share) watched.set(fileId, `${share.epoch}:${share.permission}`);
      next();
    } catch (err: any) {
      await revoke(fileId, err?.message || 'Доступ к файлу отозван');
      const ack = tail[tail.length - 1];
      if (typeof ack === 'function') ack({ error: err?.message || 'Доступ к файлу отозван', accessRevoked: true });
      next(err instanceof Error ? err : new Error('Доступ к файлу отозван'));
    }
  });
  let checking = false;
  const accessTimer = setInterval(async () => {
    if (checking || !watched.size) return;
    checking = true;
    try {
      const user = await deps.getAuthUser((socket as any).userId);
      for (const [fileId, previous] of watched) {
        const share = await shareOf(prisma(), fileId);
        if (!(await canReadFile(prisma(), user, fileId))) {
          await revoke(fileId, 'Доступ к файлу отозван');
          watched.delete(fileId);
          continue;
        }
        if (share && previous !== `${share.epoch}:${share.permission}`) {
          const readable = await canReadFile(prisma(), user, fileId);
          if (!readable || share.permission === 'VIEW' && share.ownerId !== user?.id) {
            await revoke(fileId, readable ? 'Разрешён только просмотр. Откройте файл заново.' : 'Доступ к файлу отозван');
            watched.delete(fileId);
          } else watched.set(fileId, `${share.epoch}:${share.permission}`);
        }
      }
    } catch { /* Обрыв базы запрещает следующие пакеты; введённое остаётся у клиента. */ }
    finally { checking = false; }
  }, 1000);
  accessTimer.unref();
  attachIo(io);
  const rooms = setupOfficeRooms(socket, {
    nameOf: async (id) => (await deps.getAuthUser(id))?.name || '',
    mayWrite: async (id, fileId) => {
      const user = await deps.getAuthUser(id);
      return await canWriteFile(prisma(), user, fileId) ? deps.mayWriteFile({ authUser: user }, fileId) : 'Разрешён только просмотр';
    },
    // Единое правило чтения: чужой личный файл и файл закрытого проекта в комнату не пускают
    mayRead: async (id, fileId) => canReadFile(prisma(), await deps.getAuthUser(id), fileId),
    isShared: async (fileId) => {
      const f = await prisma().fileNode.findUnique({ where: { id: fileId }, select: { id: true, scope: true } });
      return !!f && await isCollaborativeFile(f);
    },
  });
  const collab = setupOfficeCollab(socket, {
    read: async (fileId) => {
      // Исходник сеанса совместной правки читается по номеру — те же права,
      // что у комнаты: вход в неё уже проверен, но исходник не должен
      // зависеть от того, что проверку кто-то обойдёт. Отказ — «нет файла»
      if (!(await canReadFile(prisma(), await deps.getAuthUser((socket as any).userId), fileId))) throw new Error('Файл не найден');
      const f = await prisma().fileNode.findUnique({ where: { id: fileId } });
      if (!f) throw new Error('Файл не найден');
      return fileBytes(f);
    },
  });
  const sheets = setupOfficeSheetCollab(socket);
  const revoke = async (fileId: string, error: string) => {
    await socket.leave(`office:${fileId}`);
    // Уход удаляет участника и держателя в общей базе, а не только комнату этого сервера.
    socket.emit('office:access-revoked', { fileId, error });
    await officeHub.depart(socket.id, 'leave', fileId);
    await collabShared.leave(fileId, socket.id);
  };
  const apps = setupOfficeHostApps(io, socket, { getAuthUser: deps.getAuthUser });
  return { gone: (reason) => { clearInterval(accessTimer); watched.clear(); rooms.gone(reason); collab.gone(); sheets.gone(); apps.gone(); } };
}
