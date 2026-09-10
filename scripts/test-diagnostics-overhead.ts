/**
 * Сколько стоит подробная запись — числом, а не обещанием.
 *
 * «Не тормозит» — не результат, а надежда. Здесь один и тот же стенд
 * прогоняется дважды: с записью и без неё, — и сравниваются медиана и
 * девяносто пятый процентиль. Стенд свой: маленький Express на свободном порту
 * и заглушка вместо базы с управляемой задержкой. Так замер повторяем и не
 * зависит ни от чужих данных, ни от того, что в этот момент делает сервер.
 *
 * Цели из задания: обычная запись добавляет не больше 5 % к медиане и не
 * больше 10 % к девяносто пятому. Если не уложились — это видно здесь, а не у
 * сотрудника.
 *
 * Замер идёт в одном процессе, поэтому сравниваются именно накладные расходы
 * обёрток, а не разница между двумя запусками программы.
 */

import express from 'express';
import { performance } from 'node:perf_hooks';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let f = 0;
const ok = (name: string, cond: boolean, detail?: unknown) =>
  cond
    ? console.log('  ✓', name)
    : (f++, console.error('  ✗', name, detail !== undefined ? JSON.stringify(detail).slice(0, 300) : ''));

const ROUNDS = Number(process.env.FLUX_BENCH_ROUNDS || 400);

function stats(values: number[]) {
  const sorted = values.slice().sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  return { p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] };
}

const pct = (a: number, b: number) => (b === 0 ? 0 : Math.round(((a - b) / b) * 1000) / 10);

async function bench(base: string, rounds: number): Promise<number[]> {
  const times: number[] = [];
  for (let n = 0; n < rounds; n++) {
    const from = performance.now();
    const res = await fetch(`${base}/api/bench/${n}`);
    await res.json();
    times.push(performance.now() - from);
  }
  return times;
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-bench-'));
  process.env.FLUX_DIAGNOSTICS_DIR = path.join(root, 'diag');
  // Модуль читает выключатель при загрузке, поэтому важен порядок: сначала
  // окружение, потом импорт
  const { traceRequest, traceDatabase, serverDiagnostics, closeServerDiagnostics } = await import('../server/diagnostics');

  // Заглушка базы с управляемой задержкой: так стенд повторяем и не зависит ни
  // от чужих данных, ни от того, чем в этот момент занят настоящий сервер
  const stub = (ms: number) => ({
    $extends: (ext: any) => ({
      run: () => ext.query.$allOperations({
        model: 'Bench', operation: 'findMany', args: {},
        query: async () => { await new Promise((r) => setTimeout(r, ms)); return [1, 2, 3]; },
      }),
    }),
  });

  const build = (withDiagnostics: boolean, ms: number) => {
    const app = express();
    if (withDiagnostics) app.use(traceRequest);
    const db: any = withDiagnostics
      ? traceDatabase(stub(ms))
      : { run: async () => { await new Promise((r) => setTimeout(r, ms)); return [1, 2, 3]; } };
    app.get('/api/bench/:id', async (_req, res) => {
      await db.run(); await db.run(); await db.run();
      res.json({ ok: true });
    });
    return app;
  };

  const listen = (app: express.Express) => new Promise<{ base: string; close: () => Promise<void> }>((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const port = (server.address() as any).port;
      resolve({
        base: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });

  /** Один замер: два одинаковых стенда, отличаются только записью. */
  async function measure(dbMs: number, label: string) {
    const on = await listen(build(true, dbMs));
    const off = await listen(build(false, dbMs));
    try {
      // Прогрев: первые запросы всегда дороже — компилируется код, греются кэши
      await bench(on.base, 40);
      await bench(off.base, 40);
      const withOn = stats(await bench(on.base, ROUNDS));
      const withOff = stats(await bench(off.base, ROUNDS));
      const dP50 = pct(withOn.p50, withOff.p50);
      const dP95 = pct(withOn.p95, withOff.p95);
      console.log(`   ${label}: без записи ${withOff.p50.toFixed(2)} / ${withOff.p95.toFixed(2)} мс, `
        + `с записью ${withOn.p50.toFixed(2)} / ${withOn.p95.toFixed(2)} мс → +${dP50} % / +${dP95} %`);
      return { dP50, dP95, withOn, withOff, addedMs: withOn.p50 - withOff.p50 };
    } finally {
      await on.close();
      await off.close();
    }
  }

  try {
    console.log(`1. Два стенда по ${ROUNDS} запросов, по три операции базы в каждом`);
    // Обычный запрос Flux — список тегов, оборудование, документ — идёт
    // десятки миллисекунд. Короткий стенд оставлен рядом как худший случай:
    // на нём те же доли миллисекунды дают больший процент
    const usual = await measure(8, 'обычный запрос (~25 мс)');
    const shortest = await measure(2, 'короткий запрос (~7 мс)');

    console.log('\n2. Накладные расходы в пределах объявленных');
    ok(`на обычном запросе медиана выросла на ${usual.dP50} % (цель ≤ 5 %)`, usual.dP50 <= 5, usual);
    ok(`на обычном запросе p95 вырос на ${usual.dP95} % (цель ≤ 10 %)`, usual.dP95 <= 10, usual);
    // Худший случай тоже под присмотром, но с более мягким порогом: доля
    // постоянных расходов в коротком запросе всегда выше
    ok(`на коротком запросе медиана выросла на ${shortest.dP50} % (потолок 8 %)`, shortest.dP50 <= 8, shortest);
    console.log(`   в абсолюте запись добавляет около ${usual.addedMs.toFixed(2)} мс на запрос`);

    console.log('\n3. Очередь не растёт без предела');
    const status = serverDiagnostics().status();
    console.log(`   в очереди ${status.queued}, потеряно ${status.dropped}, записано ${status.written}`);
    ok('очередь держится в объявленном пределе', status.queuedBytes <= 16 * 1024 * 1024, status);

    console.log('\n4. Цена одной записи');
    const sink = serverDiagnostics();
    const from = performance.now();
    for (let n = 0; n < 20000; n++) sink.record('ui.stall', { durationMs: n });
    const each = ((performance.now() - from) / 20000) * 1000;
    console.log(`   одно событие обходится в ${each.toFixed(1)} мкс`);
    ok(`запись события дешевле 20 мкс (${each.toFixed(1)})`, each < 20, each);
  } finally {
    await closeServerDiagnostics();
    await fs.rm(root, { recursive: true, force: true });
  }

  console.log(f === 0 ? '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ' : `\nПРОВАЛОВ: ${f}`);
  process.exit(f === 0 ? 0 : 1);
}

void main().catch((error) => { console.error(error); process.exit(1); });
