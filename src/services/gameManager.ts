/**
 * Менеджер игр со стороны окна.
 *
 * Сам менеджер живёт в оболочке (`electron/games.ts`): только у неё есть диск.
 * Здесь — тонкая прослойка, и у неё ровно одна обязанность: честно сказать,
 * есть ли менеджер вообще.
 *
 * Это не мелочь. Раздел открывается и в обычном браузере — в разработке, на
 * проверках, у того, кто зашёл на сервер со своей машины. Там ставить игру
 * некуда и нечем, и притворяться, что кнопка «Установить» что-то сделает,
 * нельзя: человек нажмёт и останется ни с чем, решив, что сломана платформа.
 * Поэтому без оболочки состояние честное — «поставить отсюда нельзя».
 *
 * Игры, идущие вместе с программой (проверочная), менеджера не спрашивают
 * вовсе: ставить их не надо, и спрашивать о них оболочку — значит выдумать
 * себе зависимость на ровном месте.
 */
import { ENV_CONFIG, getAuthToken } from '../config/env';
import type { InstallState } from '../../play/builds';

/** Мост оболочки, если он есть. В браузере его нет, и это нормально. */
const bridge = (): any => {
  try { return (window as any).electron?.games || null; } catch (_) { return null; }
};

export const hasManager = (): boolean => !!bridge();

export interface GameStatus {
  gameId: string;
  state: InstallState;
  installed: string;
  published: string;
  bytesDone: number;
  bytesTotal: number;
  failure: string;
}

/**
 * Состояние, когда менеджера нет.
 *
 * Установленной игры в браузере не бывает по определению, поэтому состояние
 * одно — «поставить отсюда нечем». Отличить его от «сборку ещё не выложили»
 * человеку помогает не это поле, а подпись под кнопкой: она смотрит на то,
 * есть ли менеджер, и говорит про браузер прямо.
 */
const noManager = (gameId: string, published: string): GameStatus => ({
  gameId,
  state: 'unavailable',
  installed: '',
  published,
  bytesDone: 0,
  bytesTotal: 0,
  failure: '',
});

export async function statusOf(gameId: string, published = ''): Promise<GameStatus> {
  const games = bridge();
  if (!games) return noManager(gameId, published);
  try {
    return await games.state({ gameId, published });
  } catch (_) {
    return noManager(gameId, published);
  }
}

/**
 * Поставить или обновить игру.
 *
 * Опись и открытый ключ издателя окно получает от сервера и передаёт дальше
 * как есть — проверяет подпись оболочка. Так и должно быть: проверка имеет
 * смысл там, где файлы ложатся на диск, а не там, где их видно на экране.
 */
export async function install(p: {
  gameId: string; manifest: unknown; base: string; publisherKey: string;
}): Promise<{ ok: boolean; problem: string; status?: GameStatus }> {
  const games = bridge();
  if (!games) return { ok: false, problem: 'Установка возможна только из программы Flux' };
  const res = await games.install({
    gameId: p.gameId,
    manifest: p.manifest,
    base: p.base,
    server: ENV_CONFIG.apiUrl,
    token: getAuthToken() || '',
    publisherKey: p.publisherKey,
  });
  return { ok: !!res?.ok, problem: String(res?.problem || ''), status: res?.status };
}

export const pause = (gameId: string) => bridge()?.pause({ gameId });
export const resume = (gameId: string) => bridge()?.resume({ gameId });
export const cancel = (gameId: string) => bridge()?.cancel({ gameId });

/** Пересчитать отпечатки установленного: это и есть «Восстановить» наполовину. */
export async function verify(gameId: string): Promise<{ ok: boolean; intact?: boolean; problem?: string }> {
  const games = bridge();
  if (!games) return { ok: false, problem: 'Проверка возможна только из программы Flux' };
  return games.verify({ gameId });
}

/** Запустить игру и отдать ей одноразовый пропуск. */
export async function launch(p: {
  gameId: string; address: string; ticket: string; sessionId: string;
}): Promise<{ started: boolean; problem: string }> {
  const games = bridge();
  if (!games) return { started: false, problem: 'Запуск возможен только из программы Flux' };
  return games.launch(p);
}

/** Ход закачки. Возвращает отписку — как и остальные подписки оболочки. */
export function onProgress(cb: (p: {
  gameId: string; version: string; bytesDone: number; bytesTotal: number; paused: boolean; failure: string;
}) => void): () => void {
  const games = bridge();
  if (!games?.onProgress) return () => {};
  return games.onProgress(cb);
}
