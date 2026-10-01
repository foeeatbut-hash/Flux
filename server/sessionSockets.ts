import type { Server } from 'socket.io';
import type { createAuthSessions } from './authSessions.js';
import { authTokenFromRequest } from './authCookies.js';
import { licenseForUser } from './licenseService.js';

const READ_EVENTS = new Set(['presence:list', 'play:hello', 'play:heartbeat', 'play:snapshot', 'office:join', 'office:leave', 'office:y-want', 'office:x-want', 'office:y-aware', 'office:host-open', 'office:host-close']);

/** Открытая вкладка не сохраняет отозванные права или лицензию до следующего входа. */
export function protectSessionSockets(io: Server, sessions: ReturnType<typeof createAuthSessions>): void {
  io.use(async (socket, next) => {
    const token = String(socket.handshake.auth?.token || authTokenFromRequest({ headers: socket.handshake.headers }));
    try {
      const user = await sessions.validate(token);
      if (!user) return next(new Error('unauthorized'));
      const license = await licenseForUser(user);
      if (!license.licensed && !license.readOnly) return next(new Error('license-required'));
      (socket as any).userId = user.id;
      socket.data.userId = user.id;
      const check = async () => {
        const current = await sessions.validate(token);
        if (!current) throw new Error('unauthorized');
        const state = await licenseForUser(current);
        if (!state.licensed && !state.readOnly) throw new Error('license-required');
        return state;
      };
      socket.use(async (packet, accept) => {
        try {
          const state = await check();
          const event = String(packet[0]);
          // Чтение книги использует тот же IPC, что запись. Сохранение и изменения
          // общей модели запрещаем отдельно; локальный просмотр остаётся доступен.
          const ipcRead = event === 'office:ipc' && !/save|write|export|delete|create|rename/i.test(String(packet[1]?.channel || ''));
          if (state.readOnly && !READ_EVENTS.has(event) && !ipcRead) {
            const ack = packet[packet.length - 1];
            if (typeof ack === 'function') ack({ error: 'Лицензия истекла. Доступно только чтение.' });
            socket.emit('license:changed', { readOnly: true });
            return;
          }
          accept();
        } catch (_) { socket.disconnect(true); }
      });
      const timer = setInterval(() => { void check().catch(() => socket.disconnect(true)); }, 30000);
      timer.unref();
      socket.once('disconnect', () => clearInterval(timer));
      next();
    } catch (_) { next(new Error('unauthorized')); }
  });
}
