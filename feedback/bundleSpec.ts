/**
 * Договор о пакете диагностики.
 *
 * Пакет собирается из четырёх мест — окно, оболочка, сервер, база — и каждое
 * может отдать меньше, чем хотелось: оболочки нет в браузере, файлы сервера
 * ротируются, буфер окна ограничен. Разбирающий обязан различать «этого не
 * было» и «этого не записали»: без такого различения он читает сводку без
 * ошибок и делает вывод, что ошибок не было, — а их просто не сохранили.
 *
 * Поэтому опись пакета устроена вокруг полноты, а не вокруг содержимого. Для
 * каждого источника сказано, что с ним, за какой интервал он на самом деле
 * покрывает и сколько потеряно.
 *
 * Модуль общий: ни `react`, ни `express`, ни `node:` здесь быть не может —
 * его тянут и окно, и сервер.
 */

/** Версия описи. Меняется, когда меняется смысл полей, а не их набор. */
export const BUNDLE_SCHEMA_VERSION = 1;

/** Откуда берутся записи. Больше источников не бывает — список закрытый. */
export const SOURCES = ['renderer', 'shell', 'server', 'database'] as const;
export type SourceName = (typeof SOURCES)[number];

export const SOURCE_NAMES: Record<SourceName, string> = {
  renderer: 'Окно программы',
  shell: 'Оболочка',
  server: 'Сервер',
  database: 'База данных',
};

/**
 * Что с источником.
 *
 * `unavailable` и `error` — разные вещи, и складывать их нельзя: в браузере
 * оболочки нет по устройству, и это не поломка, а вот отказ чтения файлов —
 * поломка, о которой надо знать.
 */
export const SOURCE_STATES = ['available', 'unavailable', 'expired', 'truncated', 'error'] as const;
export type SourceState = (typeof SOURCE_STATES)[number];

export const SOURCE_STATE_NAMES: Record<SourceState, string> = {
  available: 'приложен',
  unavailable: 'источника нет',
  expired: 'записи устарели и удалены',
  truncated: 'приложен не целиком',
  error: 'прочитать не удалось',
};

/** Что известно про один источник. */
export interface SourceReport {
  source: SourceName;
  state: SourceState;
  /** Почему не `available` — словами, для человека. */
  reason?: string;
  /** Сколько событий вошло в пакет. */
  events: number;
  bytes: number;
  /** Строк, которые не разобрались: битый хвост файла — обычное дело. */
  broken?: number;
  /**
   * Что отброшено и почему.
   *
   * `dropped` — потеряно при записи (переполнение очереди, нет места на
   * диске), `omitted` — не поместилось в пакет при обрезке. Разные причины:
   * первое чинится настройками записи, второе — пределом пакета.
   */
  dropped?: number;
  omitted?: number;
  /**
   * Интервал, который источник ФАКТИЧЕСКИ покрывает.
   *
   * Не тот, который просили. Если попросили десять минут, а записи начинаются
   * с середины, — здесь будет середина, и разбирающий увидит, что первой
   * половины у него нет.
   */
  from?: string;
  to?: string;
  /** Контрольная сумма приложенного — чтобы отличить обрезку от подмены. */
  sha256?: string;
}

/**
 * Опись пакета.
 *
 * `snapshotId` — метка неизменяемого снимка. Повторная передача отправляет тот
 * же пакет с тем же `snapshotId`; новое воспроизведение — новый снимок рядом,
 * а не тихая замена доказательств.
 */
export interface BundleManifest {
  bundleSchemaVersion: number;
  snapshotId: string;
  clientRequestId?: string;
  reportId?: string;
  deploymentId?: string;
  appVersion?: string;
  buildId?: string;
  /** Сеанс окна, вокруг которого собран пакет. */
  incidentSessionId?: string;
  /** Метка аварии прошлого запуска, если пакет о ней. */
  crashId?: string;
  sectionKey?: string;
  /** Запрошенный интервал: от и до. Фактический — у каждого источника свой. */
  requestedFrom: string;
  requestedTo: string;
  /**
   * Начало отсчёта монотонного времени в окне.
   *
   * Длительности считаются по нему, а не по часам: часы двух машин расходятся,
   * и вычитать их друг из друга нельзя. Связь между машинами — только по
   * traceId.
   */
  timeOrigin?: number;
  sources: SourceReport[];
  /** Что собралось: собирается | готов | неполон | не удалось. */
  state: BundleState;
  /** Когда собран. */
  builtAt?: string;
}

export const BUNDLE_STATES = ['PENDING', 'READY', 'PARTIAL', 'FAILED'] as const;
export type BundleState = (typeof BUNDLE_STATES)[number];

export const BUNDLE_STATE_NAMES: Record<BundleState, string> = {
  PENDING: 'собирается',
  READY: 'готов',
  PARTIAL: 'готов, но неполон',
  FAILED: 'собрать не удалось',
};

/**
 * Сколько времени вокруг происшествия берём.
 *
 * Десять минут до открытия панели и всё, что случилось, пока человек писал, —
 * но не больше пятнадцати минут вместе. Числа стартовые: их надо померить, а
 * не назначить навсегда.
 */
export const WINDOW_BEFORE_MS = 10 * 60 * 1000;
export const WINDOW_TOTAL_MS = 15 * 60 * 1000;

/** Сколько байтов отдаёт один источник в пакет. */
export const SOURCE_BYTES = 8 * 1024 * 1024;
/** Сколько весит собранный архив и сколько в нём распакованных данных. */
export const ARCHIVE_BYTES = 20 * 1024 * 1024;
export const ARCHIVE_RAW_BYTES = 100 * 1024 * 1024;
/** Служебных частей в архиве — не считая вложений человека. */
export const ARCHIVE_PARTS = 32;

/** Пустой отчёт об источнике, которого нет. Чтобы «нет» тоже было записано. */
export function missingSource(source: SourceName, reason: string): SourceReport {
  return { source, state: 'unavailable', reason, events: 0, bytes: 0 };
}

/**
 * Итог по описи: полон пакет или нет.
 *
 * Достаточно одного усечённого или сломанного источника, чтобы пакет считался
 * неполным. Отсутствие оболочки в браузере неполнотой НЕ считается: источника
 * там нет по устройству программы, и красить это в жёлтое — значит приучить
 * разбирающего не смотреть на цвет.
 */
export function bundleStateOf(sources: SourceReport[]): BundleState {
  if (!sources.length) return 'FAILED';
  if (sources.every((s) => s.state === 'error')) return 'FAILED';
  const flawed = sources.some((s) => s.state === 'truncated' || s.state === 'error' || s.state === 'expired');
  return flawed ? 'PARTIAL' : 'READY';
}
