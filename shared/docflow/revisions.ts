/**
 * Схема ревизий проекта и правила выпуска (docs/docflow-program.md, 5 и 7.1).
 *
 * Чистые функции для сервера и окна: какая ревизия следующая после выпущенной,
 * корректна ли дата выпуска, когда истекает срок ответа на возврат. Сервер
 * проверяет всё это сам; окно показывает те же причины отказа заранее.
 */

export interface DocflowRevisionRules {
  /** Буквенные ревизии по порядку, по одному символу: «ABCDEFGHJKLMNPQRSTUVWXYZ». */
  letters: string;
  /** С какого числа начинаются цифровые ревизии после буквенных. */
  firstDigit: number;
}
export const DEFAULT_REVISION_RULES: DocflowRevisionRules = { letters: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', firstDigit: 0 };

/** Любой ввод приводится к рабочим правилам: буквы без повторов и пробелов, число в разумных пределах. */
export function normalizeRevisionRules(raw: any): DocflowRevisionRules {
  const source = raw && typeof raw === 'object' ? raw : {};
  const seen = new Set<string>();
  for (const ch of String(typeof source.letters === 'string' ? source.letters : '').toUpperCase()) if (/^[A-ZА-ЯЁ]$/u.test(ch)) seen.add(ch);
  const first = Number(source.firstDigit);
  return {
    letters: seen.size ? [...seen].slice(0, 40).join('') : DEFAULT_REVISION_RULES.letters,
    firstDigit: Number.isInteger(first) && first >= 0 && first <= 99 ? first : DEFAULT_REVISION_RULES.firstDigit,
  };
}

export type RevisionKind = 'letter' | 'digit';
export const kindOfRevision = (revision: string): RevisionKind | null => (/^\d{1,3}$/.test(revision) ? 'digit' : /^[A-ZА-ЯЁ]$/u.test(revision) ? 'letter' : null);

/**
 * Какая ревизия должна идти после последней выпущенной. Пустая строка в
 * ответе — выпуска ещё не было и подойдёт любая ревизия нужного вида (реестр
 * мог быть импортирован уже с ревизией C). `null` — после этой ревизии такой
 * вид выпуска невозможен (буквенная после цифровой, буквы кончились).
 */
export function expectedRevision(rules: DocflowRevisionRules, last: string | null, kind: RevisionKind): string | null {
  const previous = (last || '').toUpperCase();
  if (!previous) return '';
  const lastKind = kindOfRevision(previous);
  if (kind === 'letter') {
    if (lastKind !== 'letter') return null;
    const index = rules.letters.indexOf(previous);
    return index >= 0 && index + 1 < rules.letters.length ? rules.letters[index + 1] : null;
  }
  if (lastKind === 'letter') return String(rules.firstDigit);
  return lastKind === 'digit' ? String(Number(previous) + 1) : null;
}

/** Почему ревизия не подходит для выпуска; null — подходит. */
export function revisionProblem(rules: DocflowRevisionRules, last: string | null, candidate: string, kind: RevisionKind): string | null {
  const wanted = candidate.toUpperCase();
  if (kindOfRevision(wanted) !== kind) return `Причина выпуска требует ${kind === 'letter' ? 'буквенную' : 'цифровую'} ревизию, а у строки «${candidate || '—'}»`;
  if (kind === 'letter' && !rules.letters.includes(wanted)) return `Ревизии «${candidate}» нет в схеме проекта`;
  const next = expectedRevision(rules, last, kind);
  if (next === null) return `После ревизии ${last} такой выпуск невозможен по схеме проекта`;
  if (next && next !== wanted) return `После ревизии ${last} следующей должна быть ${next}, а у строки ${candidate}`;
  return null;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** Календарная дата «ГГГГ-ММ-ДД» существует на самом деле (31 февраля — нет). */
export function validDay(day: unknown): day is string {
  if (typeof day !== 'string') return false;
  const m = DATE.exec(day);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  return y >= 2000 && y <= 2100 && probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d;
}

/** Календарный день хранится полуднем UTC: в любом часовом поясе он показывается тем же числом. */
export const dayToInstant = (day: string): Date => new Date(`${day}T12:00:00.000Z`);
export const instantToDay = (value: string | Date | null | undefined): string => (value ? new Date(value).toISOString().slice(0, 10) : '');

/** Прибавить календарные дни к календарному дню — арифметика по UTC, без перехода на летнее время. */
export function addCalendarDays(day: string, days: number): string {
  const base = Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
  return new Date(base + Math.trunc(days) * 86_400_000).toISOString().slice(0, 10);
}

export const validTimeZone = (zone: unknown): zone is string => {
  if (typeof zone !== 'string' || !zone || zone.length > 80) return false;
  try { new Intl.DateTimeFormat('ru-RU', { timeZone: zone }); return true; } catch { return false; }
};

/** Сдвиг пояса от UTC в миллисекундах в данный момент. */
function zoneOffset(zone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(at);
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second')) - Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * Последняя секунда календарного дня в часовом поясе пользователя. Срок
 * «до такого-то числа» истекает в конце этого дня у него на часах, а не по
 * серверному времени и не через столько-то миллисекунд после получения.
 */
export function endOfDay(day: string, zone: string): Date {
  const wall = Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)), 23, 59, 59);
  let guess = new Date(wall - zoneOffset(zone, new Date(wall)));
  guess = new Date(wall - zoneOffset(zone, guess)); // второй проход: сдвиг мог измениться между догадкой и итогом
  return guess;
}

/** Срок ответа: дата получения + календарные дни; истекает в конце последнего дня. */
export const responseDeadline = (receivedDay: string, days: number, zone: string): Date => endOfDay(addCalendarDays(receivedDay, days), zone);
