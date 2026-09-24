/**
 * Все сокетные части Flux Office одним вызовом из connection: комната файла
 * (кто в файле, кто записывает — officeRooms.ts), совместная правка общего
 * файла (officeCollab.ts) и главные процессы редакторов на сервере
 * (officeHostApps.ts). В server.ts — одна строка: он и так самый большой
 * файл проекта и расти не должен.
 */
import type { Server, Socket } from 'socket.io';
import { setupOfficeRooms } from './officeRooms.js';
import { setupOfficeCollab } from './officeCollab.js';
import { setupOfficeHostApps } from './officeHostApps.js';
import { isSharedFile } from './routes/officeFiles.js';
import { fileBytes } from './routes/fileChunks.js';
import { getPrisma } from './context.js';

export interface OfficeSocketDeps {
  getAuthUser: (id: string) => Promise<any>;
  /** '' — можно писать файл; тот же ответ, что у сохранения */
  mayWriteFile: (req: any, fileId: string) => Promise<string>;
}

export function setupOfficeSockets(io: Server, socket: Socket, deps: OfficeSocketDeps): { gone: (reason: string) => void } {
  const prisma = () => getPrisma();
  const rooms = setupOfficeRooms(io, socket, {
    nameOf: async (id) => (await deps.getAuthUser(id))?.name || '',
    mayWrite: async (id, fileId) => deps.mayWriteFile({ authUser: await deps.getAuthUser(id) }, fileId),
    isShared: async (fileId) => {
      const f = await prisma().fileNode.findUnique({ where: { id: fileId }, select: { scope: true } });
      return !!f && isSharedFile(f as any);
    },
  });
  const collab = setupOfficeCollab(io, socket, {
    read: async (fileId) => {
      const f = await prisma().fileNode.findUnique({ where: { id: fileId } });
      if (!f) throw new Error('Файл не найден');
      return fileBytes(f);
    },
  });
  const apps = setupOfficeHostApps(io, socket, { getAuthUser: deps.getAuthUser });
  return { gone: (reason) => { rooms.gone(reason); collab.gone(); apps.gone(); } };
}
