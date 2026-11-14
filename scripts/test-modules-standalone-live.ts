import { verifySkip } from './verifySkip';
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
    verifySkip(`${!supported ? 'нужны Windows либо Linux с FLUX_CHROME и DISPLAY'
      : `отсутствуют файлы сборки: ${missing.join(', ')}`}`);
    complete = true;
    return;
  }
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-standalone-live-'));
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
    // Самостоятельная программа — установленная (подписанный выпуск в кэше главного процесса): ничего не читает во Flux, открывается из «Пуска»
    const { installStandaloneProgram } = await import('./fixtures/installedStandalone');
    const sample = await installStandaloneProgram(path.join(temp, 'programs'), String(creds.admin.id));
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
    // Прогрев адреса Vite до запуска Electron: первый запрос на Windows CI отвечал долго или отказом
    const warmUrl = `http://127.0.0.1:${uiPort}/`;
    let warmed = false;
    for (let attempt = 1; attempt <= 10 && !warmed; attempt++) {
      try {
        const response = await fetch(warmUrl, { signal: AbortSignal.timeout(15000) });
        await response.text();
        warmed = response.ok;
        process.stderr.write(`FLUX_LOAD_WARMUP ${JSON.stringify({ attempt, status: response.status })}\n`);
      } catch (error) {
        process.stderr.write(`FLUX_LOAD_WARMUP ${JSON.stringify({ attempt, error: String((error as Error)?.message || error) })}\n`);
        await pause(500);
      }
    }
    electron = await _electron.launch({
      args: [...(process.platform === 'linux' ? ['--no-sandbox'] : []), path.join(temp, 'main.cjs')],
      env: { ...process.env, FLUX_MODULE_FLUX_URL: `http://127.0.0.1:${uiPort}`, FLUX_MODULE_FLUX_DATA: temp, FLUX_TEST_ROOT: sample.rootHex }, timeout: 60000,
    });
    // Причину незагрузившегося окна сообщает только главный процесс (scripts/fixtures/modules-flux-main.ts)
    electron.process().stderr?.on('data', part => { const text = String(part); if (text.includes('FLUX_LOAD_')) process.stderr.write(text.slice(0, 1000)); });
    page = await electron.firstWindow();
    await page.addInitScript('globalThis.__name = (fn) => fn');
    await page.evaluate('globalThis.__name = (fn) => fn');
    await page.setViewportSize({ width: 1440, height: 900 });
    // Окно берёт экраны у сервера разработки, и каждый экран при первом открытии собирается на лету. На Windows CI вход
    // (строка fill), перезагрузка и первый показ «Оборудования» падали по пределу 15 с: по журналу страница сообщала
    // FLUX_LOAD_OK меньше чем за секунду до истечения предела. Предел ожидания — с запасом на холодную сборку экрана.
    page.setDefaultTimeout(60000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.locator('input').nth(0).fill(creds.admin.symbol);
    await page.locator('input').nth(1).fill(creds.admin.password);
    await page.keyboard.press('Enter');
    await page.locator('[data-taskbar]').waitFor({ timeout: 45000 });
    check('полный Flux: обычный вход открывает рабочий стол', true);
    // Проекта нет: после входа Flux не выбирает его сам, а выбранный раньше (localStorage) здесь убран. Это и проверяется:
    // самостоятельная программа открывается без activeProject
    const noProject = await page.evaluate(async () => {
      const user = JSON.parse(localStorage.getItem('pdm_session_user')!);
      localStorage.removeItem(`max_active_project_${user.id}`);
      return user.id as string;
    });
    await page.reload();
    await page.locator('[data-taskbar]').waitFor();
    const activeProject = () => page!.evaluate(async () => {
      const url = '/src/store/store.ts';
      const { useStore } = await import(/* @vite-ignore */ url);
      return useStore.getState().activeProject;
    });
    check('проект не выбран (activeProject пуст)', (await activeProject()) === null && !!noProject);
    // Окну без нативного моста `modules:state` не у кого спросить, что установлено: подаём то самое состояние,
    // которое главный процесс отдаёт после установки (как в test-modules-flux-ui-live). Подача повторяется перед каждым открытием
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

    for (const theme of ['light', 'dark']) {
      const menu = await openStart();
      const switcher = menu.getByTitle(theme === 'dark' ? 'Тёмная тема' : 'Светлая тема', { exact: true });
      if (await switcher.count()) await switcher.click();
      await page.keyboard.press('Escape');
      await openProgram('Быстрые заметки');
      await page.locator('iframe[data-testid="flux-module-frame"]').waitFor();
      await frame().locator('body[data-ready="1"]').waitFor();
      check(`${theme}: без проекта программа открывается из настоящего «Пуска» и отвечает`, await frame().locator('#t').innerText() === 'Быстрые заметки');
      check(`${theme}: страница видит, что проекта нет (flux.context.projectId пуст)`, await frame().locator('#project').innerText() === 'Проект не выбран');
      check(`${theme}: проект после открытия по-прежнему не выбран`, (await activeProject()) === null);
      // Состояние общее для окон программы и живёт, пока открыт Flux: во втором проходе счётчик продолжается с первого
      const before = Number(await frame().locator('#n').innerText());
      await frame().locator('#add').click();
      await frame().locator('#n').filter({ hasText: String(before + 1) }).waitFor();
      check(`${theme}: состояние сохраняется (flux.state) без проекта: ${before} → ${before + 1}`, Number(await frame().locator('#n').innerText()) === before + 1 && before === (theme === 'light' ? 0 : 1));
      // Замер заголовка окна: название программы, без плашки «Разработка», версия справа
      const head = await active().locator('.fx-head').evaluate(node => { const t = node.querySelector('.fx-head-title')!; return { title: t.textContent, font: parseFloat(getComputedStyle(t).fontSize), weight: getComputedStyle(t).fontWeight, overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth }; });
      check(`${theme}: заголовок окна «${head.title}», шрифт и вес по методологии, горизонтальной прокрутки нет`, head.title === 'Быстрые заметки' && head.font >= 12 && ['400', '500', '600'].includes(head.weight) && head.overflowX <= 0);
      await page.screenshot({ path: path.join(shots, `flux-standalone-no-project-${theme}.png`) });
      await closeModule();
    }
    check('полный клиент и самостоятельная программа: нет ошибок pageerror/console.error', errors.length === 0);
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
