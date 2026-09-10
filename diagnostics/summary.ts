/**
 * Разбор записанного: что было медленным, что ломалось, чего не хватает.
 *
 * Сырые файлы читать человеку незачем — их десятки тысяч строк. Здесь из них
 * собирается короткий ответ на три вопроса: где время, где ошибки и чего в
 * записи нет.
 *
 * Три правила, без которых сводка начинает врать.
 *
 * Первое: обрезанный хвост объявляется. Если события вытеснялись или запись
 * отказывала, счёт «сколько раз это случилось» занижен, и молчать об этом
 * нельзя — по такой сводке принимают решения.
 *
 * Второе: операции базы внутри одного запроса не складываются подряд. Две
 * выборки, шедшие одновременно, дают в сумме больше, чем длился сам запрос, и
 * «база заняла 900 мс из 500» выглядит как ошибка счёта. Считается объединение
 * отрезков по смещению от начала запроса.
 *
 * Третье: «медленно, потому что база» не утверждается по совпадению времени.
 * Сводка говорит, сколько миллисекунд цепочки заняла база, — вывод делает
 * человек.
 *
 * Модуль чистый: ни файлов, ни таймеров. Поэтому его и получается проверить.
 */

import type { DiagnosticEvent } from './contracts';

/** Выше этого числа замеров точные процентили не считаем — говорим об этом. */
const EXACT_LIMIT = 10000;

export interface Slow {
  name: string;
  count: number;
  p50: number;
  p95: number;
  max: number;
  /** Точные процентили или оценка по усечённой выборке. */
  exact: boolean;
}

export interface Chain {
  trace: string;
  route: string;
  totalMs: number;
  /** Объединение отрезков работы базы, а не их сумма. */
  dbMs: number;
  dbOps: number;
}

export interface Summary {
  sessions: number;
  sources: string[];
  events: number;
  from: string;
  to: string;
  /** Событий потеряно (вытеснено очередью или не записано). */
  dropped: number;
  /** Хвост неполон: часть событий до файла не доехала. */
  truncated: boolean;
  slowRoutes: Slow[];
  slowDb: Slow[];
  slowOffice: Slow[];
  errors: Array<{ code: string; count: number }>;
  stalls: { count: number; maxMs: number; totalMs: number };
  memory: { maxRssBytes: number; maxHeapBytes: number };
  /** Начатые, но не завершившиеся операции. */
  unfinished: number;
  chains: Chain[];
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);

/** Процентиль по отсортированному массиву, линейной интерполяцией. */
function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * p;
  const low = Math.floor(pos);
  const high = Math.ceil(pos);
  if (low === high) return round(sorted[low]);
  return round(sorted[low] + (sorted[high] - sorted[low]) * (pos - low));
}

const round = (n: number) => Math.round(n * 100) / 100;

function slowest(groups: Map<string, number[]>, take: number): Slow[] {
  const out: Slow[] = [];
  for (const [name, values] of groups) {
    // Выше предела берём равномерную выборку: сортировка миллиона чисел ради
    // одной строки отчёта не окупается, а признак «не точно» обязателен
    const exact = values.length <= EXACT_LIMIT;
    const sample = exact ? values.slice() : everyNth(values, Math.ceil(values.length / EXACT_LIMIT));
    sample.sort((a, b) => a - b);
    out.push({
      name,
      count: values.length,
      p50: percentile(sample, 0.5),
      p95: percentile(sample, 0.95),
      max: round(Math.max(...values)),
      exact,
    });
  }
  // Сортируем по p95: один случайный выброс не должен вытеснять то, что
  // медленно постоянно
  out.sort((a, b) => b.p95 - a.p95 || b.count - a.count);
  return out.slice(0, take);
}

function everyNth(values: number[], step: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < values.length; i += step) out.push(values[i]);
  return out;
}

function add(groups: Map<string, number[]>, key: string, value: number): void {
  if (!Number.isFinite(value)) return;
  const list = groups.get(key);
  if (list) list.push(value);
  else groups.set(key, [value]);
}

/** Объединение отрезков: параллельные операции не складываются дважды. */
function unionMs(spans: Array<[number, number]>): number {
  if (!spans.length) return 0;
  const sorted = spans.slice().sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [from, to] = sorted[0];
  for (const [start, end] of sorted.slice(1)) {
    if (start > to) { total += to - from; from = start; to = end; }
    else if (end > to) to = end;
  }
  return round(total + (to - from));
}

export function summarize(events: DiagnosticEvent[], topN = 8): Summary {
  const sessions = new Set<string>();
  const sources = new Set<string>();
  const routes = new Map<string, number[]>();
  const db = new Map<string, number[]>();
  const office = new Map<string, number[]>();
  const errors = new Map<string, number>();
  const started = new Set<string>();
  const finished = new Set<string>();
  const chainSpans = new Map<string, Array<[number, number]>>();
  const chainInfo = new Map<string, { route: string; totalMs: number }>();

  let dropped = 0;
  let truncated = false;
  let stallCount = 0;
  let stallMax = 0;
  let stallTotal = 0;
  let maxRss = 0;
  let maxHeap = 0;
  let from = '';
  let to = '';

  for (const e of events) {
    if (!e || typeof e.event !== 'string') continue;
    sessions.add(e.session);
    sources.add(e.source);
    if (!from || e.time < from) from = e.time;
    if (!to || e.time > to) to = e.time;
    const d = (e.data || {}) as Record<string, unknown>;
    const ms = num(d.durationMs);
    const trace = typeof d.trace === 'string' ? d.trace : '';

    switch (e.event) {
      case 'http.end': {
        const route = String(d.route || '—');
        add(routes, route, ms);
        if (trace) chainInfo.set(trace, { route, totalMs: round(ms) });
        break;
      }
      case 'fetch.headers':
        add(routes, `окно ${String(d.route || '—')}`, ms);
        break;
      case 'db.op': {
        add(db, `${String(d.model || 'raw')}.${String(d.operation || '?')}`, ms);
        const startMs = num(d.startMs);
        if (trace && Number.isFinite(startMs) && Number.isFinite(ms)) {
          const list = chainSpans.get(trace) || [];
          list.push([startMs, startMs + ms]);
          chainSpans.set(trace, list);
        }
        break;
      }
      case 'office.init':
      case 'office.save':
      case 'office.export':
      case 'office.import':
      case 'office.dispose':
        add(office, e.event, ms);
        break;
      case 'ui.stall':
        stallCount++;
        stallTotal += Number.isFinite(ms) ? ms : 0;
        if (ms > stallMax) stallMax = ms;
        break;
      case 'process.sample':
        maxRss = Math.max(maxRss, num(d.rssBytes) || 0);
        maxHeap = Math.max(maxHeap, num(d.heapUsedBytes) || 0);
        break;
      case 'renderer.sample':
        maxHeap = Math.max(maxHeap, num(d.heapUsedBytes) || 0);
        dropped = Math.max(dropped, num(d.dropped) || 0);
        break;
      case 'writer.state':
        dropped = Math.max(dropped, num(d.dropped) || 0);
        if ((num(d.dropped) || 0) > 0 || (num(d.failures) || 0) > 0) truncated = true;
        break;
      case 'agg.repeat':
        // Свёрнутые повторы — тоже события: без них счёт занижен
        break;
      default:
        break;
    }

    if (d.outcome === 'error' || d.ok === false) {
      const code = String(d.code || d.error || e.event);
      errors.set(code, (errors.get(code) || 0) + 1);
    }
    // Незавершённые участки: начало есть, конца нет
    const span = typeof d.span === 'string' ? d.span : trace;
    if (span && d.phase === 'start') started.add(span);
    if (span && d.phase === 'end') finished.add(span);
  }

  if (dropped > 0) truncated = true;

  const chains: Chain[] = [];
  for (const [trace, info] of chainInfo) {
    const spans = chainSpans.get(trace) || [];
    if (!spans.length) continue;
    chains.push({ trace, route: info.route, totalMs: info.totalMs, dbMs: unionMs(spans), dbOps: spans.length });
  }
  chains.sort((a, b) => b.totalMs - a.totalMs);

  let unfinished = 0;
  for (const span of started) if (!finished.has(span)) unfinished++;

  return {
    sessions: sessions.size,
    sources: [...sources].sort(),
    events: events.length,
    from,
    to,
    dropped,
    truncated,
    slowRoutes: slowest(routes, topN),
    slowDb: slowest(db, topN),
    slowOffice: slowest(office, topN),
    errors: [...errors].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count).slice(0, topN),
    stalls: { count: stallCount, maxMs: round(stallMax), totalMs: round(stallTotal) },
    memory: { maxRssBytes: maxRss, maxHeapBytes: maxHeap },
    unfinished,
    chains: chains.slice(0, topN),
  };
}

/** Разбор файла JSONL: битые строки пропускаются молча, но считаются. */
export function parseJsonl(text: string): { events: DiagnosticEvent[]; broken: number } {
  const events: DiagnosticEvent[] = [];
  let broken = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') events.push(parsed as DiagnosticEvent);
      else broken++;
    } catch (_) { broken++; }
  }
  return { events, broken };
}
