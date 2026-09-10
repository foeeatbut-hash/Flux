/**
 * Состояние процесса: процессор, память, задержка цикла событий.
 *
 * Задержка цикла — то, чего не видно ни в одном другом журнале, и именно она
 * объясняет «программа задумалась»: пока цикл занят, ни один ответ не уходит,
 * сколько бы сервер ни был свободен. Меряется она гистограммой, а не разностью
 * времён: одиночный замер показывает случайную точку, а p99 — то, что человек
 * действительно чувствует.
 *
 * Длительности берутся монотонными часами. Системное время между двумя
 * машинами вычитать нельзя — часы расходятся, и «отрицательная задержка» в
 * отчёте появляется именно отсюда.
 */

import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import type { DiagnosticsSink } from './writer';

const SAMPLE_MS = 5000;

export function monitorRuntime(sink: DiagnosticsSink): () => void {
  let delay: ReturnType<typeof monitorEventLoopDelay> | null = null;
  try {
    delay = monitorEventLoopDelay({ resolution: 20 });
    delay.enable();
  } catch (_) { delay = null; }

  let cpu = process.cpuUsage();
  let start = performance.now();

  sink.record('process.start', {
    pid: process.pid,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
  });

  const timer = setInterval(() => {
    try {
      const elapsed = performance.now() - start;
      start = performance.now();
      const used = process.cpuUsage(cpu);
      cpu = process.cpuUsage();
      const mem = process.memoryUsage();
      sink.record('process.sample', {
        pid: process.pid,
        intervalMs: elapsed,
        // cpuUsage отдаёт микросекунды, elapsed — миллисекунды: делим на 10,
        // чтобы получить проценты одного ядра
        cpuPercent: elapsed > 0 ? (used.user + used.system) / (elapsed * 10) : 0,
        rssBytes: mem.rss,
        heapUsedBytes: mem.heapUsed,
        externalBytes: mem.external,
        loopP99Ms: delay ? delay.percentile(99) / 1e6 : 0,
        loopMaxMs: delay ? delay.max / 1e6 : 0,
      });
      delay?.reset();
    } catch (_) { /* замер не имеет права уронить процесс */ }
  }, SAMPLE_MS);
  if (typeof timer.unref === 'function') timer.unref();

  // Наблюдатель, а не обработчик: uncaughtExceptionMonitor не меняет поведение
  // аварийного завершения — процесс упадёт ровно так же, как упал бы без нас
  const crash = (error: Error) => {
    try {
      sink.record('process.uncaught', {
        error: error?.name,
        ...cleanFrames(error),
      });
      void sink.flush();
    } catch (_) { /* падаем молча: писать о неудачной записи некуда */ }
  };
  process.on('uncaughtExceptionMonitor', crash);

  return () => {
    clearInterval(timer);
    try { delay?.disable(); } catch (_) { /* уже выключен */ }
    process.off('uncaughtExceptionMonitor', crash);
  };
}

function cleanFrames(error: Error): { frame1?: string; frame2?: string; frame3?: string } {
  // Кадры чистит cleanFields по виду поля; сюда попадают сырые строки стека
  const lines = String(error?.stack || '').split('\n').slice(1, 4).map((l) => l.trim());
  return {
    ...(lines[0] ? { frame1: lines[0] } : {}),
    ...(lines[1] ? { frame2: lines[1] } : {}),
    ...(lines[2] ? { frame3: lines[2] } : {}),
  };
}
