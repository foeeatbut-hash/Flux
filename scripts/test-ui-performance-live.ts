/**
 * Небольшой живой замер кадров на основных разделах Flux.
 *
 * Замер не устанавливает порог FPS: фоновые процессы и виртуальный Windows-хост
 * слишком сильно влияют на абсолютные миллисекунды. Сравнивать результаты можно
 * с JSON-файлом, сохранённым через FLUX_PERF_OUT.
 *
 * Запуск (сервер поднят): npx tsx scripts/test-ui-performance-live.ts
 * FLUX_PERF_FRAMES=30 задаёт число интервалов после двух прогревочных кадров.
 * FLUX_PERF_BASE=baseline.json сравнивает этот прогон с сохранённой базой.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { loginPage } from './officeHarness';

const BASE = process.env.FLUX_API || 'http://localhost:3000';
const LOGIN = { symbol: process.env.FLUX_USER || 'RaupovKhKh', password: process.env.FLUX_PASS || '1122' };
const CHROME = process.env.FLUX_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const FRAME_COUNT = Math.max(10, Math.min(240, Number(process.env.FLUX_PERF_FRAMES) || 30));
const WARMUP_FRAMES = 2;
const NETWORK_IDLE_MS = 300;
const SETTLE_TIMEOUT_MS = 8_000;
const ROUTES = [
  { path: '/equipment', title: 'Оборудование' },
  { path: '/registry', title: 'Теги' },
  { path: '/catalog', title: 'Каталог' },
  { path: '/explorer', title: 'Проводник' },
  { path: '/management', title: 'Менеджмент' },
  { path: '/chat', title: 'Мессенджер' },
  { path: '/settings', title: 'Настройки' },
  { path: '/notes', title: 'Блокнот' },
];

type SectionResult = {
  path: string;
  title: string;
  frames: number[];
  medianMs: number;
  p95Ms: number;
  maxMs: number;
  networkSettled: boolean;
};

const percentile = (values: number[], fraction: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index];
};
const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForNetworkIdle(pending: Set<any>, lastRequestAt: { value: number }): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < SETTLE_TIMEOUT_MS) {
    if (pending.size === 0 && Date.now() - lastRequestAt.value >= NETWORK_IDLE_MS) return true;
    await wait(50);
  }
  return pending.size === 0;
}

async function collectFrames(page: any, count: number): Promise<number[]> {
  // Строка исполняется в браузере: служебные функции транспилятора tsx в страницу не переносятся.
  return page.evaluate(`new Promise(resolve => {
    const intervals = []; let previous = null;
    function tick(now) {
      if (previous !== null) intervals.push(now - previous);
      previous = now;
      if (intervals.length < ${count + WARMUP_FRAMES}) requestAnimationFrame(tick);
      else resolve(intervals.slice(${WARMUP_FRAMES}));
    }
    requestAnimationFrame(tick);
  })`);
}

function readBaseline(): Map<string, SectionResult> {
  const path = process.env.FLUX_PERF_BASE;
  if (!path) return new Map();
  const payload = JSON.parse(readFileSync(path, 'utf8'));
  return new Map((payload.sections || []).map((row: SectionResult) => [row.path, row]));
}

(async () => {
  let browser: any;
  const errors: Array<{ route: string; kind: string; message: string }> = [];
  let currentRoute = '/';
  const pending = new Set<any>();
  const lastRequestAt = { value: Date.now() };
  try {
    const { chromium } = await import('playwright-core');
    browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    page.on('request', (request: any) => { pending.add(request); lastRequestAt.value = Date.now(); });
    const finishRequest = (request: any) => { pending.delete(request); lastRequestAt.value = Date.now(); };
    page.on('requestfinished', finishRequest);
    page.on('requestfailed', finishRequest);
    page.on('pageerror', (error: Error) => errors.push({ route: currentRoute, kind: 'pageerror', message: error.message }));
    page.on('console', (message: any) => {
      if (message.type() === 'error') errors.push({ route: currentRoute, kind: 'console.error', message: message.text() });
    });

    await loginPage(page, BASE, LOGIN);
    const results: SectionResult[] = [];
    for (const route of ROUTES) {
      currentRoute = route.path;
      lastRequestAt.value = Date.now();
      await page.evaluate((path: string) => { window.location.hash = path; }, route.path);
      await page.waitForFunction((path: string) => window.location.hash === `#${path}`, route.path, { timeout: 5_000 });
      const networkSettled = await waitForNetworkIdle(pending, lastRequestAt);
      await page.waitForTimeout(1_000);
      const frames = await collectFrames(page, FRAME_COUNT);
      const finite = frames.length === FRAME_COUNT && frames.every((ms) => Number.isFinite(ms) && ms > 0);
      if (!finite) errors.push({ route: route.path, kind: 'frame-sample', message: `Получено ${frames.length}/${FRAME_COUNT} конечных интервалов` });
      results.push({
        path: route.path,
        title: route.title,
        frames,
        medianMs: frames.length ? median(frames) : NaN,
        p95Ms: frames.length ? percentile(frames, 0.95) : NaN,
        maxMs: frames.length ? Math.max(...frames) : NaN,
        networkSettled,
      });
    }

    console.log(`\nЗамер кадров, ${FRAME_COUNT} интервалов после ${WARMUP_FRAMES} прогревочных кадров`);
    console.log('Раздел                 медиана, мс   p95, мс   максимум, мс   сеть устоялась');
    for (const row of results) {
      console.log(`${row.title.padEnd(22)} ${row.medianMs.toFixed(1).padStart(10)} ${row.p95Ms.toFixed(1).padStart(9)} ${row.maxMs.toFixed(1).padStart(14)} ${row.networkSettled ? 'да' : 'нет'}`);
    }

    const baseline = readBaseline();
    if (baseline.size) {
      console.log('\nИзменение относительно FLUX_PERF_BASE (отрицательное число — быстрее)');
      for (const row of results) {
        const old = baseline.get(row.path);
        if (old) console.log(`${row.title.padEnd(22)} медиана ${signed(row.medianMs - old.medianMs)} мс; p95 ${signed(row.p95Ms - old.p95Ms)} мс; максимум ${signed(row.maxMs - old.maxMs)} мс`);
      }
    }

    if (errors.length) {
      console.error('\nОшибки интерфейса или неполные замеры:');
      for (const error of errors) console.error(`  ${error.route} [${error.kind}] ${error.message}`);
    } else {
      console.log('\nОшибок интерфейса нет; все интервалы конечны.');
    }

    const output = process.env.FLUX_PERF_OUT;
    if (output) writeFileSync(output, JSON.stringify({ createdAt: new Date().toISOString(), frameCount: FRAME_COUNT, sections: results }, null, 2) + '\n');
    process.exitCode = errors.length ? 1 : 0;
  } catch (error: any) {
    console.error('Замер не завершён:', error?.message || error);
    process.exitCode = 1;
  } finally {
    await browser?.close().catch(() => {});
  }
})();

function signed(value: number): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(1)}`;
}
