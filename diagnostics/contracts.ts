/**
 * Что диагностика имеет право записать.
 *
 * Главная опасность подробной записи не в объёме, а в том, что в неё утекают
 * данные проекта: имя документа, поисковая строка, кусок ведомости, пароль из
 * сообщения драйвера базы. Обычная защита — «почистить строку регулярным
 * выражением» — ловит только то, что автор вспомнил, и молча пропускает
 * остальное.
 *
 * Поэтому здесь не фильтр, а **разрешительный список**: у каждого события
 * объявлены его поля и вид каждого поля. Поле, которого нет в списке, не
 * записывается вообще — ни при какой ошибке в вызывающем коде. Свободного
 * текста среди видов нет ни одного: записать сообщение целиком технически
 * нечем, и это не дисциплина, а свойство типа.
 *
 * Вид поля задаёт заодно и единицу измерения. `characters` нельзя случайно
 * подписать байтами: это разные виды, и `cleanFields` приводит значение по
 * виду, а не по имени.
 *
 * Модуль общий для окна, сервера и Electron — ни React, ни `node:`, ни
 * express здесь быть не должно.
 */

/** Версия формата записи. Меняется, когда меняется смысл полей. */
export const SCHEMA_VERSION = 1;

/** Чем закончилась операция. Отменённый запрос — не поломка сервера. */
export type Outcome = 'ok' | 'error' | 'cancelled' | 'conflict' | 'skipped';

/**
 * Виды значений. Из вида следует и единица, и способ очистки:
 *
 * - `id` — идентификатор, который сгенерировали мы сами (трасса, участок).
 *   Пользовательских данных в нём нет по построению;
 * - `name` — короткое имя из нашего словаря: метод HTTP, имя события сокета,
 *   канал IPC. Проверяется по набору символов, чужое имя отбрасывается;
 * - `route` — адрес, пришедший от человека: приводится к шаблону по словарю
 *   известных частей, всё незнакомое становится `:id`;
 * - `pattern` — шаблон маршрута, взятый у самого Express, то есть из нашего
 *   исходного кода. Чистится только по набору знаков: прогонять его через
 *   словарь нельзя, иначе `/api/users/:id/signature` снова схлопнется в
 *   `/api/users/:id/:id` и подпись станет неотличима от прав;
 * - `frame` — кадр стека без пути, номера строки и случайных идентификаторов;
 * - `code` — код ошибки или состояния: короткий, обезличивается;
 * - `ms` — миллисекунды по монотонным часам;
 * - `bytes`, `chars`, `count` — байты, знаки, штуки. Три разных вида именно
 *   затем, чтобы длину текста нельзя было записать как размер;
 * - `flag` — да/нет;
 * - `phase`, `outcome` — служебные перечисления участка работы.
 */
export type FieldKind =
  | 'id' | 'name' | 'route' | 'pattern' | 'frame' | 'code'
  | 'ms' | 'bytes' | 'chars' | 'count'
  | 'flag' | 'phase' | 'outcome';

/** Какой тип в TypeScript отвечает виду поля. */
export interface KindType {
  id: string;
  name: string;
  route: string;
  pattern: string;
  frame: string;
  code: string;
  ms: number;
  bytes: number;
  chars: number;
  count: number;
  flag: boolean;
  phase: 'start' | 'end';
  outcome: Outcome;
}

/**
 * Поля, разрешённые в любом событии. Здесь живёт связь записей между собой:
 * `trace` — одна сетевая операция, `span` — один участок работы, `parent` —
 * участок, внутри которого он открыт, `interaction` — одна команда человека.
 *
 * `interaction` намеренно не «идентификатор сотрудника»: он новый на каждое
 * осмысленное действие, и связать по нему работу человека за день нельзя.
 */
export const COMMON = {
  trace: 'id',
  span: 'id',
  parent: 'id',
  interaction: 'id',
  phase: 'phase',
  outcome: 'outcome',
  durationMs: 'ms',
} as const;

/**
 * Словарь событий. Ключ — имя события, значение — его собственные поля.
 *
 * Новое событие без строки здесь записать нельзя: `record` не примет имя, а
 * `scripts/test-diagnostics.ts` проверяет, что у каждого имени объявлены поля
 * и что среди видов нет свободного текста.
 */
export const EVENTS = {
  // ── Запрос из окна ────────────────────────────────────────────────────────
  'fetch.start': { method: 'name', route: 'route' },
  'fetch.headers': { method: 'name', route: 'route', status: 'code', serverTrace: 'id', declaredBytes: 'bytes' },
  'fetch.consume': { route: 'route', reader: 'name', totalMs: 'ms', ok: 'flag', error: 'name' },
  'fetch.error': { method: 'name', route: 'route', error: 'name' },

  // ── Запрос на сервере ─────────────────────────────────────────────────────
  'http.start': { method: 'name', route: 'pattern', requestBytes: 'bytes' },
  'http.end': { method: 'name', route: 'pattern', status: 'code', aborted: 'flag', requestBytes: 'bytes', responseBytes: 'bytes' },

  // ── База ──────────────────────────────────────────────────────────────────
  'db.op': { model: 'name', operation: 'name', rows: 'count', ok: 'flag', error: 'name', code: 'code' },

  // ── Сокет ─────────────────────────────────────────────────────────────────
  'socket.connect': { connection: 'id' },
  'socket.disconnect': { connection: 'id', reason: 'name' },
  'socket.receive': { connection: 'id', name: 'name', payloadBytes: 'bytes' },
  'socket.send': { connection: 'id', name: 'name', payloadBytes: 'bytes' },
  'socket.ack': { connection: 'id', name: 'name' },
  'socket.error': { error: 'name' },
  'socket.retry': { attempt: 'count' },

  // ── Мост между окном и главным процессом ──────────────────────────────────
  // Ожидание и выполнение разделены: время в обработчике — не то же самое,
  // что время, которое прождало окно.
  'ipc.call': { channel: 'name', ok: 'flag', error: 'name', waitMs: 'ms' },
  'ipc.handle': { channel: 'name', sender: 'count', ok: 'flag', error: 'name' },

  // ── Процесс ───────────────────────────────────────────────────────────────
  'process.start': { pid: 'count', node: 'name', platform: 'name', arch: 'name' },
  'process.sample': {
    pid: 'count', intervalMs: 'ms', cpuPercent: 'count', rssBytes: 'bytes',
    heapUsedBytes: 'bytes', externalBytes: 'bytes', loopP99Ms: 'ms', loopMaxMs: 'ms',
  },
  'process.uncaught': { error: 'name', frame1: 'frame', frame2: 'frame', frame3: 'frame' },

  // ── Electron ──────────────────────────────────────────────────────────────
  'electron.process': { pid: 'count', type: 'name', cpuPercent: 'count', workingSetKB: 'count', peakWorkingSetKB: 'count' },
  'window.state': { id: 'count', state: 'name' },
  'window.load-error': { id: 'count', code: 'code', mainFrame: 'flag' },
  'renderer.gone': { id: 'count', reason: 'name', exitCode: 'code' },
  'child.gone': { type: 'name', reason: 'name', exitCode: 'code' },
  'app.quit': {},

  // ── Окно ──────────────────────────────────────────────────────────────────
  'renderer.start': { timeOrigin: 'ms' },
  'renderer.sample': { dropped: 'count', pending: 'count', visible: 'flag', heapUsedBytes: 'bytes' },
  'renderer.error': { error: 'name', frame1: 'frame', frame2: 'frame', frame3: 'frame' },
  'renderer.rejection': { error: 'name', frame1: 'frame', frame2: 'frame', frame3: 'frame' },
  'ui.stall': {},
  'ui.longtask': { startMs: 'ms' },
  'ui.event': { name: 'name', startMs: 'ms' },
  'ui.click': { tag: 'name', action: 'name' },
  'resource.end': { route: 'route', initiator: 'name', startMs: 'ms', ttfbMs: 'ms', downloadMs: 'ms', transferredBytes: 'bytes', decodedBytes: 'bytes' },
  'window.net': { state: 'name' },
  'observer.unavailable': { name: 'name' },

  // ── Журнал программы ──────────────────────────────────────────────────────
  // Из старого журнала берутся только место и код: свободный текст сообщения
  // и стек могут содержать имя документа и данные проекта.
  'log.warn': { context: 'name', code: 'code', frame1: 'frame' },
  'log.error': { context: 'name', code: 'code', frame1: 'frame', frame2: 'frame', frame3: 'frame' },

  // ── Офисный движок ────────────────────────────────────────────────────────
  // Ни книги, ни текста: только сколько знаков вышло и сколько это заняло.
  'office.init': { section: 'name', documentRef: 'id', modulesMs: 'ms', bookMs: 'ms' },
  'office.snapshot': { section: 'name', documentRef: 'id', characters: 'chars', stringifyMs: 'ms' },
  'office.save': { section: 'name', documentRef: 'id', characters: 'chars', reason: 'name', status: 'code' },
  'office.export': { section: 'name', documentRef: 'id', format: 'name', resultBytes: 'bytes' },
  'office.import': { section: 'name', documentRef: 'id', format: 'name', sourceBytes: 'bytes' },
  'office.dispose': { section: 'name', documentRef: 'id' },

  // ── Свёрнутый повтор ──────────────────────────────────────────────────────
  // Опрос уведомлений идёт раз в минуту у каждого окна и в разборе не нужен
  // построчно. Одна строка на пятисекундное окно говорит то же самое: сколько
  // раз, сколько всего заняло и какой был худший случай.
  'agg.repeat': { name: 'name', route: 'route', status: 'code', repeats: 'count', totalMs: 'ms', maxMs: 'ms' },

  // ── Сама запись ───────────────────────────────────────────────────────────
  // Счётчики потерь обязаны быть видны: «событий не было» и «события потеряны»
  // для разбора — совершенно разные ответы.
  'writer.state': {
    source: 'name', queued: 'count', dropped: 'count', failures: 'count',
    written: 'count', bytesOnDisk: 'bytes', freeDiskBytes: 'bytes',
    detailed: 'flag', workerAlive: 'flag',
  },
} as const;

export type EventName = keyof typeof EVENTS;

type OwnSpec<E extends EventName> = (typeof EVENTS)[E];
type FullSpec<E extends EventName> = OwnSpec<E> & typeof COMMON;

/**
 * Поля, которые разрешено передать этому событию. Опечатка в имени поля или
 * число там, где объявлено имя, — ошибка типов, а не находка на разборе через
 * полгода.
 */
export type SafeFields<E extends EventName> = {
  [K in keyof FullSpec<E>]?: FullSpec<E>[K] extends FieldKind ? KindType[FullSpec<E>[K]] : never;
};

/** Разрешённые поля события вместе с общими — для проверки во время работы. */
export function specOf(event: string): Record<string, FieldKind> | null {
  const own = (EVENTS as Record<string, Record<string, FieldKind>>)[event];
  if (!own) return null;
  return { ...COMMON, ...own };
}

export const EVENT_NAMES = Object.keys(EVENTS) as EventName[];

/** Одна запись в файле. Конверт отделён от данных намеренно: поля конверта
 *  задаются записывающим и не могут быть подменены вызывающим кодом. */
export interface DiagnosticEvent {
  v: number;
  time: string;
  session: string;
  seq: number;
  source: string;
  event: string;
  data: Record<string, string | number | boolean>;
}
