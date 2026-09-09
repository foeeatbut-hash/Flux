/**
 * Что записывать, а что свернуть.
 *
 * Подробность стоит денег дважды: местом на диске и временем главного потока.
 * Поэтому режима два. Обычный — всё, что говорит о поломке или о длительности:
 * завершения запросов, операции базы, ошибки, паузы интерфейса. Подробный
 * включается на минуту руками и добавляет начала участков, события сокета и
 * команды движка.
 *
 * Отдельная забота — повторы. Опрос уведомлений идёт у каждого окна раз в
 * минуту, и построчно он не нужен никому: одна строка на пятисекундное окно
 * говорит то же самое.
 *
 * Модуль чистый: ни файлов, ни таймеров — только решения. Поэтому его и
 * получается проверить без диска.
 */

import type { EventName } from './contracts';

/** Событие, которое в обычном режиме не пишется. */
const DETAILED_ONLY = new Set<string>([
  'fetch.start', 'http.start',
  'socket.receive', 'socket.send', 'socket.ack',
  'ui.click', 'ui.event', 'resource.end',
  // Снимок документа берётся автосохранением каждые 2,5 секунды — в обычном
  // режиме это тысяча с лишним строк в час на один открытый документ, и все
  // одинаковые. Что документ сохранялся, видно по office.save
  'office.snapshot',
]);

/** Событие, которое всегда считается поломкой, даже без поля outcome. */
const ALWAYS_ERROR = new Set<string>([
  'fetch.error', 'socket.error', 'log.error', 'renderer.error', 'renderer.rejection',
  'process.uncaught', 'renderer.gone', 'child.gone', 'window.load-error',
]);

export type Data = Record<string, string | number | boolean>;

/** Поломка ли это. От ответа зависит, из какого запаса берётся место. */
export function isFailure(event: string, data: Data): boolean {
  if (ALWAYS_ERROR.has(event)) return true;
  if (data.outcome === 'error' || data.outcome === 'conflict') return true;
  if (data.ok === false) return true;
  // Ответ сервера 4xx/5xx — поломка; отменённый запрос ею не считается
  const status = Number(data.status);
  return Number.isFinite(status) && status >= 400;
}

/** Нужно ли писать это событие в нынешнем режиме. */
export function passesMode(event: string, data: Data, detailed: boolean): boolean {
  if (detailed) return true;
  if (isFailure(event, data)) return true;
  if (data.phase === 'start') return false;
  return !DETAILED_ONLY.has(event);
}

/**
 * Очередь с двумя потолками — по числу записей и по объёму.
 *
 * Оба нужны: тысяча коротких событий и десяток длинных занимают разное место,
 * а память ограничена именно объёмом. Вытесняется всегда самое старое, и
 * счётчик потерь растёт — «событий не было» и «события потеряны» для разбора
 * совершенно разные ответы.
 */
export class BoundedQueue {
  // Размер строки хранится рядом с ней: пересчитывать его при вытеснении
  // нечем — Buffer в окне не существует, а очередь одна и там, и на сервере
  private items: Array<{ line: string; size: number }> = [];
  private bytes = 0;
  private lost = 0;

  constructor(private readonly maxItems: number, private readonly maxBytes: number) {}

  push(line: string, size: number): void {
    while (this.items.length >= this.maxItems || this.bytes + size > this.maxBytes) {
      const gone = this.items.shift();
      if (gone === undefined) break;
      this.bytes -= gone.size;
      this.lost++;
    }
    this.items.push({ line, size });
    this.bytes += size;
  }

  take(): { batch: string; count: number } {
    const count = this.items.length;
    const batch = this.items.map((i) => i.line).join('');
    this.items = [];
    this.bytes = 0;
    return { batch, count };
  }

  get length(): number { return this.items.length; }
  get size(): number { return this.bytes; }
  get dropped(): number { return this.lost; }
  countDropped(n: number): void { this.lost += n; }
}

/**
 * Разбор пачки, присланной окном через мост.
 *
 * Окно — не доверенный источник: в него может прилететь что угодно, включая
 * пачку на миллион записей. Поэтому здесь не «почистим, что сможем», а
 * «возьмём только то, что имеет правильную форму», и не больше объявленного
 * числа. Имена событий тут не проверяются: их отсеет словарь при записи.
 */
export function validBatch(batch: unknown, max: number): Array<{ event: string; data: Record<string, unknown> }> {
  if (!Array.isArray(batch) || batch.length > max) return [];
  const out: Array<{ event: string; data: Record<string, unknown> }> = [];
  for (const item of batch) {
    if (!item || typeof item !== 'object') continue;
    const { event, data } = item as { event?: unknown; data?: unknown };
    if (typeof event !== 'string' || !event || event.length > 40) continue;
    if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
    out.push({ event, data: data as Record<string, unknown> });
  }
  return out;
}

/** Сколько событий в секунду пропускать. Шторм не должен съесть диск. */
export class RateLimit {
  private windowStart = 0;
  private used = 0;

  constructor(private readonly perSecond: number) {}

  allow(now: number): boolean {
    if (now - this.windowStart >= 1000) { this.windowStart = now; this.used = 0; }
    if (this.used >= this.perSecond) return false;
    this.used++;
    return true;
  }
}

interface Repeat { name: string; route: string; status: string; repeats: number; totalMs: number; maxMs: number; since: number }

/**
 * Маршруты фонового опроса — единственные, чьи повторы сворачиваются.
 *
 * Список тот же, что уже перечислен в обёртке fetch (`src/config/env.ts`):
 * это опрос уведомлений и переписки, идущий у каждого окна сам по себе.
 *
 * Сворачивать всё подряд нельзя, и это выяснилось на живом прогоне: свёртка по
 * «маршрут + состояние» схлопывала обычную работу человека, и от шестидесяти
 * запросов в файле оставалось пять. Хуже того, у свёрнутых запросов пропадала
 * метка, а записи об операциях базы с этой меткой оставались — цепочка
 * рвалась ровно там, где её и надо читать.
 */
const POLL = /\/api\/(notifications|health|presence|chat\/(messages|group-messages|groups))/;

/**
 * Сворачивание повторов фонового опроса.
 *
 * Ключ — событие, маршрут и состояние. Поломки не сворачиваются никогда: у
 * каждой своя причина, и «пять раз что-то не вышло» разбору не помогает.
 */
export class RepeatFilter {
  private open = new Map<string, Repeat>();

  constructor(private readonly windowMs = 5000) {}

  /** true — писать строку как есть; false — событие ушло в свёртку. */
  accept(event: string, data: Data, now: number): boolean {
    if (isFailure(event, data)) return true;
    const route = typeof data.route === 'string' ? data.route : '';
    if (!route || !POLL.test(route)) return true;
    const key = `${event}|${route}|${data.status ?? ''}`;
    const seen = this.open.get(key);
    const ms = Number(data.durationMs);
    if (!seen) {
      this.open.set(key, {
        name: event, route, status: String(data.status ?? ''),
        repeats: 0, totalMs: 0, maxMs: 0, since: now,
      });
      return true; // первый в окне пишется целиком: по нему видно, что вообще было
    }
    seen.repeats++;
    if (Number.isFinite(ms)) { seen.totalMs += ms; seen.maxMs = Math.max(seen.maxMs, ms); }
    return false;
  }

  /** Свёртки, чьё окно закрылось. Пустые (без повторов) не выдаются. */
  drain(now: number, force = false): Array<{ event: EventName; data: Data }> {
    const out: Array<{ event: EventName; data: Data }> = [];
    for (const [key, r] of this.open) {
      if (!force && now - r.since < this.windowMs) continue;
      this.open.delete(key);
      if (r.repeats === 0) continue;
      out.push({
        event: 'agg.repeat',
        data: {
          name: r.name, route: r.route, status: r.status,
          repeats: r.repeats,
          totalMs: Math.round(r.totalMs * 100) / 100,
          maxMs: Math.round(r.maxMs * 100) / 100,
        },
      });
    }
    return out;
  }
}
