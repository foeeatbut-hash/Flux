import type { Server as SocketIOServer } from 'socket.io';
import { setupPresence } from './presence.js';
import { setupOfficeSockets } from './officeSockets.js';
import { relayProjectEvent } from './projectEvents.js';

// Подключения по socket.io: присутствие, трансляции тегов и оборудования,
// живая часть платформы и Flux Office.
//
// Вынесено из server.ts. Токен сокета проверяет io.use() в server.ts, до этого
// обработчика. Сюда передаётся только то, чем server.ts пользуется и сам:
// клиент базы (он пересоздаётся при смене базы, поэтому функцией), профиль
// сессии из кэша, проверка права писать файл и список скрывших присутствие
// (его перечитывает refreshHiddenOnline() в server.ts).

interface SocketDeps {
  getPrisma: () => any;
  getAuthUser: (userId: string) => Promise<any>;
  /** '' — можно писать файл; тот же ответ, что у сохранения */
  mayWriteFile: (req: any, fileId: string) => Promise<string>;
  hiddenIds: () => Set<string>;
}

export function registerSockets(io: SocketIOServer, deps: SocketDeps): void {
  const { getPrisma, getAuthUser, mayWriteFile, hiddenIds } = deps;

  // ── Кто сейчас в сети ────────────────────────────────────────────────────────
  // Один сотрудник — несколько вкладок и окон, поэтому считаем сокеты, а не
  // людей: закрытая вкладка не должна гасить человека, у которого открыто ещё
  // три. «Не в сети» объявляется, когда ушёл последний его сокет.
  //
  // Правило одно для всех: администратор виден так же, как остальные. Скрытое
  // присутствие начальника — это не приватность, а неравенство, из-за которого
  // в чате пишут в пустоту, не понимая, дошло ли.
  const online = new Map<string, Set<string>>();
  const lastSeen = new Map<string, number>();

  const rosterOnline = () => Array.from(online.keys());

  // Присутствие живёт в общей базе (server/presence.ts): в отделе база одна, а
  // сервер у каждого свой — в памяти оно означало бы «все не в сети»
  const { markPresence, markGone, rosterFromDb, isHidden } = setupPresence({
    getPrisma,
    localOnline: rosterOnline,
    localSeen: () => Object.fromEntries(lastSeen),
    broadcast: (roster) => io.emit('presence:list', roster),
    hiddenIds,
    broadcastTo: (userId, roster) => io.to(`user:${userId}`).emit('presence:list', roster),
  });

  // Подключение и отключение пишутся в консоль только при отладке: на каждое
  // окно каждого сотрудника это сотни строк в день без пользы
  const debug = process.env.FLUX_SOCKET_DEBUG === '1';

  // Подключение и уход одного человека выполняются по очереди: без неё
  // отложенная отметка «ушёл» могла записаться позже отметки «вернулся»
  // и до ближайшего сердцебиения показывать вернувшегося офлайн
  const presenceQueue = new Map<string, Promise<void>>();
  const queuePresence = (userId: string, work: () => Promise<void>) => {
    const next = (presenceQueue.get(userId) || Promise.resolve()).then(work).catch(() => {});
    presenceQueue.set(userId, next);
    void next.then(() => { if (presenceQueue.get(userId) === next) presenceQueue.delete(userId); });
    return next;
  };

  io.on('connection', (socket) => {
    if (debug) console.log(`[Socket] client connected: ${socket.id}`);

    // Личная комната сокета. Без неё сообщения чата рассылались всем
    // подключённым: интерфейс чужую переписку прятал, но текст всё равно
    // приходил на каждую машину в сети
    const uid = (socket as any).userId;
    if (uid) { socket.data.userId = uid; socket.join(`user:${uid}`); }

    if (uid) {
      const was = online.get(uid);
      if (was) was.add(socket.id);
      else {
        online.set(uid, new Set([socket.id]));
        // Появился — сказать всем. Себе тоже: своя точка «в сети» подтверждает,
        // что связь есть, и отличает «никто не отвечает» от «я отключён».
        // Скрывшему себя — только себе: остальным он не появлялся
        if (isHidden(uid)) socket.emit('presence:online', { userId: uid });
        else io.emit('presence:online', { userId: uid });
      }
    }

    // Живая часть платформы: присутствие с арендой и подписка на её события.
    // Доступ проверяется на каждом событии, а не один раз здесь: его отбирают
    // в живой сессии, и подключившийся минуту назад сокет права не даёт.

    // Пришедшему — весь список сразу: без него человек до первого чужого входа
    // видел бы всех офлайн. Список считается от его лица: себя скрывший видит
    const sendRoster = async () => socket.emit('presence:list', await rosterFromDb(uid || ''));
    void (async () => { if (uid) await queuePresence(uid, () => markPresence(uid)); await sendRoster(); })();
    // Список по запросу окна — не чаще раза в две секунды: каждый запрос читает
    // базу, а вкладка в цикле могла бы читать её без остановки. Лишний запрос
    // не теряется, а откладывается до конца окна (один отложенный на сокет)
    let rosterAt = 0;
    let rosterTimer: ReturnType<typeof setTimeout> | null = null;
    socket.on('presence:list', () => {
      const wait = rosterAt + 2000 - Date.now();
      if (wait <= 0) { rosterAt = Date.now(); void sendRoster().catch(() => {}); return; }
      if (rosterTimer) return;
      rosterTimer = setTimeout(() => { rosterTimer = null; rosterAt = Date.now(); void sendRoster().catch(() => {}); }, wait);
    });

    // Только подсказка о записанной сущности. Присланные текст, details и
    // projectId не транслируются: их могли подделать или взять из чужого проекта.
    for (const event of ['tag:linked', 'tag:updated', 'equipment:conflict'] as const) {
      socket.on(event, (data) => {
        void (async () => {
          const actor = uid ? await getAuthUser(uid) : null;
          await relayProjectEvent(io, actor, socket.id, event, data);
        })().catch(() => { /* права или состав не прочитались — нет рассылки */ });
      });
    }

    // Flux Office: комната файла, совместная правка, редакторы на сервере (server/officeSockets.ts)
    const office = setupOfficeSockets(io, socket, { getAuthUser, mayWriteFile });

    socket.on('disconnect', (reason) => {
      if (debug) console.log(`[Socket] client disconnected: ${socket.id}`);
      if (rosterTimer) { clearTimeout(rosterTimer); rosterTimer = null; }
      office.gone(String(reason || ''));
      if (uid) {
        const set = online.get(uid);
        set?.delete(socket.id);
        if (set && set.size === 0) {
          online.delete(uid);
          const at = Date.now();
          lastSeen.set(uid, at);
          // И в общей базе тоже: иначе на чужих машинах он останется «в сети»
          // до конца срока свежести отметки
          // Если человек успел вернуться (другая вкладка, переподключение), метка «ушёл» не пишется
          void queuePresence(uid, async () => { if (!online.has(uid)) await markGone(uid); });
          // Скрытый и так числился ушедшим — событие о его уходе никому не нужно
          if (!isHidden(uid)) io.emit('presence:offline', { userId: uid, at });
        }
      }
    });
  });
}
