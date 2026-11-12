import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { build } from 'esbuild';
import { createServer, type ViteDevServer } from 'vite';
import { _electron, type ElectronApplication, type Page } from 'playwright-core';

let complete = false;
process.on('exit', () => { if (!complete) process.exitCode = 1; });
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let passed = 0;
const check = (name: string, value: unknown) => {
  assert.ok(value, name); passed++; console.log(`✓ ${name}`);
};
async function freePort() {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}
async function stop(child?: ChildProcess) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    // На Windows SIGTERM не вызывает обработчик фикстуры, поэтому завершаем
    // только её собственное дерево вместе с дочерним server.ts.
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    await new Promise(resolve => killer.once('exit', resolve));
    return;
  }
  child.kill();
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), pause(5000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
}
async function main() {
  const missing = ['dist/index.html', 'dist/modules/_shell/index.html', 'dist/modules/_shell/flux.css'].filter(file => !existsSync(file));
  const supported = process.platform === 'win32'
    || (process.platform === 'linux' && process.env.FLUX_CHROME && process.env.DISPLAY);
  if (!supported || missing.length) {
    console.log(`FLUX_VERIFY_SKIP: ${!supported ? 'нужны Windows либо Linux с FLUX_CHROME и DISPLAY'
      : `отсутствуют файлы сборки: ${missing.join(', ')}`}`);
    complete = true;
    return;
  }
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-modules-full-'));
  const shots = path.resolve(process.env.FLUX_MODULE_SHOTS || path.join(temp, 'shots'));
  await fs.mkdir(shots, { recursive: true });
  let fixture: ChildProcess | undefined;
  let vite: ViteDevServer | undefined;
  let electron: ElectronApplication | undefined;
  let page: Page | undefined;
  let fixturePath = '';
  const errors: string[] = [];
  try {
    const apiPort = await freePort();
    const apiBase = `http://127.0.0.1:${apiPort}`;
    fixture = spawn(process.execPath, ['--import', 'tsx', 'scripts/test-guide-server.ts', '--fixture'], {
      env: { ...process.env, FLUX_API: '', FLUX_API_PORT: String(apiPort), NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    fixture.stdout!.on('data', part => {
      const match = String(part).match(/Private synthetic credentials: (.+)/);
      if (match) fixturePath = match[1].trim();
    });
    fixture.stderr!.on('data', part => process.stderr.write(String(part).slice(0, 1000)));
    const deadline = Date.now() + 60000;
    while (!fixturePath && Date.now() < deadline) {
      if (fixture.exitCode !== null) throw new Error(`Сервер фикстуры завершился: ${fixture.exitCode}`);
      await pause(100);
    }
    assert.ok(fixturePath, 'Фикстура должна объявить приватный файл учётных данных');
    const creds = JSON.parse(await fs.readFile(fixturePath, 'utf8'));
    // Образец — установленная программа (подписанный выпуск в кэше главного процесса), а не встроенная
    const { installSampleProgram } = await import('./fixtures/installedSample');
    const sample = await installSampleProgram(path.join(temp, 'programs'), String(creds.admin.id));
    const uiPort = await freePort();
    // Проксируются настоящие HTTP/WebSocket, а не ответы приложения:
    // события и права проходят через server.ts и одноразовую SQLite.
    vite = await createServer({
      server: {
        host: '127.0.0.1', port: uiPort, strictPort: true, hmr: false, watch: null,
        proxy: Object.fromEntries(['/api', '/socket.io'].map(prefix => [prefix, {
          target: apiBase, changeOrigin: true, ws: prefix === '/socket.io',
          headers: { origin: apiBase, referer: `${apiBase}/` },
        }])),
      },
    });
    await vite.listen();
    await build({
      entryPoints: ['scripts/fixtures/modules-flux-main.ts'], bundle: true, platform: 'node',
      format: 'cjs', external: ['electron'], outfile: path.join(temp, 'main.cjs'),
    });
    electron = await _electron.launch({
      args: [...(process.platform === 'linux' ? ['--no-sandbox'] : []), path.join(temp, 'main.cjs')],
      env: { ...process.env, FLUX_MODULE_FLUX_URL: `http://127.0.0.1:${uiPort}`, FLUX_MODULE_FLUX_DATA: temp, FLUX_TEST_ROOT: sample.rootHex }, timeout: 60000,
    });
    page = await electron.firstWindow();
    await page.addInitScript('globalThis.__name = (fn) => fn');
    await page.evaluate('globalThis.__name = (fn) => fn');
    await page.setViewportSize({ width: 1440, height: 900 });
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.locator('input').nth(0).fill(creds.admin.symbol);
    await page.locator('input').nth(1).fill(creds.admin.password);
    await page.keyboard.press('Enter');
    await page.locator('[data-taskbar]').waitFor({ timeout: 45000 });
    check('полный Flux: обычный вход открывает рабочий стол', true);
    const project = await page.evaluate(async (id) => {
      const projects = await (await fetch('/api/projects')).json();
      const value = projects.projects.find((item: any) => item.id === id);
      const user = JSON.parse(localStorage.getItem('pdm_session_user')!);
      localStorage.setItem(`max_active_project_${user.id}`, JSON.stringify(value));
      return value;
    }, creds.projectId);
    assert.ok(project);
    await page.reload();
    await page.locator('[data-taskbar]').waitFor();
    // Окну без нативного моста `modules:state` не у кого спросить, что установлено: подаём то самое состояние,
    // которое главный процесс отдаёт после установки; дальше «Пуск», карточки и кадр работают как у установленной программы.
    // Фоновая сверка Store без моста сбрасывает это состояние, поэтому подача повторяется перед каждым открытием
    const installedState = { ok: true, userId: String(creds.admin.id), channels: ['production'], installed: {}, available: [], fallbacks: {},
      runnable: [{ version: sample.manifest.version, channel: 'production', manifest: sample.manifest }] };
    const showInstalled = () => page!.evaluate(async (local) => {
      const url = '/src/store/moduleStoreState.ts';
      const { useModuleStore } = await import(/* @vite-ignore */ url);
      const store = useModuleStore.getState();
      for (let i = 0; i < 100 && !useModuleStore.getState().loaded; i++) await new Promise(resolve => setTimeout(resolve, 100));
      store.setLocal(local as never);
    }, installedState);
    await showInstalled();
    const seed = await page.evaluate(async ({ projectId, systemId }) => {
      const systems = await (await fetch(`/api/projects/${projectId}/systems`)).json();
      const equipment = systems.systems.find((system: any) => system.id === systemId)
        .monoblocks.flatMap((block: any) => block.components).find((item: any) => item.name === 'FAN_HIGH');
      const response = await fetch(`/api/projects/${projectId}/tags`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: 'STUDIO-FAN-01' }),
      });
      if (!response.ok) throw new Error(`Создание синтетического тега: ${response.status}`);
      const { tag } = await response.json();
      const linked = await fetch(`/api/components/${equipment.id}/tags/${tag.id}`, { method: 'POST' });
      if (!linked.ok) throw new Error(`Связь синтетического тега: ${linked.status}`);
      return { equipmentId: equipment.id, tagId: tag.id };
    }, creds);
    const active = () => page!.locator('.fx-win[data-active="true"]');
    const frame = () => page!.frameLocator('iframe[data-testid="flux-module-frame"]');
    const openStart = async () => {
      await page!.getByRole('button', { name: 'Пуск', exact: true }).click();
      return page!.getByRole('dialog', { name: 'Пуск', exact: true });
    };
    const openProgram = async (name: string) => {
      await showInstalled();
      const menu = await openStart();
      await menu.locator('input').fill(name);
      await menu.getByRole('button', { name, exact: true }).first().click();
    };
    const closeModule = async () => active().getByRole('button', { name: 'Закрыть', exact: true }).click();
    await openProgram('Параметры позиции');
    await page.locator('iframe[data-testid="flux-module-frame"]').waitFor();
    await frame().getByText('Откройте модуль из карточки оборудования или тега.', { exact: true }).waitFor();
    check('модуль открывается из настоящего Пуска', true);
    await closeModule();

    for (const theme of ['light', 'dark']) {
      const menu = await openStart();
      const switcher = menu.getByTitle(theme === 'dark' ? 'Тёмная тема' : 'Светлая тема', { exact: true });
      if (await switcher.count()) await switcher.click();
      await page.keyboard.press('Escape');
      await openProgram('Оборудование');
      await page.evaluate((id) => { location.hash = `/equipment?element=${id}`; }, seed.equipmentId);
      const card = page.getByTestId(`equipment-selected-${seed.equipmentId}`);
      await card.waitFor();
      const launch = card.getByRole('button', { name: 'Параметры позиции', exact: true });
      const measures = await launch.evaluate(button => {
        const bounds = button.getBoundingClientRect();
        const style = getComputedStyle(button);
        const wrap = getComputedStyle(button.parentElement!.parentElement!);
        return { height: bounds.height, font: style.fontSize, weight: style.fontWeight,
          padding: wrap.paddingTop, shrink: wrap.flexShrink };
      });
      console.log(`${theme} карточка позиции: ${JSON.stringify(measures)}`);
      check(`${theme}: кнопка позиции и отступы по методологии`,
        measures.height >= 28 && measures.height <= 36 && parseFloat(measures.font) >= 12
        && ['400', '500', '600'].includes(measures.weight)
        && measures.padding === '6px' && measures.shrink === '0');
      await page.screenshot({ path: path.join(shots, `flux-equipment-${theme}.png`) });
      await launch.click();
      await page.locator('iframe[data-testid="flux-module-frame"]').waitFor();
      await frame().getByText('1200', { exact: true }).waitFor();
      check(`${theme}: карточка позиции открывает действующий модуль`,
        await frame().getByText('FAN_HIGH', { exact: true }).count() === 2);
      await page.screenshot({ path: path.join(shots, `flux-module-${theme}.png`) });
      await closeModule();
      await openProgram('Теги');
      await active().getByRole('tab', { name: 'Спецификация' }).click();
      await active().getByText('STUDIO-FAN-01', { exact: true }).click({ modifiers: ['Control'] });
      await page.evaluate(() => getSelection()?.removeAllRanges());
      await active().getByRole('button', { name: 'Изменить тег', exact: true }).click();
      const tagCard = page.getByRole('dialog', { name: 'Тег STUDIO-FAN-01', exact: true });
      await tagCard.waitFor();
      // Замеряется законченная геометрия, а не уменьшенный первый кадр входа.
      await tagCard.evaluate(node => Promise.all(node.getAnimations({ subtree: true })
        .filter(animation => animation.effect?.getTiming().iterations !== Infinity)
        .map(animation => animation.finished.catch(() => {}))));
      const tagLaunch = tagCard.getByRole('button', { name: 'Параметры позиции', exact: true });
      const tagSize = await tagLaunch.evaluate(button => {
        const style = getComputedStyle(button);
        return { height: button.getBoundingClientRect().height, font: parseFloat(style.fontSize), weight: style.fontWeight };
      });
      console.log(`${theme} карточка тега: ${JSON.stringify(tagSize)}`);
      check(`${theme}: кнопка тега по методологии`, tagSize.height >= 28 && tagSize.height <= 36
        && tagSize.font >= 12 && ['400', '500', '600'].includes(tagSize.weight));
      await page.screenshot({ path: path.join(shots, `flux-tag-${theme}.png`) });
      await tagLaunch.click();
      await page.locator('iframe[data-testid="flux-module-frame"]').waitFor();
      await frame().getByText('1200', { exact: true }).waitFor();
      check(`${theme}: карточка тега открывает связанную позицию`,
        await frame().getByText('STUDIO-FAN-01', { exact: true }).count() === 1);
      await closeModule();
      await tagCard.getByRole('button', { name: 'Готово', exact: true }).click();
    }
    check('полный клиент и модуль: нет ошибок pageerror/console.error', errors.length === 0);
    console.log(`${passed} проверок пройдено; снимки: ${shots}`);
    complete = true;
  } catch (error) {
    await page?.screenshot({ path: path.join(shots, 'flux-failure.png') }).catch(() => {});
    console.error('Диагностика полного Flux:', JSON.stringify({ errors, url: page?.url(),
      text: (await page?.locator('body').innerText().catch(() => ''))?.slice(-1800) }));
    throw error;
  } finally {
    await electron?.close().catch(() => {});
    await vite?.close();
    await stop(fixture);
    if (fixturePath) await fs.rm(path.dirname(fixturePath), { recursive: true, force: true, maxRetries: 3 });
    await fs.rm(temp, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
