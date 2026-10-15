import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';

const root = process.cwd();
async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Не удалось выделить порт для Vite.');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function run() {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const output = path.join(os.tmpdir(), 'flux-owner-login-ui');
  mkdirSync(output, { recursive: true });
  const viteLogPath = path.join(output, 'vite.log');
  const viteLog = createWriteStream(viteLogPath, { flags: 'w' });
  const vite = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: root, env: { ...process.env, DISABLE_HMR: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });
  vite.stdout?.pipe(viteLog);
  vite.stderr?.pipe(viteLog);
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (vite.exitCode !== null) throw new Error(`Vite завершился до запуска (${vite.exitCode}).`);
      try { if ((await fetch(url)).ok) { ready = true; break; } } catch { /* Vite ещё запускается. */ }
      await delay(100);
    }
    if (!ready) throw new Error(`Vite не запустился для проверки входа владельца. Журнал: ${viteLogPath}`);
    browser = await chromium.launch({ ...(process.env.FLUX_CHROME ? { executablePath: process.env.FLUX_CHROME } : {}), args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.addInitScript(() => {
      const listeners = new Set<unknown>();
      const add = window.addEventListener.bind(window);
      const remove = window.removeEventListener.bind(window);
      (window as any).__ownerLoginKeydownListeners = listeners;
      (window as any).addEventListener = (type: string, listener: unknown, options?: unknown) => {
        if (type === 'keydown') listeners.add(listener);
        return add(type, listener as EventListener, options as AddEventListenerOptions);
      };
      (window as any).removeEventListener = (type: string, listener: unknown, options?: unknown) => {
        if (type === 'keydown') listeners.delete(listener);
        return remove(type, listener as EventListener, options as EventListenerOptions);
      };
    });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(`${url}/scripts/fixtures/owner-login-ui.html`);
    await page.waitForFunction(() => (window as any).__ownerLoginKeydownListeners?.size === 1);
    const ownerButton = page.getByRole('button', { name: 'Вход владельца', exact: true });
    assert.equal(await ownerButton.count(), 0, 'кнопки нет в DOM до сочетания');
    assert.equal(await page.getByText('Вход владельца с ключом доступен в приложении Flux для Windows.', { exact: true }).count(), 0, 'подсказки нет до сочетания');
    assert.equal(await page.evaluate(() => (window as any).__ownerLoginKeydownListeners.size), 1, 'обработчик сочетания зарегистрирован');

    await page.keyboard.down('Control');
    assert.equal(await ownerButton.count(), 0, 'один Ctrl не открывает кнопку');
    await page.keyboard.down('Shift');
    assert.equal(await ownerButton.count(), 0, 'Ctrl и Shift без Alt не открывают кнопку');
    await page.keyboard.up('Shift');
    await page.keyboard.down('Alt');
    assert.equal(await ownerButton.count(), 0, 'Ctrl и Alt без Shift не открывают кнопку');
    await page.keyboard.down('Shift');
    await ownerButton.waitFor({ state: 'visible' });
    await page.keyboard.up('Shift');
    await page.keyboard.up('Alt');
    await page.keyboard.up('Control');
    await ownerButton.click();
    assert.equal(await page.getByText('Вход владельца с ключом доступен в приложении Flux для Windows.', { exact: true }).count(), 1, 'подсказка появляется только после полного сочетания');

    await page.goto(`${url}/scripts/fixtures/owner-login-ui.html?electron`);
    await page.waitForFunction(() => (window as any).__ownerLoginKeydownListeners?.size === 1);
    await page.keyboard.down('Control');
    await page.keyboard.down('Shift');
    await page.keyboard.down('Alt');
    await page.keyboard.up('Alt');
    await page.keyboard.up('Shift');
    await page.keyboard.up('Control');
    const enabledOwnerButton = page.getByRole('button', { name: 'Вход владельца', exact: true });
    await enabledOwnerButton.click();
    await page.getByRole('button', { name: 'Выбрать файл ключа', exact: true }).waitFor();
    assert.equal(await page.getByLabel('Пароль ключа владельца').count(), 1, 'после сочетания открывается форма входа владельца');
    assert.equal(await page.getByText(/основной ключ|резервную копию/i).count(), 0, 'форма не содержит удалённую фразу');
    const geometry: Array<{ width: number; height: number; borderTopColor: string }> = [];
    for (const dark of [false, true]) {
      await page.evaluate(value => document.documentElement.classList.toggle('dark', value), dark);
      const metrics = await page.locator('#mount > div').evaluate(element => {
        const rect = element.getBoundingClientRect();
        return { width: rect.width, height: rect.height, borderTopColor: getComputedStyle(element).borderTopColor };
      });
      assert.ok(metrics.width > 0 && metrics.height > 0, 'форма имеет размеры в обеих темах');
      geometry.push(metrics);
      await page.screenshot({ path: path.join(output, `owner-login-${dark ? 'dark' : 'light'}.png`) });
    }
    assert.notEqual(geometry[0].borderTopColor, geometry[1].borderTopColor, 'рамка входа различает светлую и тёмную темы');
    await page.evaluate(() => (window as any).__unmountOwnerLogin());
    assert.equal(await page.evaluate(() => (window as any).__ownerLoginKeydownListeners.size), 0, 'при unmount обработчик снимается');
    await page.keyboard.down('Control');
    await page.keyboard.down('Shift');
    await page.keyboard.down('Alt');
    await page.keyboard.up('Alt');
    await page.keyboard.up('Shift');
    await page.keyboard.up('Control');
    assert.equal(await page.getByRole('button', { name: 'Вход владельца', exact: true }).count(), 0, 'после unmount сочетание не возвращает компонент');
    assert.deepEqual(errors, [], 'в браузере нет ошибок');
    console.log('Вход владельца: UI сценарии пройдены.');
  } finally {
    await browser?.close().catch(() => {});
    vite.kill('SIGTERM');
    if (vite.exitCode === null) await new Promise<void>(resolve => vite.once('exit', () => resolve()));
    viteLog.end();
  }
}

void run().catch(error => { console.error(error); process.exitCode = 1; });
