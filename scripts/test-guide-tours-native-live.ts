/** Full-app Guide tour smoke on a disposable SQLite fixture (never a user DB). */
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const cwd = process.cwd();
const chrome = process.env.FLUX_CHROME || '/usr/bin/chromium';
let fixture: ChildProcess | null = null;
let vite: ChildProcess | null = null;
let fixturePath = '';
let failures = 0;
const check = (name: string, condition: unknown, extra?: unknown) => {
  if (condition) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`, extra ?? ''); }
};
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve loopback port');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function launch(command: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr?.on('data', (chunk) => process.stderr.write(String(chunk).slice(0, 300)));
  return child;
}

async function waitForFixture(child: ChildProcess, port: number) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Fixture server exited (${child.exitCode})`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch { /* booting */ }
    await delay(250);
  }
  throw new Error('Disposable fixture server did not start');
}

async function waitForVite(child: ChildProcess, port: number) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Vite exited (${child.exitCode})`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      if (response.ok) return;
    } catch { /* booting */ }
    await delay(250);
  }
  throw new Error('Vite did not start');
}

async function stop(child: ChildProcess | null) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise<void>((resolve) => child.once('exit', () => resolve())), delay(7000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function main() {
  const apiPort = Number(process.env.FLUX_API_PORT || await freePort());
  const uiPort = Number(process.env.FLUX_TOUR_UI_PORT || await freePort());
  let fixtureOutput = '';
  try {
    fixture = launch(process.execPath, ['--import', 'tsx', 'scripts/test-guide-server.ts', '--fixture'], {
      ...process.env,
      FLUX_API: '',
      FLUX_API_PORT: String(apiPort),
      NODE_ENV: 'test',
    });
    fixture.stdout?.on('data', (chunk) => {
      const text = String(chunk);
      fixtureOutput += text;
      const match = text.match(/Private synthetic credentials: (.+)/);
      if (match) fixturePath = match[1].trim();
      process.stdout.write(text);
    });
    await waitForFixture(fixture, apiPort);
    const fixtureDeadline = Date.now() + 10000;
    while (!fixturePath && Date.now() < fixtureDeadline) await delay(50);
    if (!fixturePath) throw new Error(`Fixture credentials path was not announced: ${fixtureOutput}`);
    const creds = JSON.parse(await readFile(fixturePath, 'utf8')) as {
      baseUrl: string; admin: { symbol: string; password: string }; projectId: string;
    };

    vite = launch(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], {
      ...process.env,
      DISABLE_HMR: 'true',
    });
    await waitForVite(vite, uiPort);

    const { chromium } = await import('playwright-core');
    const browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const pageErrors: string[] = [];
    const apiResponses: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('response', (response) => {
      if (new URL(response.url()).pathname.startsWith('/api/')) apiResponses.push(`${response.status()} ${new URL(response.url()).pathname}`);
    });
    const writes: string[] = [];
    await page.route('**/api/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) writes.push(`${request.method()} ${url.pathname}`);
      const response = await route.fetch({
        url: `${creds.baseUrl}${url.pathname}${url.search}`,
        method: request.method(),
        headers: { ...request.headers(), origin: creds.baseUrl, referer: `${creds.baseUrl}/` },
        postData: request.postData() ?? undefined,
        timeout: 15000,
      });
      await route.fulfill({ response });
    });

    try {
      await page.goto(`http://127.0.0.1:${uiPort}/`, { waitUntil: 'domcontentloaded' });
      await page.locator('input').nth(0).fill(creds.admin.symbol);
      await page.locator('input').nth(1).fill(creds.admin.password);
      await page.keyboard.press('Enter');
      try {
        await page.locator('[data-taskbar]').waitFor({ timeout: 30000 });
      } catch (error) {
        await page.screenshot({ path: '/tmp/flux-guide-tours-native-failure.png', fullPage: true }).catch(() => {});
        console.error('Login diagnostic:', JSON.stringify({ url: page.url(), body: (await page.locator('body').innerText()).slice(0, 900), apiResponses, pageErrors }, null, 2));
        throw error;
      }
      check('вход и рабочий стол проходят через полный клиент', await page.locator('[data-taskbar]').count() > 0);

      const activeUser = await page.evaluate(() => JSON.parse(localStorage.getItem('pdm_session_user') || 'null'));
      const projectsResponse = await page.evaluate(async () => {
        const r = await fetch('/api/projects'); return r.json();
      });
      const project = Array.isArray(projectsResponse) ? projectsResponse[0] : projectsResponse?.projects?.[0];
      check('в disposable fixture выбран синтетический проект', !!activeUser && project?.id === creds.projectId, project?.id);
      if (activeUser && project) {
        await page.evaluate(({ userId, value }) => localStorage.setItem(`max_active_project_${userId}`, JSON.stringify(value)), { userId: activeUser.id, value: project });
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.locator('[data-taskbar]').waitFor({ timeout: 30000 });
      }

      // Run the same production action used by HandbookArticleView; navigation,
      // routes, target discovery and spotlight controls are all live components.
      const startTour = async (id: string) => page.evaluate(async (tourId) => {
        const modulePath = '/src/guide/store.ts';
        const mod = await import(modulePath);
        mod.useGuideStore.getState().startTour(tourId);
      }, id);
      const activeStep = () => page.locator('body').getByText(/Flux Guide · шаг/).last();

      await startTour('add-tag');
      await page.waitForTimeout(1200);
      check('демонстрация тега открывает реальный маршрут и видимую цель', /registry/.test(await page.evaluate(() => location.hash)) && await page.locator('[data-tour="tag-code-input"]').isVisible());
      const skip = page.getByTitle('Пропустить шаг');
      await skip.click();
      await page.waitForTimeout(500);
      check('пропуск шага приводит к полю тега, не к записи', await page.locator('[data-tour="tag-code-input"]').isVisible() && await page.getByRole('button', { name: 'Создать', exact: true }).count() > 0);
      await page.getByTitle('Назад').click();
      check('Назад возвращает шаг и маршрут без записи', (await activeStep().innerText()).includes('шаг 1/4'));
      await page.getByTitle('Пауза').click();
      check('пауза видна в самой подсказке', await page.getByText('Демонстрация приостановлена.').isVisible());
      await page.getByTitle('Продолжить').click();
      await page.getByTitle('Завершить демонстрацию').click();
      check('отмена закрывает карточку подсказки', await page.getByText(/Flux Guide · шаг/).count() === 0);

      await startTour('create-project');
      await page.waitForTimeout(1200);
      check('демонстрация проекта открывает маршрут проектов', /projects/.test(await page.evaluate(() => location.hash)) && await page.locator('[data-tour="project-create-btn"]').isVisible());
      await page.getByTitle('Пропустить шаг').click();
      await page.waitForTimeout(600);
      check('шаг создания проекта доступен в клиенте', await page.locator('[data-tour="project-create-btn"]').isVisible());
      await page.locator('[data-tour="project-create-btn"]').click();
      const dialog = page.locator('[role="dialog"][aria-label="Новый проект"]');
      check('по кнопке цели открывается настоящее диалоговое окно проекта', await dialog.isVisible());
      await page.keyboard.press('Escape');
      await page.getByTitle('Завершить демонстрацию').click();
      check('диалог проекта отменён без создания записи', await dialog.count() === 0);

      await startTour('import-blank-preview');
      await page.waitForTimeout(1000);
      check('ветка импорта ведёт в Проводник и показывает реальную цель', /explorer/.test(await page.evaluate(() => location.hash)) && await page.locator('[data-tour="nav-/explorer"]').first().isVisible());
      await page.getByTitle('Пропустить шаг').click();
      await page.waitForTimeout(500);
      check('импортный сценарий показывает шаг предпросмотра без запуска записи', await page.getByText(/откроется предпросмотр: дерево установок/).isVisible() && await page.getByText('Подтвердить импорт', { exact: true }).count() === 0);
      await page.getByTitle('Завершить демонстрацию').click();

      const projectsAfter = await page.evaluate(async () => {
        const r = await fetch('/api/projects'); const j = await r.json(); return Array.isArray(j) ? j.length : j?.projects?.length;
      });
      check('единственная запись API — вход; демонстрации не меняли данные', writes.every((entry) => entry === 'POST /api/login') && projectsAfter === 1, writes);
      check('браузерный сценарий завершился без исключений приложения', pageErrors.length === 0, pageErrors.slice(0, 5));
    } finally {
      await browser.close();
    }
  } finally {
    await stop(vite);
    await stop(fixture);
    if (fixturePath) await rm(path.dirname(fixturePath), { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} smoke checks failed.` : '\nFull-app Guide tour smoke passed.');
  process.exitCode = failures ? 1 : 0;
}

main().catch((error) => {
  console.error('Full-app Guide tour smoke could not complete:', error?.stack || error);
  process.exitCode = 1;
}).finally(() => {
  void stop(vite);
  void stop(fixture);
});
