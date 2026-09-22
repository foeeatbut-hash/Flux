/**
 * Запросы платформы из окна.
 *
 * Одно правило на весь файл: **каждая команда идёт с ключом идемпотентности**.
 * Ключ придумывает окно и держит его до получения ответа — именно поэтому
 * повтор после обрыва связи возвращает тот же ответ, а не делает действие
 * второй раз. Сервер без ключа команду не принимает вовсе, и это сделано
 * нарочно: забытый ключ должен ломаться сразу и громко, а не однажды завести
 * вторую группу у человека, который просто нажал дважды.
 *
 * Ответ у всех команд один по форме: `{ ok, repeated, result }` или
 * `{ ok: false, code, message }`. Окно разбирает его одинаково, и `repeated`
 * ему нужен: без него «Приглашение отправлено» показалось бы дважды, и человек
 * решил бы, что отправил два.
 */
import { ENV_CONFIG, getAuthToken } from '../config/env';
import { playErrorText, type PlayCommandReceipt } from '../../play/contracts';

const headers = (key?: string): Record<string, string> => {
  const token = getAuthToken();
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(key ? { 'Idempotency-Key': key } : {}),
  };
};

/** Ключ на одно намерение человека. Повтор того же намерения — тот же ключ. */
export const newKey = (): string => {
  try { return crypto.randomUUID(); } catch (_) { /* старый движок */ }
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

async function call<T>(method: string, path: string, body?: unknown, key?: string): Promise<PlayCommandReceipt<T>> {
  let res: Response;
  try {
    res = await fetch(`${ENV_CONFIG.apiUrl}/play${path}`, {
      method,
      headers: headers(key),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e: any) {
    // Сети нет — это не «нельзя», а «не дошло». Разница важна: повторять
    // стоит только второе
    return { ok: false, repeated: false, code: 'OFFLINE', message: 'Нет связи с сервером' };
  }

  const data = await res.json().catch(() => null);
  if (res.ok) return (data || { ok: true, repeated: false }) as PlayCommandReceipt<T>;

  /**
   * 404 от платформы — это «такого нет», и разбирать его как ошибку нельзя:
   * ровно так же она отвечает тому, у кого нет доступа. Окно в этом случае
   * просто перестаёт показывать раздел, а не рисует красную плашку.
   */
  const code = String(data?.code || (res.status === 404 ? 'NOT_FOUND' : 'INTERNAL'));
  return { ok: false, repeated: false, code, message: String(data?.message || playErrorText(code)) };
}

const get = <T>(path: string) => call<T>('GET', path);
const post = <T>(path: string, body?: unknown, key?: string) => call<T>('POST', path, body ?? {}, key);

// ── Состояние ───────────────────────────────────────────────────────────────

export const fetchState = () => get<any>('/state');
export const fetchInbox = () => get<any[]>('/inbox');
export const fetchPlatform = () => get<any>('/platform');

/** Что опубликовано для игры: опись сборки и открытый ключ издателя. */
export const fetchBuild = (gameId: string) => get<any>(`/builds/${encodeURIComponent(gameId)}`);

// ── Группа ──────────────────────────────────────────────────────────────────

export const createParty = (gameId: string | null, key: string) => post<any>('/party', { gameId }, key);
export const leaveParty = (key: string) => post<any>('/party/leave', {}, key);
export const kickFromParty = (userId: string, key: string) => post<any>('/party/kick', { userId }, key);

// ── Приглашения ─────────────────────────────────────────────────────────────

export const invite = (userId: string, gameId: string | null, key: string) =>
  post<any>('/invites', { userId, gameId }, key);
export const acceptInvite = (id: string, key: string) => post<any>(`/invites/${id}/accept`, {}, key);
export const declineInvite = (id: string, key: string) => post<any>(`/invites/${id}/decline`, {}, key);
export const cancelInvite = (id: string, key: string) => post<any>(`/invites/${id}/cancel`, {}, key);

// ── Лобби ───────────────────────────────────────────────────────────────────

export const openLobby = (gameId: string, key: string) => post<any>('/lobby', { gameId }, key);

export const setReady = (lobbyId: string, ready: boolean, expectedVersion: number, key: string) =>
  post<any>('/lobby/ready', { lobbyId, ready, expectedVersion }, key);

export const setTeam = (lobbyId: string, userId: string, team: number, expectedVersion: number, key: string) =>
  post<any>('/lobby/team', { lobbyId, userId, team, expectedVersion }, key);

// ── Матч ────────────────────────────────────────────────────────────────────

export const startSession = (lobbyId: string, expectedVersion: number, key: string) =>
  post<any>('/session', { lobbyId, expectedVersion }, key);

/** «Вернуться в игру»: новый билет на идущий матч, старый гасится. */
export const rejoinSession = () => post<any>('/session/rejoin', {});

export const cancelSession = () => post<any>('/session/cancel', {});
