import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '../node_modules/playwright-core/index.mjs';

const root = process.cwd();
const fixture = path.join(root, 'scripts/fixtures/guide-ui');
const output = process.env.GUIDE_FIXTURE_DIR || '/tmp/flux-guide-ui';
mkdirSync(output, { recursive: true });

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate local Vite port');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

async function main() {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const vite = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--config', path.join(fixture, 'vite.config.ts'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: root, env: { ...process.env, DISABLE_HMR: 'true' }, stdio: 'ignore' });
  const browser = await chromium.launch({ executablePath: process.env.FLUX_CHROME || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 390, height: 780 } });
  page.setDefaultTimeout(8000);
  page.setDefaultNavigationTimeout(15000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => { if (response.status() >= 400 && new URL(response.url()).pathname !== '/favicon.ico') errors.push(`HTTP ${response.status()} ${response.url()}`); });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (vite.exitCode !== null) throw new Error(`Vite exited early (${vite.exitCode})`);
      try { if ((await fetch(url)).ok) { ready = true; break; } } catch { /* starting */ }
      await delay(100);
    }
    assert(ready, 'Guide fixture Vite server did not start');
    await page.goto(`${url}/guide?tab=questions`, { waitUntil: 'domcontentloaded' });
    const input = page.getByRole('textbox', { name: 'Строка вопроса Flux Guide' });
    await input.waitFor();
    await input.fill('покажи все вентиляторы');
    await input.press('Enter');
    try { await page.getByText('Найдено позиций: 3.').waitFor(); }
    catch (error) { await page.screenshot({ path: path.join(output, 'questions-failure.png'), fullPage: true }); throw error; }
    assert(await page.getByRole('button', { name: 'Полный просмотр' }).count() === 1, 'question answer table is missing its full-view control');
    await page.getByRole('button', { name: 'Полный просмотр' }).click();
    await page.getByRole('dialog', { name: 'ВЕНТИЛЯТОР' }).waitFor();
    await page.getByRole('button', { name: 'Позиция' }).click();
    await page.getByRole('checkbox', { name: 'Выбрать строку 1' }).check();
    assert(await page.getByText('Выбрано: 1').count() === 1, 'table selection did not update its selected count');
    await page.screenshot({ path: path.join(output, 'questions-table-390-light.png'), fullPage: true });

    for (const width of [390, 760, 1280]) {
      await page.setViewportSize({ width, height: 780 });
      for (const theme of ['light', 'dark'] as const) {
        await page.evaluate((dark) => document.documentElement.classList.toggle('dark', dark), theme === 'dark');
        const geometry = await page.evaluate(() => ({ viewport: innerWidth, body: document.documentElement.scrollWidth, root: document.querySelector('#flux-guide-root')?.getBoundingClientRect().width }));
        assert(geometry.body <= width + 1 && Math.abs((geometry.root || 0) - width) <= 2, `Guide overflow at ${width}px ${theme}: ${JSON.stringify(geometry)}`);
        await page.screenshot({ path: path.join(output, `questions-table-${width}-${theme}.png`), fullPage: true });
      }
    }

    await page.getByRole('button', { name: 'Свернуть' }).click();
    await page.evaluate(() => document.documentElement.classList.remove('dark'));
    await page.setViewportSize({ width: 390, height: 780 });
    await page.getByRole('button', { name: 'История вопросов' }).click();
    await page.getByText('Сохранённых вопросов пока нет').waitFor();
    await page.getByRole('button', { name: 'Архив', exact: true }).click();
    await page.getByText('В архиве пока пусто.').waitFor();
    await page.screenshot({ path: path.join(output, 'history-archive-390-light.png'), fullPage: true });
    await page.goto(`${url}/guide?article=archives`, { waitUntil: 'domcontentloaded' });
    try { await page.getByRole('heading', { name: 'Архив', exact: true }).waitFor(); }
    catch (error) { await page.screenshot({ path: path.join(output, 'handbook-failure.png'), fullPage: true }); throw error; }
    await page.screenshot({ path: path.join(output, 'handbook-archive-390-light.png'), fullPage: true });

    assert(errors.length === 0, `browser errors: ${errors.join(' | ')}`);
    console.log(JSON.stringify({ result: 'passed', checks: ['real FluxGuide renders a project question and sortable selectable result table', 'full-view table fits 390/760/1280px in light and dark themes', 'history archive tab renders', 'real handbook article route opens the corrected Archive article'], screenshots: output, errors }, null, 2));
  } finally { await browser.close(); vite.kill('SIGTERM'); }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
