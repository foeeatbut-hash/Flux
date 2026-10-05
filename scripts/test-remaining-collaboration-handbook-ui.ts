import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '../node_modules/playwright-core/index.mjs';

const root = process.cwd();
const fixture = path.join(root, 'scripts/fixtures/remaining-collaboration/handbook-ui');

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate a local Vite port');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const vite = spawn(process.execPath, [
    path.join(root, 'node_modules/vite/bin/vite.js'), '--config', path.join(fixture, 'vite.config.ts'),
    '--host', '127.0.0.1', '--port', String(port), '--strictPort',
  ], { cwd: root, env: { ...process.env, DISABLE_HMR: 'true' }, stdio: 'ignore' });
  const browser = await chromium.launch({ executablePath: process.env.FLUX_CHROME || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 390, height: 780 } });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => {
    if (response.status() >= 400 && new URL(response.url()).pathname !== '/favicon.ico') errors.push(`HTTP ${response.status()} ${response.url()}`);
  });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (vite.exitCode !== null) throw new Error(`Vite exited early with ${vite.exitCode}`);
      try { if ((await fetch(url)).ok) { ready = true; break; } } catch { /* waiting for startup */ }
      await delay(100);
    }
    assert(ready, 'Handbook fixture Vite server did not start');
    await page.goto(url);
    const search = page.getByRole('textbox', { name: 'Поиск по руководству' });
    await search.waitFor();

    await search.fill('общий доступ');
    const match = page.getByRole('button', { name: /Общий доступ/ }).first();
    await match.waitFor();
    await match.click();
    assert(await page.getByRole('heading', { name: 'Общий доступ' }).count() === 1, 'selecting the handbook search result did not open its article');
    assert(await page.getByLabel('ID выбранной статьи').textContent() === 'shared-files', 'search result selected an unexpected article');

    await search.fill('несуществующий запрос zzzqzx');
    await page.getByText('Ничего не нашлось', { exact: true }).waitFor();
    await search.fill('общий доступ');
    await page.getByRole('button', { name: 'Очистить поиск' }).click();
    assert(await search.inputValue() === '', 'clear-search control did not reset the query');
    assert(await page.getByRole('heading', { name: 'Общий доступ' }).count() === 1, 'clearing search unexpectedly changed the selected article');

    for (const width of [390, 1024]) {
      await page.setViewportSize({ width, height: 780 });
      for (const theme of ['light', 'dark']) {
        await page.evaluate((dark) => document.documentElement.classList.toggle('dark', dark), theme === 'dark');
        const geometry = await page.evaluate(() => ({
          viewport: innerWidth,
          bodyWidth: document.documentElement.scrollWidth,
          rootWidth: document.querySelector('#root')?.scrollWidth,
          rootClientWidth: document.querySelector('#root')?.clientWidth,
        }));
        assert(geometry.bodyWidth <= width + 1 && (geometry.rootWidth || 0) <= (geometry.rootClientWidth || 0) + 2, `handbook navigation overflows at ${width}px ${theme}: ${JSON.stringify(geometry)}`);
      }
    }
    assert(errors.length === 0, `browser errors: ${errors.join(' | ')}`);
    console.log(JSON.stringify({ result: 'passed', actionIds: ['handbook.search-article'], layer: 'component', checks: ['real HandbookNav renders a registry hit and opens selected article', 'unmatched search shows empty state', 'clear control resets query without changing current article', '390px and 1024px layouts fit in light and dark themes'], errors }, null, 2));
  } finally {
    await browser.close();
    vite.kill('SIGTERM');
  }
}

void main();
