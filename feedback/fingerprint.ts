/**
 * Отпечаток технического дубля и близость по словам.
 *
 * Зачем отпечаток. Одна и та же поломка приходит от пятерых, каждый описывает
 * её своими словами, и обработчик разбирает пять карточек как пять разных
 * дел. Совпадение видно по технике, а не по тексту: раздел, версия, код
 * ошибки и три верхних кадра стека. Из кадров убраны пути установки и номера
 * строк — иначе один и тот же сбой у двух сотрудников даст разные отпечатки, а
 * после правки соседней строки в файле разойдётся и сам с собой.
 *
 * Отпечаток НИЧЕГО не объединяет сам. Он только предлагает обработчику
 * посмотреть: «похоже на ОБР-000123». Автоматическое склеивание карточек — это
 * потерянные обращения, когда догадка оказалась неверной.
 *
 * Идеи техники не имеют вовсе, поэтому сравниваются по нормализованным словам
 * заголовка. Никакой языковой модели: программа работает в закрытом контуре и
 * наружу не ходит — это решение владельца, а не ограничение.
 *
 * Модуль чистый: ни React, ни node:, ни express.
 */

import { sha256Hex } from './sha256';

/** Версия схемы отпечатка: изменится правило — старые отпечатки не совпадут. */
export const FINGERPRINT_VERSION = 1;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * Только мажор и минор версии.
 *
 * Заплаточная цифра меняется у каждого выпуска, и с ней отпечаток разошёлся бы
 * при первом же обновлении — то есть ровно тогда, когда дубли и приходят.
 */
export function majorMinor(version: unknown): string {
  const parts = String(version ?? '').trim().split('.');
  if (!parts[0]) return '';
  return `${parts[0]}.${parts[1] || '0'}`.replace(/[^0-9.]/g, '');
}

/**
 * Кадр стека без личного.
 *
 * Повторяет правило `normalizeFrame` из диагностики намеренно: тот модуль
 * тянет за собой словарь событий, а отпечаток считает и сервер, и окно, и
 * проверки. Правило одно и то же, и проверка сравнивает их между собой.
 */
export function frameKey(line: unknown): string {
  const at = String(line ?? '').trim().replace(/^at\s+/, '');
  if (!at) return '';
  const fn = at.split(' (')[0].trim();
  const where = (at.match(/\(?([^()\s/\\]+\.[a-z]+):\d+:\d+\)?/) || [])[1] || '';
  return `${fn.replace(UUID, '')} ${where}`.trim().replace(/\s+/g, ' ').slice(0, 80);
}

export interface FingerprintParts {
  appVersion?: string;
  sectionKey?: string;
  errorCode?: string;
  frames?: unknown[];
}

/**
 * Отпечаток технического дубля.
 *
 * Пустой ответ означает «считать не из чего»: без кода ошибки и без кадров
 * стека совпадение по одному разделу — это не дубль, а совпадение раздела.
 */
export function technicalFingerprint(parts: FingerprintParts): string {
  const frames = (parts.frames || []).map(frameKey).filter(Boolean).slice(0, 3);
  const code = String(parts.errorCode ?? '').trim().slice(0, 64);
  if (!code && !frames.length) return '';
  const line = [
    FINGERPRINT_VERSION,
    majorMinor(parts.appVersion),
    String(parts.sectionKey ?? '').trim().slice(0, 64),
    code,
    ...frames,
  ].join('|');
  return sha256Hex(new TextEncoder().encode(line));
}

// ── Близость идей ───────────────────────────────────────────────────────────

/** Слова, которые есть в каждом втором заголовке и ничего не различают. */
const STOP = new Set([
  'и', 'в', 'на', 'не', 'с', 'по', 'для', 'что', 'как', 'при', 'из', 'к', 'а',
  'или', 'же', 'то', 'бы', 'это', 'все', 'если', 'после', 'до', 'от', 'у',
  'программа', 'программе', 'flux', 'флукс', 'ошибка', 'проблема', 'надо', 'нужно',
]);

/**
 * Слова заголовка, приведённые к сравнимому виду.
 *
 * Окончания русских слов обрезаются грубо: у длинных слов остаётся начало без
 * последних четырёх букв. Это не морфология и точной не притворяется — задача
 * в том, чтобы «спецификация» и «спецификации» попали в одно ведро, а
 * «открывается» и «открываются» не разошлись из-за одной буквы в середине
 * окончания. Трёх букв на это не хватало: проверка нашла ровно этот случай.
 */
export function titleWords(title: unknown): string[] {
  const words = String(title ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .split(/[^0-9a-zа-я]+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
  const out: string[] = [];
  for (const word of words) {
    const stem = word.length > 6 ? word.slice(0, Math.max(4, word.length - 4)) : word;
    if (!out.includes(stem)) out.push(stem);
  }
  return out;
}

/**
 * Насколько заголовки похожи: 0 — ничего общего, 1 — те же слова.
 *
 * Мера Жаккара: доля общих слов среди всех. Она не понимает смысла, поэтому
 * порог намеренно высокий, а результат называется «кандидат», а не «дубль».
 */
export function titleCloseness(a: unknown, b: unknown): number {
  const first = titleWords(a);
  const second = titleWords(b);
  if (!first.length || !second.length) return 0;
  const common = first.filter((w) => second.includes(w)).length;
  const all = new Set([...first, ...second]).size;
  return all ? common / all : 0;
}

/** Ниже этого совпадение не показываем: шум мешает больше, чем помогает. */
export const CLOSE_ENOUGH = 0.5;

/**
 * Цепочка «дубль → основная карточка» не должна заворачиваться в кольцо.
 *
 * Кольцо здесь не теоретическое: A помечают дублем B, потом B — дублем A, и
 * любой обход карточек виснет. Глубина ограничена, потому что длинная цепочка
 * — это тоже ошибка разбора, а не устройство.
 */
export const MAX_DUPLICATE_CHAIN = 20;

export function checkDuplicateChain(
  sourceId: string, targetId: string, parentOf: (id: string) => string | null,
): { ok: boolean; error?: string } {
  if (!targetId) return { ok: false, error: 'Не указано, дублем чего считать' };
  if (sourceId === targetId) return { ok: false, error: 'Обращение не может быть дублем самого себя' };
  let at: string | null = targetId;
  const seen = new Set<string>([sourceId]);
  for (let step = 0; step < MAX_DUPLICATE_CHAIN; step++) {
    if (!at) return { ok: true };
    if (seen.has(at)) return { ok: false, error: 'Так получилось бы кольцо из дублей' };
    seen.add(at);
    at = parentOf(at);
  }
  return { ok: false, error: `Цепочка дублей длиннее ${MAX_DUPLICATE_CHAIN} звеньев` };
}
