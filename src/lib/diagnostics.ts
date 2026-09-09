/**
 * Диагностика в окне: запросы, паузы отрисовки, ошибки.
 *
 * Две вещи здесь важнее остальных.
 *
 * Первая — хвост и очередь доставки не одно и то же. Хвост из последних пятисот
 * событий держится в памяти всегда и выгружается кнопкой; очередь нужна только
 * затем, чтобы отдать события оболочке на запись в файл. В браузере оболочки
 * нет — и это не потеря: терять нечего, потому что и не собирались. Прошлый
 * подход считал отсутствие моста потерей и показывал человеку растущий счётчик
 * там, где всё было в порядке.
 *
 * Вторая — обёртка вокруг fetch не читает тело ответа. Прочитать его «ради
 * подробности» значит отобрать его у вызывающего кода: тело читается один раз.
 * Поэтому измеряется момент, когда его читает сам вызывающий, — подменой
 * методов ответа, а не чтением с копии.
 *
 * Чего эта запись НЕ видит, сказано честно в README: XMLHttpRequest, прямое
 * чтение response.body, работу чужих программ и сетевые пакеты системы.
 */

import { cleanFields, newTraceId, routeName } from '../../diagnostics/event';
import { SCHEMA_VERSION, type DiagnosticEvent, type EventName, type SafeFields } from '../../diagnostics/contracts';
import { RateLimit, RepeatFilter, isFailure, passesMode } from '../../diagnostics/policy';

/** Сколько событий держим в хвосте для выгрузки. */
const TAIL = 500;
/** Сколько ждёт отправки в оболочку. */
const QUEUE = 500;
/** Больше этого в секунду не пишем даже в подробном режиме. */
const PER_SECOND = 1000;

const session = newTraceId();
let seq = 0;
let dropped = 0;
let sending = false;
let detailedUntil = 0;

const tail: DiagnosticEvent[] = [];
const queue: DiagnosticEvent[] = [];
const rate = new RateLimit(PER_SECOND);
const repeats = new RepeatFilter();

/** Мост оболочки. В браузере его нет, и это обычное дело, а не поломка. */
function bridge(): any {
  try { return (window as any).electron?.diagnostics || null; } catch (_) { return null; }
}

const detailed = () => detailedUntil > Date.now();

/** Подробный режим на N секунд — и в окне, и в оболочке. */
export function setDetailedMode(seconds: number): void {
  detailedUntil = seconds > 0 ? Date.now() + Math.min(seconds, 300) * 1000 : 0;
  try { bridge()?.detailed?.(seconds); } catch (_) { /* мост может быть закрыт */ }
}

export function diagnostic<E extends EventName>(event: E, fields?: SafeFields<E>): void {
  try {
    const now = Date.now();
    const data = cleanFields(event, fields as Record<string, unknown>);
    if (!data) return;
    if (!passesMode(event, data, detailed())) return;
    if (!repeats.accept(event, data, now)) return;
    if (!isFailure(event, data) && !rate.allow(now)) { dropped++; return; }
    push({ v: SCHEMA_VERSION, time: new Date().toISOString(), session, seq: ++seq, source: 'renderer', event, data });
  } catch (_) { /* запись не имеет права сломать работу окна */ }
}

function push(entry: DiagnosticEvent): void {
  tail.push(entry);
  if (tail.length > TAIL) tail.shift();
  // Очередь наполняется только когда есть кому отдавать
  if (!bridge()) return;
  if (queue.length >= QUEUE) { dropped++; return; }
  queue.push(entry);
}

async function flush(): Promise<void> {
  const api = bridge();
  if (!api || sending || !queue.length) return;
  sending = true;
  const batch = queue.splice(0, 100);
  try {
    // Оболочка отвечает `false`, когда пачку не приняла: отказ бывает и без
    // отклонённого обещания, и раньше он проходил незамеченным
    const taken = await api.append(batch);
    if (taken === false) dropped += batch.length;
  } catch (_) {
    dropped += batch.length;
  } finally {
    sending = false;
  }
}

/** Состояние для раздела «Журналы и ошибки»: потери должны быть видны. */
export function rendererStatus(): { session: string; queued: number; dropped: number; tail: number; transport: boolean; detailed: boolean } {
  return { session, queued: queue.length, dropped, tail: tail.length, transport: !!bridge(), detailed: detailed() };
}

/**
 * Обёртка вокруг fetch. Ставится ВНУТРЬ существующей обёртки `config/env`,
 * поэтому видит уже переписанный адрес и уже подставленный токен — то есть то,
 * что действительно ушло на сервер.
 */
export function diagnosticFetch(fetcher: typeof fetch): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl = typeof Request !== 'undefined' && input instanceof Request ? input.url : String(input);
    const route = routeName(rawUrl);
    const trace = newTraceId();
    const method = String(init?.method || (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET')).toUpperCase();
    const start = performance.now();

    // Метку ставим только своему API: чужому серверу наши заголовки не нужны,
    // а лишний заголовок вызывает у него предварительный запрос
    let own = false;
    try {
      const url = new URL(rawUrl, location.href);
      own = url.pathname.startsWith('/api/');
      if (own) {
        const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
        headers.set('X-Flux-Trace', trace);
        init = { ...(init || {}), headers };
      }
    } catch (_) { /* адрес разберёт сам fetch */ }

    diagnostic('fetch.start', { trace, route, method, phase: 'start' });
    try {
      const response = await fetcher(input as any, init);
      diagnostic('fetch.headers', {
        trace, route, method, status: String(response.status),
        durationMs: performance.now() - start,
        serverTrace: own ? response.headers.get('X-Flux-Trace') || undefined : undefined,
        declaredBytes: Number(response.headers.get('content-length')) || undefined,
        outcome: response.ok ? 'ok' : 'error',
      });
      measureReading(response, trace, route, start);
      return response;
    } catch (error: any) {
      // Отменённый запрос — не поломка сервера: человек закрыл окно
      const cancelled = error?.name === 'AbortError';
      diagnostic('fetch.error', {
        trace, route, method, durationMs: performance.now() - start,
        error: error?.name, outcome: cancelled ? 'cancelled' : 'error',
      });
      throw error;
    }
  };
}

/**
 * Когда тело действительно прочитали. Тело не копируется и не читается нами:
 * прочитать его можно один раз, и «ради подробности» отбирать его у
 * вызывающего кода нельзя.
 */
function measureReading(response: Response, trace: string, route: string, start: number): void {
  for (const reader of ['json', 'text', 'arrayBuffer', 'blob', 'formData'] as const) {
    try {
      const original = (response as any)[reader]?.bind(response);
      if (typeof original !== 'function') continue;
      Object.defineProperty(response, reader, {
        configurable: true,
        value: async () => {
          const from = performance.now();
          try {
            const result = await original();
            diagnostic('fetch.consume', {
              trace, route, reader, durationMs: performance.now() - from,
              totalMs: performance.now() - start, ok: true, outcome: 'ok',
            });
            return result;
          } catch (error: any) {
            diagnostic('fetch.consume', {
              trace, route, reader, durationMs: performance.now() - from,
              ok: false, error: error?.name, outcome: 'error',
            });
            throw error;
          }
        },
      });
    } catch (_) { /* чужая реализация ответа может быть неизменяемой */ }
  }
}

let started = false;

export function startDiagnostics(): void {
  if (started || typeof window === 'undefined') return;
  started = true;

  setInterval(() => { void flush(); }, 1000);

  // Задержка таймера при видимой странице — самый честный признак «окно
  // задумалось»: в скрытой вкладке браузер сам замедляет таймеры, и мерить
  // там нечего
  let expected = performance.now() + 1000;
  setInterval(() => {
    const now = performance.now();
    const lag = now - expected;
    expected = now + 1000;
    if (lag > 150 && document.visibilityState === 'visible') diagnostic('ui.stall', { durationMs: lag });
  }, 1000);

  setInterval(() => {
    const memory = (performance as any).memory;
    diagnostic('renderer.sample', {
      dropped, pending: queue.length,
      visible: document.visibilityState === 'visible',
      heapUsedBytes: memory?.usedJSHeapSize,
    });
  }, 5000);

  observe();

  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('button,a,[role="button"]') : null;
    if (!target) return;
    // Ни текста кнопки, ни введённых значений: имя действия берётся только из
    // явной пометки в разметке, которую ставит разработчик
    diagnostic('ui.click', {
      tag: target.tagName,
      action: target.getAttribute('data-diagnostic-action') || undefined,
    });
  }, true);

  window.addEventListener('error', (e) => diagnostic('renderer.error', errorFields((e as ErrorEvent).error)));
  window.addEventListener('unhandledrejection', (e) => diagnostic('renderer.rejection', errorFields((e as PromiseRejectionEvent).reason)));
  for (const name of ['online', 'offline', 'pagehide'] as const) {
    window.addEventListener(name, () => diagnostic('window.net', { state: name }));
  }
  // Та же чёрная дверь, что у журнала (`__pdmLogStore`): при разборе по телефону
  // человека проще попросить открыть консоль и назвать числа, чем вести его по
  // разделам. Наружу отдаётся только состояние и выгрузка — событий отсюда не
  // добавить и чужих не прочитать
  try {
    (window as any).__fluxDiagnostics = { status: rendererStatus, save: exportRendererDiagnostics };
  } catch (_) { /* окружение без window */ }

  diagnostic('renderer.start', { timeOrigin: performance.timeOrigin });
}

function errorFields(error: any): SafeFields<'renderer.error'> {
  const frames = String(error?.stack || '').split('\n').slice(1, 4).map((l) => l.trim());
  return {
    error: error?.name || 'Error',
    ...(frames[0] ? { frame1: frames[0] } : {}),
    ...(frames[1] ? { frame2: frames[1] } : {}),
    ...(frames[2] ? { frame3: frames[2] } : {}),
  };
}

/** Наблюдатели ставятся поштучно: часть из них есть не в каждом движке. */
function observe(): void {
  for (const type of ['longtask', 'resource', 'event'] as const) {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (type === 'resource') {
            const r = entry as PerformanceResourceTiming;
            diagnostic('resource.end', {
              route: routeName(r.name), initiator: r.initiatorType,
              startMs: r.startTime, durationMs: r.duration,
              ttfbMs: r.responseStart > 0 ? r.responseStart - r.requestStart : undefined,
              downloadMs: r.responseEnd - r.responseStart,
              transferredBytes: r.transferSize, decodedBytes: r.decodedBodySize,
            });
          } else if (type === 'longtask') {
            diagnostic('ui.longtask', { startMs: entry.startTime, durationMs: entry.duration });
          } else {
            diagnostic('ui.event', { name: entry.name, startMs: entry.startTime, durationMs: entry.duration });
          }
        }
      });
      observer.observe({ type, buffered: true, ...(type === 'event' ? { durationThreshold: 104 } : {}) } as any);
    } catch (_) {
      diagnostic('observer.unavailable', { name: type });
    }
  }
}

/** Выгрузка хвоста файлом. Доступна и в браузере — хвост есть всегда. */
export function exportRendererDiagnostics(): void {
  const head = JSON.stringify({
    note: 'Последние события этого окна. Записи сервера и оболочки лежат в своих файлах.',
    session, dropped, tail: tail.length,
  });
  const blob = new Blob([`${head}\n`, ...tail.map((e) => `${JSON.stringify(e)}\n`)], { type: 'application/x-ndjson' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `flux-diagnostics-${Date.now()}.jsonl`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
