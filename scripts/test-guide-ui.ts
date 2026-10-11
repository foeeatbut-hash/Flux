import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '../node_modules/playwright-core/index.mjs';
import * as XLSX from 'xlsx';
import JSZip from 'jszip';

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
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 780 });
      for (const theme of ['light', 'dark'] as const) {
        await page.evaluate((dark) => document.documentElement.classList.toggle('dark', dark), theme === 'dark');
        const geometry = await page.evaluate(() => ({ viewport: innerWidth, body: document.documentElement.scrollWidth, root: document.querySelector('#flux-guide-root')?.getBoundingClientRect().width }));
        assert(geometry.body <= width + 1 && Math.abs((geometry.root || 0) - width) <= 2, `Guide question screen overflow at ${width}px ${theme}: ${JSON.stringify(geometry)}`);
        await page.screenshot({ path: path.join(output, `questions-screen-${width}-${theme}.png`), fullPage: true });
      }
    }
    await page.setViewportSize({ width: 390, height: 780 });
    await page.evaluate(() => document.documentElement.classList.remove('dark'));
    await page.getByRole('button', { name: 'Полный просмотр' }).click();
    await page.getByRole('dialog', { name: 'ВЕНТИЛЯТОР' }).waitFor();
    await page.getByRole('button', { name: 'Позиция' }).click();
    await page.getByRole('checkbox', { name: 'Выбрать строку 1' }).check();
    assert(await page.getByText('Выбрано: 1').count() === 1, 'table selection did not update its selected count');
    await page.screenshot({ path: path.join(output, 'questions-table-390-light.png'), fullPage: true });
    const bytesAt = async (index: number) => page.evaluate((i) => (window as any).__guideExports?.[i]?.bytes as number[] | undefined, index);
    await page.getByRole('button', { name: 'Excel', exact: true }).click();
    try { await page.waitForFunction(() => (window as any).__guideExports?.length === 1); }
    catch (error) { console.error('Export diagnostic:', await page.getByRole('alert').allTextContents(), errors); throw error; }
    const excelBytes = await bytesAt(0);
    assert(excelBytes?.length, 'Excel export did not produce file bytes');
    const workbook = XLSX.read(Uint8Array.from(excelBytes), { type: 'array' });
    const excelRows = XLSX.utils.sheet_to_json<string[]>(workbook.Sheets[workbook.SheetNames[0]], { header: 1 });
    assert(excelRows.length === 2 && excelRows[1]?.[0] === 'Вентилятор В-2', `Excel should contain only the selected row: ${JSON.stringify(excelRows)}`);
    await page.getByRole('button', { name: 'Word' }).click();
    await page.waitForFunction(() => (window as any).__guideExports?.length === 2);
    const wordBytes = await bytesAt(1);
    assert(wordBytes?.length, 'Word export did not produce file bytes');
    const wordZip = await JSZip.loadAsync(Uint8Array.from(wordBytes));
    const documentXml = await wordZip.file('word/document.xml')?.async('string');
    assert(!!documentXml && documentXml.includes('Вентилятор В-2') && !documentXml.includes('Вентилятор В-10') && !documentXml.includes('Вентилятор В-1'), 'Word export should contain only the selected row');

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
    await page.evaluate(() => (window as any).__guideLargeTable());
    await page.getByRole('button', { name: 'Полный просмотр' }).click();
    const largeTable = page.getByRole('dialog', { name: 'Большая выборка' });
    await largeTable.waitFor();
    await page.setViewportSize({ width: 390, height: 640 });
    const exportBox = await largeTable.getByRole('button', { name: 'Excel', exact: true }).boundingBox();
    assert(!!exportBox && exportBox.y >= 0 && exportBox.y + exportBox.height <= 640, 'large table pushed export controls outside the viewport');
    const scrollArea = largeTable.locator('table').locator('..');
    assert(await scrollArea.evaluate((element) => element.scrollHeight > element.clientHeight), 'large table must scroll within its dialog');
    await scrollArea.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await largeTable.getByText('Позиция 300', { exact: true }).waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    await largeTable.waitFor({ state: 'hidden' });
    await page.setViewportSize({ width: 390, height: 780 });
    await page.evaluate(() => document.documentElement.classList.remove('dark'));
    await page.setViewportSize({ width: 390, height: 780 });
    await page.getByRole('button', { name: 'История вопросов' }).click();
    await page.getByText('Сохранённых вопросов пока нет').waitFor();
    await page.evaluate(() => (window as any).__stageOtherProjectChat());
    const stagedHistory = await page.evaluate(() => (window as any).__guideHistorySnapshot());
    assert(stagedHistory.chats?.some((chat: any) => chat.id === 'fixture-other-chat'), `history fixture was not staged: ${JSON.stringify(stagedHistory)}`);
    if (await page.getByText('Вопрос из другого проекта', { exact: true }).count() === 0) {
      console.error('History panel after staging:', await page.locator('#flux-guide-root').innerText(), JSON.stringify(stagedHistory));
    }
    await page.getByText('Вопрос из другого проекта', { exact: true }).click();
    const switchDialog = page.getByRole('dialog');
    await switchDialog.getByText('Сохранённый разговор относится к проекту «Проект из истории».').waitFor();
    await switchDialog.getByRole('button', { name: 'Отмена' }).click();
    const afterCancel = await page.evaluate(() => (window as any).__guideHistorySnapshot());
    assert(afterCancel.projectId === 'fixture-project' && afterCancel.chatId === 'fixture-unsaved-chat'
      && afterCancel.messages.includes('Текущий черновой вопрос') && afterCancel.draftQuestions === 'Оставить этот черновик',
    `canceling project switch changed current Guide state: ${JSON.stringify(afterCancel)}`);
    const historyRow = page.getByText('Вопрос из другого проекта', { exact: true });
    if (!(await historyRow.isVisible())) await page.getByRole('button', { name: 'История вопросов' }).click();
    await historyRow.waitFor({ state: 'visible' });
    await page.getByText('Вопрос из другого проекта', { exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Открыть разговор' }).click();
    await page.getByText('Ответ из другого проекта').waitFor();
    const afterConfirm = await page.evaluate(() => (window as any).__guideHistorySnapshot());
    assert(afterConfirm.projectId === 'fixture-project-other' && afterConfirm.chatId === 'fixture-other-chat'
      && afterConfirm.messages.includes('Ответ из другого проекта'), `confirmed project switch did not load selected history: ${JSON.stringify(afterConfirm)}`);
    await page.getByRole('button', { name: 'История вопросов' }).click();
    await page.getByRole('button', { name: 'Архив', exact: true }).click();
    await page.getByText('В архиве пока пусто.').waitFor();
    await page.screenshot({ path: path.join(output, 'history-archive-390-light.png'), fullPage: true });
    await page.goto(`${url}/guide?article=archives`, { waitUntil: 'domcontentloaded' });
    try { await page.getByRole('heading', { name: 'Архив', exact: true }).waitFor(); }
    catch (error) { await page.screenshot({ path: path.join(output, 'handbook-failure.png'), fullPage: true }); throw error; }
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 780 });
      for (const theme of ['light', 'dark'] as const) {
        await page.evaluate((dark) => document.documentElement.classList.toggle('dark', dark), theme === 'dark');
        const geometry = await page.evaluate(() => ({ viewport: innerWidth, body: document.documentElement.scrollWidth, root: document.querySelector('#flux-guide-root')?.getBoundingClientRect().width }));
        assert(geometry.body <= width + 1 && Math.abs((geometry.root || 0) - width) <= 2, `Guide handbook screen overflow at ${width}px ${theme}: ${JSON.stringify(geometry)}`);
        await page.screenshot({ path: path.join(output, `handbook-screen-${width}-${theme}.png`), fullPage: true });
      }
    }

    assert(errors.length === 0, `browser errors: ${errors.join(' | ')}`);
    console.log(JSON.stringify({ result: 'passed', checks: ['real FluxGuide renders question and source at 390/1280px in light and dark themes', 'full-view table fits 390/760/1280px in light and dark themes', '300-row table scrolls with export controls reachable and Escape closes it', 'selected rows alone are written into real XLSX and DOCX exports', 'cross-project history confirmation preserves the current chat on cancel and loads the target on confirm', 'history archive tab renders', 'real handbook article opens at 390/1280px in light and dark themes'], screenshots: output, errors }, null, 2));
  } finally { await browser.close(); vite.kill('SIGTERM'); }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
