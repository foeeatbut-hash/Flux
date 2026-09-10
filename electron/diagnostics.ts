/**
 * Диагностика оболочки: мост между окном и главным процессом, окна, процессы.
 *
 * Главное здесь — мост. Раньше его время измерялось только внутри обработчика,
 * и это не то, что чувствует человек: между нажатием и началом работы лежит
 * ещё очередь. Поэтому замеров два. Окно (точнее, preload) знает, сколько
 * ждало от вызова до ответа, — это `ipc.call`. Главный процесс знает, сколько
 * работал сам обработчик, — это `ipc.handle`. Разница между ними и есть
 * очередь; ни одно из двух чисел по отдельности её не показывает.
 *
 * Аргументы вызова не сериализуются никогда: в них ездят содержимое документа,
 * картинка снимка и текст письма.
 *
 * Завершение программы диагностика не задерживает. Соблазн придержать выход
 * ради последней пачки велик, но цена ошибки несоизмерима: «программа не
 * закрывается» — поломка, а потеря последней секунды записи — нет. Поэтому
 * сброс делается вдогонку, а о возможной потере хвоста сказано в README.
 */

import { app, ipcMain, shell, BrowserWindow } from 'electron';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { FileWriter } from '../diagnostics/node/writer';
import { monitorRuntime } from '../diagnostics/node/runtime';
import { safeError, safeName } from '../diagnostics/event';
import { validBatch } from '../diagnostics/policy';

/** Не больше стольких записей в одной пачке от окна. */
const BATCH_MAX = 200;
/** И не больше стольких пачек в секунду от одного окна. */
const BATCH_PER_SECOND = 20;

let writer: FileWriter | null = null;

export function diagnosticsWriter(): FileWriter | null {
  return writer;
}

export function setupDiagnostics(logDir: string): void {
  const dir = path.join(logDir, 'diagnostics');
  // Встроенный сервер запускается отдельным процессом и берёт путь отсюда:
  // иначе его записи легли бы в другую папку, и цепочку было бы не собрать
  process.env.FLUX_DIAGNOSTICS_DIR = dir;

  const sink = new FileWriter(dir, 'electron');
  writer = sink;
  monitorRuntime(sink);

  wrapHandlers(sink);
  registerBridge(sink, dir);
  watchWindows(sink);
  watchProcesses(sink);
}

/**
 * Обёртка вокруг регистрации обработчиков: так под замер попадают и те, что
 * заводят подключаемые модули (захват, браузер, обновления), а не только
 * перечисленные в главном файле.
 */
function wrapHandlers(sink: FileWriter): void {
  const original = ipcMain.handle.bind(ipcMain);
  (ipcMain as any).handle = (channel: string, listener: (...a: any[]) => any) =>
    original(channel, async (event: any, ...args: any[]) => {
      // Каналы самой диагностики не измеряем: иначе запись о записи
      if (channel.startsWith('diagnostics:')) return listener(event, ...args);
      const start = performance.now();
      try {
        const result = await listener(event, ...args);
        sink.record('ipc.handle', {
          channel: safeName(channel), sender: event?.sender?.id,
          durationMs: performance.now() - start, ok: true, outcome: 'ok',
        });
        return result;
      } catch (error: any) {
        sink.record('ipc.handle', {
          channel: safeName(channel), sender: event?.sender?.id,
          durationMs: performance.now() - start, ok: false, outcome: 'error', ...safeError(error),
        });
        throw error; // поведение обработчика не меняется
      }
    });
}

/**
 * Отправитель должен быть нашим окном.
 *
 * Честно про глубину этой проверки: настоящий барьер не здесь, а в том, что
 * чужая страница в разделе «Браузер» открывается без preload и обратиться к
 * мосту ей нечем. Проверка отсекает случайное, а не злонамеренное.
 */
function trusted(event: any): boolean {
  try {
    return !!BrowserWindow.fromWebContents(event?.sender);
  } catch (_) {
    return false;
  }
}

function registerBridge(sink: FileWriter, dir: string): void {
  const seen = new Map<number, { at: number; used: number }>();
  const withinLimit = (id: number): boolean => {
    const now = Date.now();
    const state = seen.get(id) || { at: now, used: 0 };
    if (now - state.at >= 1000) { state.at = now; state.used = 0; }
    state.used++;
    seen.set(id, state);
    return state.used <= BATCH_PER_SECOND;
  };

  ipcMain.handle('diagnostics:append', (event: any, batch: unknown) => {
    if (!trusted(event) || !withinLimit(event.sender.id)) return false;
    const items = validBatch(batch, BATCH_MAX);
    // Незнакомое имя события отсеет сам писатель: словарь один на всех
    for (const item of items) sink.record(item.event as any, item.data as any);
    return items.length > 0;
  });

  // Замеры моста со стороны окна: сколько ждали от вызова до ответа
  ipcMain.on('diagnostics:ipc', (event: any, batch: unknown) => {
    if (!trusted(event) || !Array.isArray(batch)) return;
    if (batch.length > BATCH_MAX || !withinLimit(event.sender.id)) return;
    for (const item of batch as any[]) {
      if (!item || typeof item.channel !== 'string') continue;
      sink.record('ipc.call', {
        channel: safeName(item.channel),
        waitMs: Number(item.waitMs),
        ok: item.ok !== false,
        outcome: item.ok === false ? 'error' : 'ok',
        ...(typeof item.error === 'string' ? { error: safeName(item.error) } : {}),
      });
    }
  });

  ipcMain.handle('diagnostics:folder', async () => {
    await sink.flush();
    // Путь не принимается от окна: открываем только свою папку
    return shell.openPath(dir);
  });
  ipcMain.handle('diagnostics:status', () => sink.status());
  ipcMain.handle('diagnostics:detailed', (event: any, seconds: unknown) => {
    if (!trusted(event)) return false;
    sink.setDetailed(Number(seconds) || 0);
    return true;
  });
}

function watchWindows(sink: FileWriter): void {
  app.on('web-contents-created', (_event, contents) => {
    for (const name of ['did-start-loading', 'did-stop-loading', 'unresponsive', 'responsive', 'destroyed'] as const) {
      try {
        contents.on(name as any, () => sink.record('window.state', { id: contents.id, state: safeName(name) }));
      } catch (_) { /* часть событий недоступна для встроенных видов */ }
    }
    contents.on('render-process-gone', (_e, details: any) =>
      sink.record('renderer.gone', { id: contents.id, reason: safeName(details?.reason), exitCode: String(details?.exitCode ?? '') }));
    contents.on('did-fail-load', (_e, code: number, _d: string, _u: string, mainFrame: boolean) =>
      sink.record('window.load-error', { id: contents.id, code: String(code), mainFrame }));
  });
}

function watchProcesses(sink: FileWriter): void {
  app.on('child-process-gone', (_e, details: any) =>
    sink.record('child.gone', {
      type: safeName(details?.type), reason: safeName(details?.reason), exitCode: String(details?.exitCode ?? ''),
    }));

  const timer = setInterval(() => {
    try {
      for (const metric of app.getAppMetrics()) {
        sink.record('electron.process', {
          pid: metric.pid, type: safeName(metric.type),
          cpuPercent: metric.cpu?.percentCPUUsage,
          workingSetKB: metric.memory?.workingSetSize,
          peakWorkingSetKB: (metric.memory as any)?.peakWorkingSetSize,
        });
      }
    } catch (_) { /* замер не должен мешать работе оболочки */ }
  }, 5000);
  if (typeof timer.unref === 'function') timer.unref();

  app.on('before-quit', () => {
    clearInterval(timer);
    sink.record('app.quit', {});
    // Вдогонку, не задерживая выход: недоступный диск не должен держать
    // закрытие программы, а последняя секунда записи того не стоит
    void sink.flush();
  });
}
