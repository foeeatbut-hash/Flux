/**
 * Живая часть платформы: присутствие и подписка на события.
 *
 * Отдельным файлом, а не строчками в `server.ts`: у сокета платформы свой
 * жизненный цикл — приветствие, сердцебиение, аренда, поколение, — и вмешивать
 * его в общий обработчик соединения значило бы спрятать этот цикл среди
 * чужих подписок.
 *
 * Два правила, которые здесь и живут:
 *
 *   1. **Доступ проверяется на каждом событии, а не один раз при подключении.**
 *      Доступ к платформе отбирают в живой сессии, и сокет, подключившийся
 *      минуту назад, не даёт на это права.
 *   2. **Подписка идёт ДО снимка.** Окно сначала входит в свои комнаты и
 *      только потом просит состояние: наоборот в щель между ними помещаются
 *      события, которых оно не увидит никогда.
 */

import { APP_PLAY } from '../../play/features.js';
import { PLAY_LIMITS } from '../../play/contracts.js';
import { allowed } from './access.js';
import { connect, disconnect, heartbeat, sweep } from './presence.js';
import { snapshotFor } from './snapshot.js';
import { ensurePlayReady } from './tables.js';

/** Как часто подметать протухшие аренды. */
const SWEEP_MS = 15_000;

let sweeper: ReturnType<typeof setInterval> | null = null;

export function startPresenceSweep(): void {
  if (sweeper) return;
  sweeper = setInterval(() => { void sweep().catch(() => {}); }, SWEEP_MS);
  if (typeof sweeper.unref === 'function') sweeper.unref();
}

export function stopPresenceSweep(): void {
  if (sweeper) clearInterval(sweeper);
  sweeper = null;
}

/**
 * Подключить платформу к одному сокету.
 *
 * `userOf` отдаёт профиль по идентификатору: доступ решается по профилю, а не
 * по тому, что прислало окно. Личность — из сессии.
 */
export function attachPlaySocket(socket: any, userId: string, userOf: (id: string) => Promise<any>): void {
  if (!userId) return;

  let generation = 0;
  let joined = false;

  const mayPlay = async (): Promise<boolean> => {
    try { return await allowed(await userOf(userId), APP_PLAY); } catch (_) { return false; }
  };

  /**
   * Приветствие: окно называет своё устройство и просит место в комнатах.
   *
   * Ответ несёт срок аренды и предел устаревания — те же числа, что у
   * сервера. Окно по ним решает, верить ли показанному; разойдись они, и
   * получилось бы состояние, в котором окно уверено, а сервер уже нет.
   */
  socket.on('play:hello', async (data: any, ack?: (r: any) => void) => {
    if (!(await mayPlay())) { ack?.({ ok: false }); return; }
    const deviceId = String(data?.deviceId || socket.id).slice(0, 80);
    const invisible = data?.invisible === true;
    try {
      // Вход в платформу бывает и отсюда, а не только по HTTP: таблицы могут
      // быть ещё не созданы
      if (await ensurePlayReady()) { ack?.({ ok: false }); return; }
      generation = await connect({ userId, deviceId, connectionId: socket.id, invisible });
      // Комнаты раньше снимка: иначе события, случившиеся между ними, не
      // достанутся окну никогда
      socket.join(`play:user:${userId}`);
      joined = true;
      ack?.({
        ok: true,
        generation,
        heartbeatMs: PLAY_LIMITS.heartbeatMs,
        leaseMs: PLAY_LIMITS.presenceLeaseMs,
        staleAfterMs: PLAY_LIMITS.staleAfterMs,
      });
    } catch (_) {
      ack?.({ ok: false });
    }
  });

  /**
   * Сердцебиение продлевает аренду.
   *
   * Ответ `false` значит «твоей записи больше нет»: окно переподключается, а
   * не делает вид, что всё хорошо. Молчаливое «ничего не обновилось» здесь и
   * есть ложный онлайн.
   */
  socket.on('play:heartbeat', async (data: any, ack?: (r: any) => void) => {
    if (!joined || !(await mayPlay())) { ack?.({ ok: false }); return; }
    try {
      const alive = await heartbeat(socket.id, {
        status: data?.status,
        activity: data?.activity,
        gameId: data?.gameId ?? undefined,
      });
      ack?.({ ok: alive });
    } catch (_) {
      ack?.({ ok: false });
    }
  });

  /** Состояние целиком: то, чем окно догоняет пропущенное. */
  socket.on('play:snapshot', async (_data: any, ack?: (r: any) => void) => {
    if (!(await mayPlay())) { ack?.({ ok: false }); return; }
    try {
      ack?.({ ok: true, snapshot: await snapshotFor(userId) });
    } catch (_) {
      ack?.({ ok: false });
    }
  });

  /**
   * Соединение закрылось.
   *
   * Удаляем только СВОЮ запись — по поколению. Поздний `disconnect` старого
   * соединения приходит уже после того, как окно переподключилось, и без
   * этой проверки погасил бы новое: человек мигал бы «ушёл — пришёл».
   */
  socket.on('disconnect', () => {
    if (!joined) return;
    void disconnect(socket.id, generation).catch(() => {});
  });
}
