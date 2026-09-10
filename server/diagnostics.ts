/**
 * Диагностика на сервере: запрос, операции базы и сокет — одной цепочкой.
 *
 * Смысл здесь ровно один: связать «страница открывалась восемь секунд» с
 * «выборка оборудования шла семь». Без связи оба числа лежат в разных местах
 * и ни о чём не говорят.
 *
 * Связь держится на двух вещах. Заголовок `X-Flux-Trace` приезжает от окна и
 * возвращается обратно, поэтому одна и та же операция называется одинаково с
 * обеих сторон. `AsyncLocalStorage` доносит эту метку до обработчика базы, не
 * заводя изменяемой «текущей заявки» на модуль: с ней два одновременных
 * запроса приписали бы свои выборки друг другу, и разбор врал бы тем сильнее,
 * чем больше людей работает.
 *
 * Обёртка не имеет права изменить поведение: она возвращает то же значение и
 * бросает ту же ошибку. Проверено на живом клиенте — `$extends` перехватывает
 * и обычные операции, и сырые запросы, работает в обеих формах `$transaction`,
 * а ошибка долетает своим классом и кодом.
 */

import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { RequestHandler, Request } from 'express';
import { FileWriter } from '../diagnostics/node/writer';
import { monitorRuntime } from '../diagnostics/node/runtime';
import { newTraceId, routeName, safeError, safeName } from '../diagnostics/event';

/** Куда пишем. Electron передаёт путь; отдельный сервер выбирает свой. */
function diagnosticsDir(): string {
  return (
    process.env.FLUX_DIAGNOSTICS_DIR ||
    path.join(process.env.APPDATA || os.homedir(), 'pdm-app', 'logs', 'diagnostics')
  );
}

let writer: FileWriter | null = null;
let stopRuntime: (() => void) | null = null;

/**
 * Выключатель на случай, когда запись мешает.
 *
 * Нужен по двум причинам. Первая: администратору отдела должно быть чем
 * выключить сбор, не дожидаясь новой версии, — иначе единственным выходом
 * останется откат программы. Вторая: без выключателя нельзя честно измерить,
 * сколько сбор стоит, — сравнивать будет не с чем.
 */
const OFF = process.env.FLUX_DIAGNOSTICS === 'off';
export const diagnosticsEnabled = !OFF;

/**
 * Создаётся при первом обращении, а не при загрузке модуля: иначе набор
 * проверок, всего лишь импортировавший этот файл, начал бы писать в рабочую
 * папку сотрудника.
 */
export function serverDiagnostics(): FileWriter {
  if (!writer) {
    writer = new FileWriter(diagnosticsDir(), 'server');
    stopRuntime = monitorRuntime(writer);
  }
  return writer;
}

export async function closeServerDiagnostics(): Promise<void> {
  stopRuntime?.();
  stopRuntime = null;
  await writer?.close();
  writer = null;
}

interface Context { trace: string; interaction: string; startedAt: number }
const context = new AsyncLocalStorage<Context>();

/** Метка нынешнего запроса — для тех, кто пишет свои события внутри обработчика. */
export function currentTrace(): Context | undefined {
  return context.getStore();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const accept = (value: unknown): string => (typeof value === 'string' && UUID.test(value) ? value : '');

/**
 * Имя маршрута берём у самого Express, когда он уже выбрал обработчик:
 * `/api/projects/:id` — это точный шаблон, а не догадка по виду пути. Разбор
 * адреса остаётся запасным путём для запросов, которым обработчик не нашёлся.
 */
function nameOf(req: Request): string {
  const pattern = (req as any).route?.path;
  if (typeof pattern === 'string' && pattern.startsWith('/')) {
    // Шаблон Express — наш собственный исходный код, а не ввод человека:
    // прогонять его через словарь известных частей нельзя. Так
    // `/api/users/:id/signature` схлопывался в `/api/users/:id/:id`, и подпись
    // становилась неотличима от прав — то есть терялось ровно то, ради чего
    // имя маршрута и нужно
    return `${req.baseUrl || ''}${pattern}`;
  }
  // Обработчик не нашёлся: адрес пришёл от человека, и доверять ему нельзя
  return routeName(req.originalUrl || req.url || '');
}

export const traceRequest: RequestHandler = (req, res, next) => {
  if (OFF) return next();
  if (!req.path.startsWith('/api/')) return next();
  let trace = '';
  let interaction = '';
  try {
    trace = accept(req.get('X-Flux-Trace')) || newTraceId();
    interaction = accept(req.get('X-Flux-Interaction'));
    res.setHeader('X-Flux-Trace', trace);
  } catch (_) { trace = trace || newTraceId(); }

  const start = performance.now();
  const method = safeName(req.method);
  const requestBytes = Number(req.get('content-length')) || 0;
  try {
    // Спрашиваем заранее: разбор адреса стоит заметно, а в обычном режиме
    // начало запроса всё равно не пишется. Замер накладных расходов поймал
    // именно это — считали и выбрасывали на каждом запросе
    const sink = serverDiagnostics();
    if (sink.wants('http.start')) {
      sink.record('http.start', {
        trace, interaction, phase: 'start', method, route: routeName(req.originalUrl || ''), requestBytes,
      });
    }
  } catch (_) { /* сбор не имеет права уронить запрос */ }

  let ended = false;
  const finish = (aborted: boolean) => {
    if (ended) return;
    ended = true;
    try {
      serverDiagnostics().record('http.end', {
        trace, interaction, phase: 'end', method, route: nameOf(req),
        status: String(res.statusCode),
        durationMs: performance.now() - start,
        aborted,
        requestBytes,
        responseBytes: Number(res.getHeader('content-length')) || 0,
        // Оборванное соединение — не поломка сервера: человек закрыл окно
        outcome: aborted ? 'cancelled' : res.statusCode >= 400 ? 'error' : 'ok',
      });
    } catch (_) { /* то же самое */ }
  };
  res.once('finish', () => finish(false));
  res.once('close', () => finish(!res.writableFinished));

  context.run({ trace, interaction, startedAt: start }, next);
};

/**
 * Обёртка вокруг клиента базы. Записывается одно событие на операцию — уже с
 * длительностью: пара «начало/конец» вдвое дороже и ничего не добавляет, пока
 * операция не вложена в другую.
 */
export function traceDatabase<T>(client: T): T {
  if (OFF) return client;
  try {
    return (client as any).$extends({
      query: {
        $allOperations: async ({ model, operation, args, query }: any) => {
          const start = performance.now();
          const store = context.getStore();
          try {
            const result = await query(args);
            try {
              serverDiagnostics().record('db.op', {
                trace: store?.trace, interaction: store?.interaction,
                model: safeName(model || 'raw'), operation: safeName(operation),
                durationMs: performance.now() - start,
                startMs: store ? start - store.startedAt : undefined,
                rows: Array.isArray(result) ? result.length : undefined,
                ok: true, outcome: 'ok',
              });
            } catch (_) { /* запись не влияет на результат операции */ }
            return result;
          } catch (error: any) {
            try {
              // Сообщение драйвера содержит SQL и значения — берём только код
              serverDiagnostics().record('db.op', {
                trace: store?.trace, interaction: store?.interaction,
                model: safeName(model || 'raw'), operation: safeName(operation),
                durationMs: performance.now() - start,
                startMs: store ? start - store.startedAt : undefined,
                ok: false, outcome: 'error', ...safeError(error),
              });
            } catch (_) { /* то же самое */ }
            throw error; // ошибка долетает своим классом и кодом
          }
        },
      },
    }) as T;
  } catch (_) {
    // Не удалось расширить клиента — работаем без измерений, но работаем
    return client;
  }
}

/** Имена событий сокета и разрывы. Тела сообщений не берутся никогда. */
export function traceSockets(io: any): void {
  if (OFF) return;
  try {
    io.on('connection', (socket: any) => {
      const connection = newTraceId();
      const sink = serverDiagnostics();
      sink.record('socket.connect', { connection });
      try {
        socket.onAny((event: string) => sink.record('socket.receive', { connection, name: safeName(event) }));
        socket.onAnyOutgoing((event: string) => sink.record('socket.send', { connection, name: safeName(event) }));
      } catch (_) { /* старая версия socket.io без onAny */ }
      socket.on('disconnect', (reason: string) =>
        sink.record('socket.disconnect', { connection, reason: safeName(reason) }));
    });
  } catch (_) { /* без наблюдения за сокетом сервер работает как прежде */ }
}
