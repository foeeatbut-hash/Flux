/**
 * Приведение значения к безопасному виду — единственный путь, которым данные
 * попадают в запись.
 *
 * Здесь нет «почистим на всякий случай»: `cleanFields` берёт словарь события
 * из `contracts.ts` и оставляет ровно объявленные поля, приводя каждое по его
 * виду. Поле, которого в словаре нет, отбрасывается молча — сериализовать
 * неизвестное «для подробности» нельзя, именно так журналы и набирают чужие
 * данные.
 *
 * Модуль общий и чистый: ни `node:`, ни React, ни express. Его тянет и окно,
 * и сервер, и оболочка.
 */

import { specOf, type FieldKind, type EventName, type SafeFields } from './contracts';

// ── Идентификаторы ──────────────────────────────────────────────────────────

/**
 * randomUUID недоступен в обычной HTTP-сети без защищённого контекста, а отдел
 * работает именно так: http://сервер:3000. getRandomValues доступен всегда.
 */
export function newTraceId(): string {
  const bytes = new Uint8Array(16);
  const source: any = (globalThis as any).crypto;
  if (source && typeof source.getRandomValues === 'function') source.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Обезличивание строк ─────────────────────────────────────────────────────

/**
 * Убрать из строки то, что не должно оказаться в файле.
 *
 * Порядок важен. Сначала раскрываем percent-кодирование: пароль в адресе
 * приезжает как `password%3Dсекрет`, и правило, написанное по знаку «=»,
 * такую строку не видит. Раскрываем один раз — двойное раскрытие само по себе
 * способно склеить безобидную строку в похожую на секрет.
 */
export function redact(value: string): string {
  let text = String(value);
  try {
    const opened = decodeURIComponent(text.replace(/\+/g, ' '));
    if (opened.length <= text.length * 2) text = opened;
  } catch (_) { /* некорректная последовательность — работаем с исходной строкой */ }
  return text
    // Строка подключения: mysql://пользователь:пароль@сервер
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[учётные данные]@')
    // Заголовок авторизации
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/=._-]+/gi, '$1 [секрет]')
    // Токен веб-подписи: три части через точку, начинается с eyJ
    .replace(/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, '[токен]')
    // Пара «ключ = значение» для всего, что похоже на тайну
    .replace(
      /(["']?(?:password|passwd|pwd|pass|пароль|token|secret|authorization|cookie|api[_-]?key|connection[_-]?string)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;&}]+)/gi,
      '$1[секрет]',
    )
    // Личная папка: имя сотрудника в пути — такие же данные, как его логин
    .replace(/([A-Za-z]:\\Users\\)[^\\\s]+/g, '$1[пользователь]')
    .replace(/(\/(?:home|Users)\/)[^/\s]+/g, '$1[пользователь]')
    // Поисковая строка и параметры: сам путь нужен, значения — нет
    .replace(/(https?:\/\/[^\s?#]+)\?[^\s#]*/gi, '$1?[параметры]')
    .slice(0, 512);
}

// ── Имена маршрутов ─────────────────────────────────────────────────────────

/**
 * Части пути после `/api/<раздел>`, которые остаются как есть.
 *
 * Всё, чего здесь нет, превращается в `:id`. Правило намеренно жёсткое: до
 * него имя маршрута считалось «словом из букв», и `/api/projects/секретный`
 * проходил как название маршрута — то есть название проекта уезжало в файл.
 * Потерять группировку не страшно, отдать имя документа — страшно.
 */
const SUB_PARTS = new Set([
  'raw', 'done', 'chunk', 'chunks', 'complete', 'read', 'unread', 'meta', 'limits',
  'comments', 'events', 'transition', 'assign', 'priority', 'duplicate', 'attachments',
  'diagnostics', 'summary', 'export', 'import', 'upload', 'download', 'status',
  'trash', 'folders', 'files', 'tree', 'messages', 'groups', 'group-messages',
  'by-request', 'sync-schema', 'versions', 'docs', 'import-file', 'save', 'restore',
]);

const WORD = /^[a-z][a-z0-9-]{0,29}$/;

/**
 * Путь, приведённый к шаблону. На сервере предпочтительнее отдавать сюда
 * настоящий шаблон Express (`req.route.path`) — он точен и не требует
 * поддержки словаря; этот разбор нужен для клиента и для запросов, которые
 * ни одному маршруту не достались.
 */
export function routeName(value: string): string {
  let path: string;
  try {
    path = new URL(value, 'http://flux.local').pathname;
  } catch (_) {
    return '[неразборчивый адрес]';
  }
  try {
    path = decodeURIComponent(path);
  } catch (_) { /* оставляем как есть: percent-последовательность битая */ }
  if (path.startsWith('/api/')) {
    const parts = path.split('/').slice(2).filter(Boolean);
    const head = parts[0] && WORD.test(parts[0]) ? parts[0] : ':id';
    const tail = parts.slice(1).map((p) => (SUB_PARTS.has(p) ? p : ':id'));
    return ['/api', head, ...tail].join('/');
  }
  // Вне API имя файла и папки — такие же данные проекта, как содержимое
  if (path === '/' || path === '') return '/';
  const first = path.split('/').filter(Boolean)[0] || '';
  return WORD.test(first) ? `/${first}/[ресурс]` : '/[ресурс]';
}

// ── Стек и ошибки ───────────────────────────────────────────────────────────

/**
 * Кадр стека без пути, номера строки и случайных идентификаторов.
 *
 * Номер строки убирается не ради краткости: он меняется от версии к версии, и
 * отпечаток дубля по нему перестал бы совпадать через одну правку файла. Путь
 * убирается потому, что содержит имя сотрудника в личной папке.
 */
export function normalizeFrame(line: unknown): string {
  const at = String(line ?? '').trim().replace(/^at\s+/, '');
  if (!at) return '';
  const fn = at.split(' (')[0].trim();
  // Из пути остаётся только имя файла: остальное — личная папка сотрудника и
  // место установки, они у каждого свои и разбору не помогают
  const where = (at.match(/\(?([^()\s/\\]+\.[a-z]+):\d+:\d+\)?/) || [])[1] || '';
  return `${fn.replace(UUID, '')} ${where}`.trim().replace(/\s+/g, ' ').slice(0, 80);
}

export function safeFrames(stack: unknown, limit = 3): string[] {
  if (typeof stack !== 'string') return [];
  const out: string[] = [];
  for (const line of stack.split('\n').slice(1)) {
    if (!line.trim().startsWith('at ')) continue;
    const name = normalizeFrame(line);
    if (name) out.push(name);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Ошибка, из которой можно записать только имя и код.
 *
 * Сообщение не берётся никогда: драйвер базы кладёт в него SQL со значениями,
 * а разбор бланка — кусок документа.
 */
export function safeError(error: unknown): { error: string; code: string; frame1?: string; frame2?: string; frame3?: string } {
  const e = error as any;
  const frames = safeFrames(e?.stack);
  return {
    error: safeName(e?.name || (typeof error === 'string' ? 'Error' : e?.constructor?.name) || 'Error'),
    code: safeCode(e?.code ?? ''),
    ...(frames[0] ? { frame1: frames[0] } : {}),
    ...(frames[1] ? { frame2: frames[1] } : {}),
    ...(frames[2] ? { frame3: frames[2] } : {}),
  };
}

// ── Приведение по виду поля ─────────────────────────────────────────────────

/**
 * Короткое имя из нашего словаря: метод, канал, событие сокета.
 *
 * Обезличивание идёт ДО отбрасывания лишних знаков. Имя ошибки обычно
 * «TypeError», но чужая библиотека кладёт в него что угодно: `Error:
 * password="abc"` после одного лишь отбрасывания знаков превратилось бы в
 * `Errorpasswordabc` — то есть пароль остался бы в файле буквами.
 */
/** Строка, за которую не цепляется ни одно правило обезличивания. */
const PLAIN = /^[A-Za-z0-9_-]{1,48}$/;

export function safeName(value: unknown): string {
  const text = String(value ?? '');
  // Имена вроде `GET`, `findMany`, `constructor:saved` встречаются на каждом
  // запросе, и гонять их через семь правил и раскрытие percent-кодирования
  // незачем: без двоеточия, косой черты, пробела, знака равенства и точки
  // изменить в такой строке нечего. Это ускорение, а не послабление
  if (PLAIN.test(text)) return text;
  return redact(text).replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 48);
}

/** Код состояния или ошибки: цифры и заглавные, как P2002 или 409. */
function safeCode(value: unknown): string {
  const text = String(value ?? '');
  if (PLAIN.test(text)) return text.slice(0, 24);
  return redact(text).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24);
}

function finiteNumber(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function byKind(kind: FieldKind, value: unknown): string | number | boolean | null {
  switch (kind) {
    case 'id': {
      const text = String(value ?? '');
      return UUID.test(text) ? text : text.replace(/[^A-Za-z0-9-]/g, '').slice(0, 64) || null;
    }
    case 'name': return safeName(value) || null;
    case 'code': return safeCode(value) || null;
    case 'route': return routeName(String(value ?? ''));
    // Шаблон приходит из нашего кода, а не от человека: словарь к нему не
    // применяется — он бы съел статические части пути
    case 'pattern': return String(value ?? '').replace(/[^A-Za-z0-9/:_.-]/g, '').slice(0, 120) || null;
    // Через ту же нормализацию, что и разбор стека: иначе кадр, поданный
    // полем напрямую, сохранял бы путь установки и номер строки
    case 'frame': return normalizeFrame(redact(String(value ?? ''))) || null;
    case 'ms': {
      const n = finiteNumber(value);
      // Округляем до сотых: наносекунды в отчёте только мешают читать
      return n === null ? null : Math.round(n * 100) / 100;
    }
    case 'bytes':
    case 'chars':
    case 'count': {
      const n = finiteNumber(value);
      return n === null ? null : Math.round(n);
    }
    case 'flag': return typeof value === 'boolean' ? value : null;
    case 'phase': return value === 'start' || value === 'end' ? value : null;
    case 'outcome':
      return value === 'ok' || value === 'error' || value === 'cancelled' || value === 'conflict' || value === 'skipped'
        ? value : null;
    default: return null;
  }
}

/**
 * Оставить от переданных полей только объявленные и привести их по виду.
 *
 * Возвращает `null`, если события нет в словаре: запись с незнакомым именем не
 * делается вовсе. Так новое событие невозможно завести, не объявив его поля.
 */
export function cleanFields(event: string, fields: Record<string, unknown> | undefined): Record<string, string | number | boolean> | null {
  const spec = specOf(event);
  if (!spec) return null;
  const out: Record<string, string | number | boolean> = {};
  if (!fields) return out;
  for (const [key, kind] of Object.entries(spec)) {
    if (!(key in fields)) continue;
    const value = byKind(kind, (fields as Record<string, unknown>)[key]);
    if (value !== null && value !== '') out[key] = value;
  }
  return out;
}

/** Типизированный вход: имя события известно, поля проверены на этапе сборки. */
export type Typed<E extends EventName> = SafeFields<E>;
