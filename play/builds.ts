/**
 * Сборки игр: опись, проверка и состояние установки.
 *
 * Общий модуль: одну и ту же опись читают трое — сервер (когда публикует),
 * оболочка (когда ставит) и окно (когда рисует кнопку). Разъехавшись, они
 * дали бы худший из возможных видов ошибки: сервер считает сборку целой,
 * оболочка — испорченной, а человек видит кнопку «Восстановить», которая
 * ничего не чинит.
 *
 * Формат описи выбран без архивов намеренно. Архив — это ещё один разборщик
 * форматов на пути к тому, чтобы положить файлы на диск; он ломается на чужих
 * кодировках имён, на длинных путях Windows и на прерванной закачке целиком, а
 * не по файлу. Опись перечисляет файлы поимённо, каждый со своим размером и
 * отпечатком: закачка возобновляется по файлу, проверка идёт по файлу, и
 * повреждение видно точечно.
 *
 * Здесь только правила: ни файловой системы, ни сети, ни React (модуль общий,
 * см. scripts/test-architecture.ts). Всё, что трогает диск, живёт в
 * `electron/games.ts`.
 */

/** Что с игрой на этой машине. Общая ось для оболочки и окна. */
export type InstallState =
  /** Сборки нет вовсе: публиковать ещё нечего */
  | 'unavailable'
  /** Не установлена */
  | 'absent'
  /** Качается */
  | 'downloading'
  /** Закачка остановлена человеком */
  | 'paused'
  /** Установлена, но версия старее опубликованной */
  | 'outdated'
  /** Установлена и цела */
  | 'ready'
  /** Установлена, но файлы не сходятся с описью */
  | 'broken';

/** Один файл сборки: куда лечь, сколько весить и чем себя подтвердить. */
export interface BuildFile {
  /** Путь внутри папки игры, всегда через косую черту */
  path: string;
  size: number;
  /** SHA-256 содержимого, шестнадцатеричными строчными */
  sha256: string;
  /** Откуда взять. Относительный адрес разрешается от адреса сборки */
  url: string;
}

/** Опись сборки: то, что подписывает издатель и проверяет оболочка. */
export interface BuildManifest {
  gameId: string;
  version: string;
  /** Что запускать: путь из числа перечисленных в `files` */
  exe: string;
  files: BuildFile[];
  /** Подпись ed25519 по каноническому тексту описи, base64url */
  signature?: string;
}

/** Предел на одну сборку: не правило вкуса, а защита от «скачаем терабайт». */
export const MAX_BUILD_BYTES = 8 * 1024 * 1024 * 1024;
/** И на один файл внутри неё */
export const MAX_FILE_BYTES = 4 * 1024 * 1024 * 1024;
/** Сколько файлов может быть в сборке */
export const MAX_BUILD_FILES = 20000;

/**
 * Безопасное ли имя внутри сборки.
 *
 * Это главная проверка всего модуля. Опись приходит снаружи, а по ней пишутся
 * файлы: имя `..\..\Windows\System32\drivers\etc\hosts` в описи — это не
 * «некрасивый путь», это чужая программа, переписывающая систему руками нашей.
 *
 * Поэтому разрешено мало и явно: части из букв, цифр, точки, дефиса,
 * подчёркивания и пробела, разделённые косой чертой. Всё остальное — отказ, и
 * отказ называется словами.
 */
export function pathProblem(name: string): string {
  const raw = String(name || '');
  if (!raw) return 'пустое имя файла';
  if (raw.length > 240) return 'слишком длинное имя файла';
  if (raw.includes('\\')) return 'обратная косая черта в имени';
  if (raw.startsWith('/')) return 'путь от корня диска';
  if (/^[a-zA-Z]:/.test(raw)) return 'путь с буквой диска';
  // Управляющие знаки и двоеточие ломают Windows, а не только нас
  if (/[\u0000-\u001f:*?"<>|]/.test(raw)) return 'недопустимый знак в имени';
  const parts = raw.split('/');
  for (const part of parts) {
    if (!part) return 'пустая часть пути';
    if (part === '.' || part === '..') return 'переход по дереву вверх';
    if (part.endsWith('.') || part.endsWith(' ')) return 'имя кончается точкой или пробелом';
    if (!/^[A-Za-z0-9._\- ]+$/.test(part)) return 'недопустимый знак в имени';
  }
  if (parts.length > 24) return 'слишком глубокая вложенность';
  return '';
}

/** Годится ли строка как отпечаток SHA-256 */
const isSha = (v: unknown): boolean => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);

/** Годится ли строка как номер версии: «1.7.0», «1.7.0-rc2» */
export const isVersion = (v: unknown): boolean =>
  typeof v === 'string' && /^[0-9]+(\.[0-9]+){0,3}(-[0-9A-Za-z.]+)?$/.test(v);

export interface ParsedManifest {
  manifest: BuildManifest | null;
  /** Почему не принято — человеческими словами, для журнала и для экрана */
  problem: string;
}

/**
 * Разобрать опись.
 *
 * Отказ здесь всегда лучше догадки: половина принятой описи — это половина
 * установленной игры, а её не отличить от целой ничем, кроме запуска.
 */
export function parseManifest(input: unknown): ParsedManifest {
  const bad = (problem: string): ParsedManifest => ({ manifest: null, problem });
  let raw: any = input;
  if (typeof input === 'string') {
    try { raw = JSON.parse(input); } catch (_) { return bad('опись не разбирается как JSON'); }
  }
  if (!raw || typeof raw !== 'object') return bad('опись пуста');
  if (!raw.gameId || typeof raw.gameId !== 'string') return bad('в описи не названа игра');
  if (!isVersion(raw.version)) return bad('в описи нет внятного номера версии');
  if (!Array.isArray(raw.files) || !raw.files.length) return bad('в описи нет файлов');
  if (raw.files.length > MAX_BUILD_FILES) return bad('в описи слишком много файлов');

  const files: BuildFile[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const f of raw.files) {
    const problem = pathProblem(f?.path);
    if (problem) return bad(`недопустимый путь в описи (${problem})`);
    if (seen.has(f.path)) return bad(`файл назван дважды: ${f.path}`);
    seen.add(f.path);
    if (!isSha(f?.sha256)) return bad(`нет отпечатка у файла ${f.path}`);
    const size = Number(f?.size);
    if (!Number.isFinite(size) || size < 0 || size > MAX_FILE_BYTES) return bad(`неверный размер у файла ${f.path}`);
    if (typeof f?.url !== 'string' || !f.url) return bad(`нет адреса у файла ${f.path}`);
    total += size;
    files.push({ path: f.path, size, sha256: String(f.sha256).toLowerCase(), url: String(f.url) });
  }
  if (total > MAX_BUILD_BYTES) return bad('сборка больше допустимого размера');

  const exe = String(raw.exe || '');
  if (!files.some((f) => f.path === exe)) return bad('запускаемый файл не перечислен в описи');

  return {
    manifest: {
      gameId: String(raw.gameId),
      version: String(raw.version),
      exe,
      files,
      signature: typeof raw.signature === 'string' ? raw.signature : undefined,
    },
    problem: '',
  };
}

/**
 * Канонический текст описи — то, что подписывают и проверяют.
 *
 * Подписывать JSON как есть нельзя: порядок ключей, пробелы и порядок файлов у
 * двух программ разойдутся, и верная подпись однажды не сойдётся без всякой
 * подмены. Текст строится по правилу и сортируется, поэтому у сервера и
 * оболочки он получается побайтово одинаковым.
 *
 * Сама подпись в текст не входит — иначе её пришлось бы знать, чтобы посчитать.
 */
export function canonicalManifest(m: BuildManifest): string {
  const lines = [
    `game\t${m.gameId}`,
    `version\t${m.version}`,
    `exe\t${m.exe}`,
    ...[...m.files]
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map((f) => `file\t${f.path}\t${f.size}\t${f.sha256}`),
  ];
  return lines.join('\n') + '\n';
}

/** Сравнение версий по числам, а не по строкам: «1.10» новее «1.9». */
export function compareVersions(a: string, b: string): number {
  const nums = (v: string) => String(v || '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const x = nums(a);
  const y = nums(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  // Предвыпуск старее выпуска с тем же номером: «1.2.0-rc1» < «1.2.0»
  const pre = (v: string) => String(v || '').split('-')[1] || '';
  const pa = pre(a);
  const pb = pre(b);
  if (pa === pb) return 0;
  if (!pa) return 1;
  if (!pb) return -1;
  return pa < pb ? -1 : 1;
}

export interface InstallFacts {
  /** Что опубликовано на сервере; пусто — публиковать нечего */
  published: string;
  /** Что установлено на этой машине; пусто — ничего */
  installed: string;
  /** Идёт ли закачка прямо сейчас и не остановлена ли она человеком */
  downloading?: boolean;
  paused?: boolean;
  /** Сошлись ли файлы установленного с описью при последней сверке */
  intact?: boolean;
}

/**
 * Состояние игры на машине по фактам.
 *
 * Порядок важнее списка, как и у главной кнопки: сначала то, что отменяет всё
 * остальное. Испорченные файлы важнее устаревшей версии — обновлять поверх
 * сломанного бессмысленно; идущая закачка важнее и того и другого.
 */
export function installState(facts: InstallFacts): InstallState {
  if (facts.paused) return 'paused';
  if (facts.downloading) return 'downloading';
  if (!facts.installed) return facts.published ? 'absent' : 'unavailable';
  if (facts.intact === false) return 'broken';
  if (!facts.published) return 'ready';
  return compareVersions(facts.installed, facts.published) < 0 ? 'outdated' : 'ready';
}

/**
 * Доводы запуска игры.
 *
 * Билет уходит в доводах, а не в переменной окружения: переменные наследуются
 * дочерними процессами, и одноразовый пропуск расползся бы по всему, что игра
 * запустит. Отдельной функцией — чтобы разбор на стороне игры писался по тому
 * же списку.
 */
export const LAUNCH_SERVER = '--flux-server';
export const LAUNCH_TICKET = '--flux-ticket';
export const LAUNCH_SESSION = '--flux-session';

export function launchArgs(p: { address: string; ticket: string; sessionId: string }): string[] {
  return [
    LAUNCH_SERVER, String(p.address || ''),
    LAUNCH_TICKET, String(p.ticket || ''),
    LAUNCH_SESSION, String(p.sessionId || ''),
  ];
}
