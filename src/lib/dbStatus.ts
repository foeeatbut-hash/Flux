/**
 * Связь с базой: что показать в трее по последним замерам.
 *
 * Замер — один запрос `/api/health`: дорога до сервера (`rtt`) и время
 * запроса к базе на сервере (`dbMs`). Их разделение и есть смысл индикатора:
 * «медленно» из-за сети лечится иначе, чем «медленно» из-за базы, а «сервер
 * отвечает, база нет» — вообще другая поломка, чем «сервер пропал».
 *
 * Модуль чистый: ни fetch, ни таймеров — только решение по числам, чтобы
 * пороги проверялись набором, а не глазом.
 */

export type DbState = 'checking' | 'ok' | 'slow' | 'db-down' | 'offline';

export interface DbSample {
  /** Когда снят замер, мс эпохи */
  at: number;
  /** Ответил ли сервер вообще */
  reached: boolean;
  /** Ответила ли база (сервер отдал 200) */
  dbOk: boolean;
  /** Дорога туда и обратно, мс; null — ответа не было */
  rtt: number | null;
  /** Запрос к базе на сервере, мс; null — сервер не сообщил */
  dbMs: number | null;
}

/** Пороги «медленно»: на них человек уже замечает задержку в списках */
export const SLOW_RTT_MS = 400;
export const SLOW_DB_MS = 200;
/** Сколько замеров хранить для полоски истории */
export const HISTORY = 24;
/** Опрос: спокойно, пока всё хорошо; чаще, пока связи нет — чтобы заметить возврат сразу */
export const POLL_OK_MS = 15_000;
export const POLL_BAD_MS = 4_000;

export function stateOf(samples: readonly DbSample[]): DbState {
  const last = samples[samples.length - 1];
  if (!last) return 'checking';
  if (!last.reached) {
    // Одна потерянная проверка — ещё не обрыв: сон ноутбука, переключение
    // Wi-Fi. Красное загорается со второго промаха подряд
    const prev = samples[samples.length - 2];
    return prev && !prev.reached ? 'offline' : (prev ? stateOf(samples.slice(0, -1)) : 'offline');
  }
  if (!last.dbOk) return 'db-down';
  // «Медленно» — по медиане трёх последних, а не по одному выбросу
  const recent = samples.slice(-3).filter((s) => s.reached && s.dbOk);
  const med = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const rtt = med(recent.map((s) => s.rtt ?? 0));
  const db = med(recent.map((s) => s.dbMs ?? 0));
  return rtt > SLOW_RTT_MS || db > SLOW_DB_MS ? 'slow' : 'ok';
}

export const pollDelay = (state: DbState): number => (state === 'ok' || state === 'slow' ? POLL_OK_MS : POLL_BAD_MS);

export function pushSample(list: readonly DbSample[], s: DbSample): DbSample[] {
  return [...list, s].slice(-HISTORY);
}

/** Последний успешный ответ сервера — от него считается «нет связи N с» */
export function lastGood(samples: readonly DbSample[]): DbSample | null {
  for (let i = samples.length - 1; i >= 0; i--) if (samples[i].reached && samples[i].dbOk) return samples[i];
  return null;
}

export const STATE_LABEL: Record<DbState, string> = {
  checking: 'Проверка связи…',
  ok: 'Связь в норме',
  slow: 'Связь медленная',
  'db-down': 'База не отвечает',
  offline: 'Нет связи с сервером',
};

/** Что делать человеку — одна строка, без технических слов там, где можно */
export const STATE_HINT: Record<DbState, string> = {
  checking: 'Первый замер ещё идёт.',
  ok: 'Изменения сохраняются сразу.',
  slow: 'Изменения сохраняются, но с задержкой. Проверьте сеть или нагрузку на сервер.',
  'db-down': 'Сервер работает, но база недоступна: новые изменения не сохранятся. Сообщите администратору.',
  offline: 'Изменения не сохранятся, пока связь не вернётся. Программа проверяет её сама.',
};

export function msLabel(ms: number | null): string {
  if (ms == null) return '—';
  return ms < 10 ? `${ms.toFixed(1)} мс` : `${Math.round(ms)} мс`;
}

export function agoLabel(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 5) return 'только что';
  if (s < 60) return `${s} с назад`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} мин назад` : `${Math.round(m / 60)} ч назад`;
}

export function modeLabel(mode: string | undefined, dialect: string | undefined): string {
  const m = String(mode || '').toUpperCase();
  const d = String(dialect || '').toLowerCase();
  const engine = d === 'sqlite' ? 'SQLite' : d === 'mysql' ? 'MySQL' : d === 'postgresql' || d === 'postgres' ? 'PostgreSQL' : d || 'база';
  return m === 'LOCAL' ? `Локальная · ${engine}` : `Общая база компании · ${engine}`;
}
