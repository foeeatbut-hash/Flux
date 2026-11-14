/**
 * Полный запуск программы в Studio, окно целиком, в браузере и в обеих темах (этап 2, пункт б).
 *
 * Окно Studio собрано по-настоящему, служба разработчика (studio/shell/developer.ts) — настоящая целиком: проект, запуск, тестовая
 * база, runtime.js, подключения (runConnect и вопрос событием onRun — к настоящему локальному HTTP-серверу), вторая программа
 * (настоящий черновик на TypeScript, поставленный в тестовую базу), сохранение файла (файл реально записан). Программа открывается
 * в настоящем <iframe sandbox> с настоящим мостом (modules/bridge.ts) — только адрес http://127.0.0.1 вместо flux-module://,
 * которой Chromium без Electron не знает. ЗАГЛУШКА — только системный диалог сохранения (pickSaveFile) и снимок экрана (capture).
 * Окна программы живут в основной области окна проекта (вкладка «Запуск» рядом с файлами), в нижней панели — выбор, кнопки, журнал.
 *
 * Что проверяется: окна в основной области, целиком и в своём размере, переход к файлу и обратно без перезагрузки кадров; два окна программы и обмен между ними (но не себе), заголовок «Программа — заголовок», размер из
 * параметров, параметры окна, диалог программы в своём окне (чужое окно работает), «Закрыть без сохранения?», предел числа
 * окон, «Программа не отвечает» и перезапуск, подключение (три ответа и тексты Flux, строка журнала, подсказка про
 * администратора), вызов второй программы (NOT_INSTALLED → поставить → ответ → убрать), сохранение файла, обе темы.
 *
 * Запуск: FLUX_CHROME=... npx tsx scripts/test-studio-run-ui.ts   (без Chromium набор печатает FLUX_VERIFY_SKIP)
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { chromium, type Page } from 'playwright-core';
import { createControlsEngine } from '../studio/shared/controlsEngine';
import { createTsBuilder } from '../studio/shared/tsBuildHost';
import { DeveloperService } from '../studio/shell/developer';
import { findChromeOrUndefined } from './chromePath';
import { verifySkip } from './verifySkip';
import { WINDOW_LIMITS } from '../modules/page/model';
import { languageFiles } from './fixtures/moduleLanguages';
import { DEFAULT_MAIN } from '../studio/renderer/sections/run/model';
import { CHOICES, PROMPT_LABEL, REMEMBER_STUDIO, promptTitle } from '../src/components/modules/connectionPromptText';

const { buildStudio } = require('../studio/build.cjs');
let passed = 0;
const ok = (name: string, value: unknown) => { assert.ok(value, name); passed++; console.log(`  ✓ ${name}`); };
const shots = process.env.FLUX_STUDIO_SHOTS || path.join(os.tmpdir(), 'flux-studio-shots');

const luminance = (rgb: number[]) => { const [r, g, b] = rgb.map(v => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a: number[], b: number[]) => { const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };

/** Фон сплошной, нет горизонтальной прокрутки, у полей есть подписи, текст не мельче 12 px, контраст — в обеих темах */
async function measure(page: Page, label: string) {
  const info = await page.evaluate(`(() => {
    const rgb = css => { const c = document.createElement('canvas').getContext('2d'); c.clearRect(0, 0, 1, 1); c.fillStyle = css; c.fillRect(0, 0, 1, 1); const d = c.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
    const body = getComputedStyle(document.body);
    const text = e => [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    return { bg: rgb(body.backgroundColor), color: rgb(body.color), overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      unlabeled: [...document.querySelectorAll('main input:not([type=checkbox]), main select, main textarea')].filter(i => !i.labels?.length && !i.getAttribute('aria-label')).length,
      small: [...document.querySelectorAll('main *')].filter(e => text(e) && parseFloat(getComputedStyle(e).fontSize) < 12).map(e => e.outerHTML.slice(0, 100)) };
  })()`) as { bg: number[]; color: number[]; overflowX: number; unlabeled: number; small: string[] };
  if (info.small.length) console.log(info.small);
  ok(`${label}: фон сплошной, нет горизонтальной прокрутки, поля подписаны, текст не мельче 12 px`, info.bg[3] === 1 && info.overflowX <= 0 && info.unlabeled === 0 && info.small.length === 0);
  ok(`${label}: контраст текста не ниже 4.5:1`, contrast(info.color.slice(0, 3), info.bg.slice(0, 3)) >= 4.5);
}

/** Четыре объявления подключения к одному серверу: у каждого своё решение человека (память «всегда»/«никогда» — по объявлению) */
const CONNECTIONS = ['api', 'once', 'always', 'esc'];
const manifestPatch = (port: number) => ({
  contractVersion: 3,
  pages: ['detail.html'],
  connections: CONNECTIONS.map(id => ({ id, kind: 'http', url: `http://127.0.0.1:${port}`, pathPrefix: '/api', app: 'Сервер расчётов', does: `Отправляет на сервер расчётов номер проекта и получает ответ (${id})`, access: 'send' })),
  permissions: [{ kind: 'program', program: 'helper', does: 'Удваивает число у программы-помощника' }],
});
const PAGE = (extra: string) => `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Окна</title><link rel="stylesheet" href="/_flux/flux-ui.v1.css"></head>
<body><main class="fx-body fx-stack"><h1 class="fx-title">Окна</h1><div class="fx-row">${extra}</div><p id="status" role="status"></p><ul id="got" aria-label="Сообщения"></ul></main>
<script src="/_flux/flux.v1.js"></script><script src="/ui/app.js"></script></body></html>`;
const BTN = (id: string, text: string) => `<button id="${id}" class="fx-btn" type="button">${text}</button>`;
const INDEX = PAGE([['open', 'Открыть строку'], ['many', 'Открыть много'], ['send', 'Сказать окнам'], ['title', 'Заголовок'], ['title2', 'Другой заголовок'], ...CONNECTIONS.map(id => [`connect-${id}`, `Подключиться ${id}`]), ['program', 'Вызвать помощника'], ['save', 'Сохранить файл'], ['confirm', 'Спросить']].map(([id, t]) => BTN(id, t)).join(''));
const DETAIL = PAGE([['reply', 'Ответить'], ['title', 'Заголовок'], ['dirty', 'Есть правки'], ['clean', 'Правок нет'], ['confirm', 'Спросить'], ['prompt', 'Назвать']].map(([id, t]) => BTN(id, t)).join(''));
const APP = `const $ = id => document.getElementById(id), say = text => { $('status').textContent = text; };
const bind = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', () => { Promise.resolve().then(fn).catch(e => say('ошибка ' + (e.code || e.message))); }); };
flux.windows.onMessage(data => { const li = document.createElement('li'); li.textContent = JSON.stringify(data); $('got').append(li); });
bind('open', () => flux.windows.open('detail.html', { row: 5 }, { title: 'Строка 5', width: 420, height: 300 }).then(() => say('открыто')));
bind('many', async () => { let n = 0; try { for (let i = 0; i < 8; i++) { await flux.windows.open('detail.html', { row: i }, { width: 320, height: 240 }); n++; } } catch (e) { say('открыто ' + n + ', отказ ' + e.code); return; } say('открыто ' + n); });
bind('send', () => flux.windows.send({ from: 'main' }));
bind('reply', () => flux.windows.send({ from: 'detail' }));
bind('title', () => flux.window.setTitle($('open') ? 'Главное 1' : 'Деталь'));
bind('title2', () => flux.window.setTitle('Главное 2'));
bind('dirty', () => flux.window.setUnsaved(true, 'Есть правки таблицы'));
bind('clean', () => flux.window.setUnsaved(false));
bind('confirm', async () => say('confirm ' + await flux.dialogs.confirm({ title: 'Удалить строку?', text: 'Строка 5 исчезнет', ok: 'Удалить', cancel: 'Оставить', danger: true })));
bind('prompt', async () => say('prompt ' + await flux.dialogs.prompt({ title: 'Имя', label: 'Название', value: 'Строка' })));
for (const id of ${JSON.stringify(CONNECTIONS)}) bind('connect-' + id, async () => { const r = await flux.connect.call(id, { op: 'http', method: 'POST', path: '/api/x', body: '{}' }); say(id + ': ' + JSON.stringify(r)); });
bind('program', async () => { const r = await flux.programs.call('helper', 'double', { n: 21 }); say('программа ' + JSON.stringify(r)); });
bind('save', async () => say('файл ' + await flux.saveFile('a.csv', 'a;b', 'text/csv')));
flux.ready.then(() => say('готово'));
`;

async function main() {
  const chrome = findChromeOrUndefined();
  if (!chrome) { verifySkip('нет Chromium/Chrome (FLUX_CHROME)'); return; }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-studio-run-ui-'));
  fs.mkdirSync(shots, { recursive: true });
  const built = await buildStudio({ target: 'developer', outDir: path.join(temp, 'developer') });
  const renderer = path.join(built.app, 'renderer');
  const indexFile = path.join(renderer, 'index.html');
  fs.writeFileSync(indexFile, fs.readFileSync(indexFile, 'utf8').replace('frame-src flux-module:', 'frame-src flux-module: http://127.0.0.1:*'));

  const data = path.join(temp, 'data');
  const storage = { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s).reverse(), decryptString: (b: Buffer) => Buffer.from(b).reverse().toString() };
  // Настоящий локальный сервер, к которому подключается программа; hits — сколько обращений дошло до него
  let hits = 0;
  const api = http.createServer((q, r) => { hits++; r.writeHead(200, { 'content-type': 'application/json' }); r.end(JSON.stringify({ path: q.url })); });
  await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
  const apiPort = (api.address() as any).port as number;
  // Служба своя на каждую тему: решения человека о подключении хранятся в памяти службы, как в Studio до её закрытия.
  // События службы (вопрос о подключении) уходят в окно текущей страницы, как это делает Electron
  const sink = { page: null as Page | null, events: [] as Array<{ ch: string; data: any }>, saveDialogs: [] as Array<{ title: string; defaultName: string }>, saveDir: '' };
  const makeService = () => new DeveloperService({
    dir: data, storage, version: '1.0.0', session: () => ({ origin: 'http://127.0.0.1:1', token: 'token-dev-long-enough', user: { id: 'dev', name: 'Разработчик' }, owner: false }),
    assets: { templatesRoot: path.join(built.app, 'templates'), runtimeDir: path.join(built.app, 'runtime') },
    engine: createControlsEngine({ workerFile: path.join(built.app, 'controls-worker.cjs'), timeoutMs: 5000 }),
    tsBuilder: createTsBuilder({ workerFile: path.join(built.app, 'ts-build-worker.cjs'), wasmFile: path.join(built.app, 'esbuild.wasm'), typesWorkerFile: path.join(built.app, 'ts-type-worker.cjs') }),
    capture: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8]),
    fluxDataDir: () => path.join(temp, 'flux-data'),
    emit: (ch, data) => { sink.events.push({ ch, data }); if (ch === 'studio:run') void sink.page?.evaluate(`window.__runFn && window.__runFn(${JSON.stringify(data)})`).catch(() => undefined); },
    // Системный диалог — единственная заглушка: «человек» выбирает файл в каталоге проверки
    pickSaveFile: async options => { sink.saveDialogs.push(options); return path.join(sink.saveDir, options.defaultName); },
  } as any);
  let service = makeService();
  fs.mkdirSync(path.join(temp, 'flux-data'), { recursive: true });
  const assets = http.createServer((req, res) => {
    const asset = service.asset(`flux-module://run${req.url?.split('#')[0].split('?')[0]}`);
    if (!asset) { res.writeHead(404).end(); return; }
    res.writeHead(asset.status, asset.headers).end(asset.body as any);
  });
  await new Promise<void>(resolve => assets.listen(0, '127.0.0.1', resolve));
  const assetsOrigin = `http://127.0.0.1:${(assets.address() as any).port}`;

  const browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
  try {
    for (const theme of ['light', 'dark'] as const) {
      console.log(theme === 'light' ? 'Светлая тема' : 'Тёмная тема');
      fs.rmSync(path.join(data, 'drafts'), { recursive: true, force: true });
      fs.rmSync(path.join(data, 'projects'), { recursive: true, force: true });
      service = makeService();
      Object.assign(sink, { events: [], saveDialogs: [], saveDir: fs.mkdtempSync(path.join(temp, 'save-')) });
      hits = 0;
      // Вторая программа — настоящий черновик на TypeScript с методом double: ответ даёт её логика, а не стенд
      const helperSource = 'export function compute(input: { export?: string; data: { n: number } }) {\n  return { state: {}, calc: { out: { doubled: input.data.n * 2, by: input.export } } };\n}\n';
      const helperFiles: Record<string, Uint8Array | string> = {};
      for (const [name, bytes] of Object.entries(languageFiles('typescript', { id: 'helper', name: 'Помощник расчётов', exports: [{ method: 'double', does: 'Удваивает целое число из входных данных' }] }, { 'logic/main.ts': helperSource }))) if (!name.startsWith('build/')) helperFiles[name] = bytes;
      service.drafts.create('helper', Object.fromEntries(Object.entries(helperFiles).map(([name, bytes]) => [name, typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes])), { template: 'folder' });
      const page = await browser.newPage({ viewport: { width: 1280, height: 1600 } });
      sink.page = page;
      await page.addInitScript((value: string) => { try { localStorage.setItem('theme', value); } catch { /* приватный режим */ } }, theme);
      const errors: string[] = [];
      page.on('pageerror', e => errors.push(e.message));
      page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
      // Действия окна идут в настоящую службу; ответы человека на вопрос о подключении записываются для проверки
      const answers: string[] = [];
      await page.exposeFunction('__studioCall', async (action: string, args: any) => {
        try {
          if (action === 'state') return { ok: true, value: { version: '1.0.0', build: 'developer', name: 'Flux Studio', owner: false, sections: [], connected: true, display: 'MariaDB / MySQL · db:3306/Flux', warning: '', remembered: '', user: { id: 'dev', name: 'Разработчик' } } };
          if (action === 'modules') return { ok: true, value: [] };
          if (action === 'runConnectAnswer') answers.push(args.decision);
          const value: any = await service.handle(action as any, args || {});
          if (action === 'runStart') value.url = `${assetsOrigin}/ui/index.html`;
          return { ok: true, value };
        } catch (e: any) { return { ok: false, error: String(e?.message || e) }; }
      });
      await page.addInitScript(`window.studio = { onState: () => () => {}, onProgress: () => () => {}, onProject: () => () => {}, onRun: fn => { window.__runFn = fn; return () => { window.__runFn = null; }; }, call: (a, g) => window.__studioCall(a, g) };`);
      // Порог «не отвечает» сокращён адресом: полминуты в наборе не ждём
      await page.goto('file://' + path.join(renderer, 'index.html') + '?hang=6000');
      await page.getByRole('heading', { name: 'Мои программы' }).waitFor();
      await page.getByRole('button', { name: 'Новая программа' }).first().click();
      const dialog = page.getByRole('dialog');
      await dialog.locator('#np-sample').selectOption('none');
      await dialog.locator('#np-lang').selectOption('typescript');
      await dialog.locator('#np-kind').selectOption('page');
      await dialog.getByLabel('Название').fill('Окна');
      await dialog.getByRole('button', { name: 'Создать', exact: true }).click();
      await page.getByRole('toolbar', { name: 'Запуск, проверка, публикация' }).waitFor();
      const projectId = fs.readdirSync(path.join(data, 'projects')).find(name => name !== 'helper')!;
      // Страницы и манифест программы-примера пишет тест: две страницы, подключение, вызов помощника
      const manifestPath = path.join(data, 'projects', projectId, 'manifest.json');
      const manifest = { ...JSON.parse(fs.readFileSync(manifestPath, 'utf8')), ...manifestPatch(apiPort) };
      for (const [file, text] of [['manifest.json', JSON.stringify(manifest, null, 2)], ['ui/index.html', INDEX], ['ui/detail.html', DETAIL], ['ui/app.js', APP]]) await service.handle('draftSave', { id: projectId, path: file, text });

      // «Запустить» сверху сохраняет, запускает и открывает вид «Запуск» в основной области
      await page.getByRole('button', { name: 'Запустить' }).first().click();
      await page.locator('#run-entity').waitFor();
      // При провале шага: что видел человек и что записал журнал
      const dump = async (error: unknown) => { try { await page.screenshot({ path: path.join(shots, `studio-run-${theme}-FAIL.png`), fullPage: true }); console.log('STATUS', await page.frameLocator('[data-testid="studio-module-frame"]').locator('#status').innerText({ timeout: 2000 }).catch(() => '?'), '\nLOG', await page.locator('table.log').innerText({ timeout: 2000 }).catch(() => '?')); } catch { /* страница закрыта */ } throw error; };
      // Кнопки внутри кадров нажимаются событием: окно Studio прокручивается и меняет раскладку при закрытии окон программы,
      // и нажатие по координатам иногда попадало мимо; ответ самой программы проверяется как обычно
      const main = page.frameLocator('[data-testid="studio-module-frame"]');
      await main.locator('#status').filter({ hasText: 'готово' }).waitFor();
      const mainBox = page.locator('[data-window="main"]');
      const titleOf = (key: string) => page.locator(`[data-window="${key}"] [data-testid="program-window-title"]`).innerText();
      const frameOf = (key: string) => page.frameLocator(`[data-window="${key}"] iframe`);
      const child0 = () => page.frames().find(f => f.url().includes('/ui/index.html'))!;
      const status = async (f: ReturnType<typeof frameOf>) => (await f.locator('#status').innerText()).trim();
      const tabs = page.getByRole('tablist', { name: 'Открытые файлы' });
      const runTab = tabs.getByRole('tab', { name: '«Запуск»' });
      const scene = page.getByTestId('run-scene');
      const rect = (selector: string) => page.locator(selector).first().evaluate(el => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), r: Math.round(r.right), b: Math.round(r.bottom) }; });
      /** Окно видно целиком: внутри окна браузера и внутри сцены */
      const whole = async (key: string) => {
        const box = await page.locator(`[data-window="${key}"]`).evaluate(el => { const r = el.getBoundingClientRect(), s = document.querySelector('[data-testid="run-scene"]')!.getBoundingClientRect(); return r.width > 0 && r.left >= s.left - 1 && r.right <= s.right + 1 && r.top >= s.top - 1 && r.bottom <= s.bottom + 1 && r.bottom <= innerHeight && r.right <= innerWidth; });
        return box;
      };

      try {
      // Окна программы — в основной области (у вкладок файлов), а не в нижней панели
      ok(`${theme}: «Запустить» сверху открыло вид «Запуск»: вкладка выбрана, сцена видна`, (await runTab.getAttribute('aria-selected')) === 'true' && await scene.isVisible());
      ok(`${theme}: главное окно лежит в основной области, а не в нижней панели`, (await page.locator('.studio-bottom [data-testid="program-window"]').count()) === 0 && (await scene.locator('[data-window="main"]').count()) === 1);
      const mainRect = await rect('[data-window="main"] iframe');
      // Как во Flux, окно не шире рабочей области: рабочая область Studio — сцена без полей (у Flux — стол без 80 px)
      const room = await scene.evaluate(el => el.clientWidth - 24);
      const wantW = Math.min(DEFAULT_MAIN.width, room);
      ok(`${theme}: главное окно в размере окна Flux по умолчанию ${DEFAULT_MAIN.width} × ${DEFAULT_MAIN.height}, не шире сцены (${wantW} × ${DEFAULT_MAIN.height}; получилось ${mainRect.w} × ${mainRect.h})`, Math.abs(mainRect.w - wantW) <= 2 && Math.abs(mainRect.h - DEFAULT_MAIN.height) <= 2);
      ok(`${theme}: главное окно видно целиком`, await whole('main'));
      ok(`${theme}: в нижней панели остались выбор, «Другие программы», кнопки и журнал`, (await page.locator('.studio-bottom #run-entity').count()) === 1 && (await page.locator('.studio-bottom [data-testid="studio-test-programs"]').count()) === 1
        && (await page.locator('.studio-bottom').getByRole('button', { name: 'Снять обе темы' }).count()) === 1 && (await page.locator('.studio-bottom table.log, .studio-bottom .empty').count()) >= 1);
      // Переход к файлу и обратно не перезагружает кадры: отметка, поставленная в кадре, остаётся
      await child0().evaluate(() => { (window as any).__kept = 'жив'; });
      await page.getByRole('treeitem', { name: /manifest\.json/ }).click();
      await page.getByTestId('file-editor').waitFor();
      ok(`${theme}: у файла своя вкладка, сцена спрятана, но смонтирована`, (await runTab.getAttribute('aria-selected')) === 'false' && !(await scene.isVisible()) && (await scene.locator('iframe').count()) === 1);
      await runTab.click();
      ok(`${theme}: возврат на вкладку «Запуск» — кадр не перезагружался`, await scene.isVisible() && (await child0().evaluate(() => (window as any).__kept)) === 'жив');

      // Два окна, заголовок, размер, параметры
      ok(`${theme}: главное окно названо программой`, (await titleOf('main')) === 'Окна');
      await main.locator('#title').dispatchEvent('click');
      await page.locator('[data-window="main"] [data-testid="program-window-title"]').filter({ hasText: 'Окна — Главное 1' }).waitFor();
      ok(`${theme}: setTitle даёт «Программа — заголовок»`, (await titleOf('main')) === 'Окна — Главное 1');
      await main.locator('#open').dispatchEvent('click');
      const w1 = frameOf('w1');
      await w1.locator('#status').filter({ hasText: 'готово' }).waitFor();
      ok(`${theme}: второе окно открылось с заголовком из параметров «Окна — Строка 5»`, (await titleOf('w1')) === 'Окна — Строка 5');
      const size = await page.locator('[data-window="w1"] iframe').evaluate(el => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; });
      ok(`${theme}: размер окна из параметров 420 × 300 (получилось ${size.w} × ${size.h})`, Math.abs(size.w - 420) <= 2 && Math.abs(size.h - 300) <= 2);
      ok(`${theme}: второе окно тоже в основной области, оба окна видны целиком`, (await scene.locator('[data-window="w1"]').count()) === 1 && await whole('main') && await whole('w1'));
      ok(`${theme}: у второго окна свой кадр и свой мост, оба в изолированных кадрах`, (await page.locator('iframe[sandbox="allow-scripts"]').count()) === 2 && (await page.locator('iframe[src*="detail.html"]').count()) === 1);
      await page.screenshot({ path: path.join(shots, `studio-run-${theme}-1-two-windows.png`), fullPage: true });

      // Обмен: сообщение получают остальные окна, но не отправитель
      await main.locator('#send').dispatchEvent('click');
      await w1.locator('#got li').filter({ hasText: '"from":"main"' }).waitFor();
      ok(`${theme}: сообщение главного окна дошло до второго, а самому себе — нет`, (await main.locator('#got li').count()) === 0);
      await w1.locator('#reply').dispatchEvent('click');
      await main.locator('#got li').filter({ hasText: '"from":"detail"' }).waitFor();
      ok(`${theme}: ответ второго окна дошёл до главного`, (await w1.locator('#got li').count()) === 1);
      await w1.locator('#title').dispatchEvent('click');
      await page.locator('[data-window="w1"] [data-testid="program-window-title"]').filter({ hasText: 'Окна — Деталь' }).waitFor();
      ok(`${theme}: заголовок второго окна сменился, главного — нет`, (await titleOf('main')) === 'Окна — Главное 1');

      // Диалог — в своём окне; соседнее окно работает
      await w1.locator('#confirm').dispatchEvent('click');
      const dlg = page.locator('[data-window="w1"] [data-testid="studio-run-dialog"]');
      await dlg.waitFor();
      const inside = await page.evaluate(() => {
        const box = document.querySelector('[data-window="w1"]')!.getBoundingClientRect(), d = document.querySelector('[data-window="w1"] [role="dialog"]')!.getBoundingClientRect();
        return d.left >= box.left - 1 && d.right <= box.right + 1 && d.top >= box.top - 1 && d.bottom <= box.bottom + 1;
      });
      ok(`${theme}: диалог программы лежит внутри своего окна, в чужом его нет`, inside && (await page.locator('[data-window="main"] [role="dialog"]').count()) === 0);
      ok(`${theme}: в шапке диалога название программы и заголовок вопроса`, (await page.locator('[data-window="w1"] [role="dialog"]').getAttribute('aria-label')) === 'Окна — Удалить строку?');
      await main.locator('#title2').dispatchEvent('click');
      await page.locator('[data-window="main"] [data-testid="program-window-title"]').filter({ hasText: 'Окна — Главное 2' }).waitFor();
      ok(`${theme}: пока диалог открыт, главное окно работает`, true);
      await page.screenshot({ path: path.join(shots, `studio-run-${theme}-2-dialog.png`), fullPage: true });
      await dlg.getByRole('button', { name: 'Оставить' }).click();
      await w1.locator('#status').filter({ hasText: 'confirm false' }).waitFor();
      ok(`${theme}: ответ человека дошёл до программы`, true);

      // Несохранённое
      await w1.locator('#dirty').dispatchEvent('click');
      await page.locator('table.log').getByText('несохранённое').first().waitFor();
      await page.getByRole('button', { name: /Закрыть окно/ }).click();
      const closeDlg = page.locator('[data-window="w1"] [data-testid="studio-run-dialog"]');
      await closeDlg.waitFor();
      ok(`${theme}: при закрытии окна с несохранённым — вопрос «Закрыть без сохранения?» с текстом программы`, (await page.locator('[data-window="w1"] [role="dialog"]').getAttribute('aria-label')) === 'Окна — Закрыть без сохранения?'
        && (await closeDlg.innerText()).includes('Есть правки таблицы'));
      await closeDlg.getByRole('button', { name: 'Отмена' }).click();
      ok(`${theme}: «Отмена» оставляет окно`, (await page.locator('[data-window="w1"]').count()) === 1 && (await closeDlg.count()) === 0);
      await w1.locator('#clean').dispatchEvent('click');
      await page.getByRole('button', { name: /Закрыть окно/ }).click();
      ok(`${theme}: без несохранённого окно закрывается без вопроса`, await page.locator('[data-window="w1"]').waitFor({ state: 'detached' }).then(() => true));
      await main.locator('#open').dispatchEvent('click');
      await frameOf('w2').locator('#dirty').dispatchEvent('click');
      await page.getByRole('button', { name: /Закрыть окно/ }).click();
      await page.locator('[data-window="w2"] [data-testid="studio-run-dialog"]').getByRole('button', { name: 'Закрыть', exact: true }).click();
      ok(`${theme}: «Закрыть» в вопросе закрывает окно`, await page.locator('[data-window="w2"]').waitFor({ state: 'detached' }).then(() => true));

      // Диалог ввода
      await main.locator('#confirm').dispatchEvent('click');
      await page.locator('[data-window="main"] [data-testid="studio-run-dialog"]').getByRole('button', { name: 'Оставить' }).click();
      await main.locator('#status').filter({ hasText: 'confirm false' }).waitFor();

      // Подключение к настоящему серверу: вопрос приходит событием службы, три ответа, тексты те же, что у Flux
      const asked = () => sink.events.filter(e => e.ch === 'studio:run' && e.data.kind === 'connectAsk').map(e => e.data);
      const until = async (fn: () => unknown) => { for (let i = 0; i < 150 && !fn(); i++) await new Promise(r => setTimeout(r, 40)); return !!fn(); };
      const press = (id: string) => main.locator(`#connect-${id}`).dispatchEvent('click');
      ok(`${theme}: подсказка, что политики администратора в Studio нет`, (await page.getByTestId('studio-admin-hint').innerText()).includes('Политики администратора в Studio нет'));
      await press('api');
      const prompt = page.getByTestId('studio-grant-prompt');
      await prompt.waitFor();
      ok(`${theme}: вопрос о подключении пришёл событием службы с текстами из манифеста запущенной программы`, asked().length === 1 && asked()[0].ask.connection === 'api' && asked()[0].ask.app === 'Сервер расчётов' && asked()[0].ask.moduleName === 'Окна');
      ok(`${theme}: пока человек не ответил, сервер не тронут`, hits === 0);
      const askNow = asked()[0].ask;
      ok(`${theme}: запрос подключения: заголовок, три ответа и слова — как во Flux`, (await page.getByRole('dialog').getAttribute('aria-label')) === promptTitle(askNow)
        && (await prompt.getByRole('button').filter({ hasText: /Не разрешать|Только сейчас|Разрешить всегда/ }).allInnerTexts()).join('|') === `${CHOICES.never}|${CHOICES.once}|${CHOICES.always}`
        && (await prompt.innerText()).includes(REMEMBER_STUDIO) && (await prompt.getAttribute('aria-label')) === PROMPT_LABEL);
      ok(`${theme}: фокус на «Только сейчас» (безопасный ответ)`, (await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))) === 'grant-once');
      await prompt.getByTestId('grant-more').click();
      const details = await prompt.getByTestId('grant-details').innerText();
      ok(`${theme}: «Подробнее» раскрывает, что программа не получит`, details.includes('Программа не получит'));
      const markers = await prompt.getByTestId('grant-details').locator('li').evaluateAll(items => items.map(li => { const st = getComputedStyle(li), ul = getComputedStyle(li.parentElement!); return { display: st.display, type: ul.listStyleType, left: parseFloat(ul.paddingLeft) }; }));
      ok(`${theme}: у списка «Программа не получит» есть маркеры (${markers.length} пунктов), как во Flux`, markers.length >= 3 && markers.every(m => m.display === 'list-item' && m.type !== 'none' && m.left >= 16));
      await prompt.getByTestId('grant-tech').click();
      ok(`${theme}: «Для специалиста» показывает адрес`, (await prompt.getByTestId('grant-tech-text').innerText()).includes(`127.0.0.1:${apiPort}`));
      await page.screenshot({ path: path.join(shots, `studio-run-${theme}-3-connect.png`), fullPage: true });
      await prompt.getByTestId('grant-never').click();
      await main.locator('#status').filter({ hasText: 'NOT_ALLOWED' }).waitFor();
      ok(`${theme}: «Не разрешать» — программа получила отказ, службе ушёл ответ «never», сервер не тронут`, answers.at(-1) === 'never' && hits === 0);
      await page.locator('table.log').getByText(/http, api, NOT_ALLOWED, \d+ мс/).waitFor();
      ok(`${theme}: журнал: «подключение: вид, имя, итог, мс»`, (await page.locator('table.log tr', { hasText: 'подключение' }).first().innerText()).includes('http, api, NOT_ALLOWED'));
      await press('api');
      await page.locator('table.log tr', { hasText: 'http, api, NOT_ALLOWED' }).nth(1).waitFor();
      ok(`${theme}: «Не разрешать» запомнено службой: второй вызов не спрашивает и отказывает`, asked().length === 1 && (await page.getByTestId('studio-grant-prompt').count()) === 0 && hits === 0);
      // «Только сейчас»: вызов дошёл до сервера, а решение не запомнено — второй вызов спрашивает снова
      await press('once');
      await page.getByTestId('grant-once').click();
      await main.locator('#status').filter({ hasText: /^once: .*"status":200/ }).waitFor();
      ok(`${theme}: «Только сейчас» — вызов дошёл до настоящего сервера (${hits}), ответ в программе`, answers.at(-1) === 'once' && hits === 1);
      await press('once');
      await until(() => hits === 2);
      ok(`${theme}: «Только сейчас» живёт до конца запуска: второй вызов в этом запуске не спрашивает`, asked().length === 2 && hits === 2 && (await page.getByTestId('studio-grant-prompt').count()) === 0);
      // «Разрешить всегда»: следующие вызовы не спрашивают
      await press('always');
      await page.getByTestId('grant-always').click();
      await until(() => hits === 3);
      const asksBefore = asked().length;
      await press('always');
      await until(() => hits === 4);
      ok(`${theme}: «Разрешить всегда» — следующий вызов дошёл до сервера без вопроса`, answers.at(-1) === 'always' && asked().length === asksBefore && hits === 4 && (await page.getByTestId('studio-grant-prompt').count()) === 0);
      // Закрыть окно запроса без выбора — «Не разрешать»
      await press('esc');
      await page.getByTestId('studio-grant-prompt').waitFor();
      await page.keyboard.press('Escape');
      await main.locator('#status').filter({ hasText: /NOT_ALLOWED/ }).waitFor();
      ok(`${theme}: Esc в запросе — «Не разрешать», сервер не тронут`, answers.at(-1) === 'never' && hits === 4);

      // Вторая программа в тестовой базе: настоящий черновик helper на TypeScript
      const programs = page.getByTestId('studio-test-programs');
      ok(`${theme}: в запуске список своих программ с методами`, (await programs.innerText()).includes('Помощник расчётов') && (await programs.innerText()).includes('double'));
      await main.locator('#program').dispatchEvent('click');
      await main.locator('#status').filter({ hasText: 'NOT_INSTALLED' }).waitFor();
      ok(`${theme}: пока помощник не поставлен — NOT_INSTALLED`, true);
      await programs.getByRole('button', { name: /Поставить в тестовую базу/ }).click();
      await programs.getByText('Поставлена').waitFor();
      await main.locator('#program').dispatchEvent('click');
      await main.locator('#status').filter({ hasText: '"doubled":42' }).waitFor();
      ok(`${theme}: после «Поставить в тестовую базу» вызов вернул ответ метода настоящей логики: ${await status(main)}`, (await status(main)).includes('"by":"double"'));
      ok(`${theme}: журнал: строка «программа» с итогом`, (await page.locator('table.log').innerText()).includes('helper.double: ответ получен'));
      await programs.getByRole('button', { name: /Убрать/ }).click();
      await programs.getByText('Нет', { exact: true }).waitFor();
      await main.locator('#program').dispatchEvent('click');
      await main.locator('#status').filter({ hasText: 'NOT_INSTALLED' }).waitFor();
      ok(`${theme}: после «Убрать» снова NOT_INSTALLED`, true);

      // Файл: диалог службы подставной, но запись настоящая
      await main.locator('#save').dispatchEvent('click');
      await main.locator('#status').filter({ hasText: 'файл saved' }).waitFor();
      const savedFile = path.join(sink.saveDir, 'a.csv');
      ok(`${theme}: «Сохранить файл»: диалог получил имя, файл записан с тем же содержимым, программа получила «saved»`, sink.saveDialogs.length === 1 && sink.saveDialogs[0].defaultName === 'a.csv' && fs.existsSync(savedFile) && fs.readFileSync(savedFile, 'utf8') === 'a;b');
      ok(`${theme}: журнал: строка «файл» с итогом`, (await page.locator('table.log').innerText()).includes('a.csv (3 Б) — сохранён'));
      await measure(page, `${theme}/запуск`);
      await page.screenshot({ path: path.join(shots, `studio-run-${theme}-4-programs.png`), fullPage: true });

      // Предел числа окон: вместе с главным их пять, как у окон Flux
      await main.locator('#many').dispatchEvent('click');
      await main.locator('#status').filter({ hasText: /открыто \d+, отказ/ }).waitFor();
      ok(`${theme}: предел числа окон — ${WINDOW_LIMITS.windows} вместе с главным (дополнительных ${WINDOW_LIMITS.windows - 1})`,
        (await page.locator('[data-testid="program-window"]').count()) === WINDOW_LIMITS.windows && (await status(main)).startsWith(`открыто ${WINDOW_LIMITS.windows - 1}, отказ`));
      ok(`${theme}: журнал записал отказ по пределу`, (await page.locator('table.log').innerText()).includes('предел числа окон'));
      await measure(page, `${theme}/пять-окон`);
      // Пять окон занимают больше места, чем остаётся над панелью: панель сворачивается (программа при этом продолжает работать),
      // и все пять окон видны целиком
      await page.getByRole('button', { name: 'Свернуть панель' }).click();
      let allWhole = true;
      for (const key of ['main', 'w3', 'w4', 'w5', 'w6']) allWhole = allWhole && await page.locator(`[data-window="${key}"]`).count() === 1 && await whole(key);
      ok(`${theme}: при свёрнутой панели все пять окон видны целиком, программа продолжает работать`, allWhole && (await status(main)).startsWith('открыто'));
      await page.screenshot({ path: path.join(shots, `studio-run-${theme}-5-limit.png`), fullPage: true });
      await page.getByRole('button', { name: 'Развернуть панель' }).click();

      // Лишние окна закрываются: на снимке «не отвечает» главное окно и плашка видны целиком рядом с одним соседом
      while ((await page.locator('[data-testid="program-window"]').count()) > 2) await page.getByRole('button', { name: /Закрыть окно/ }).last().click();

      // «Программа не отвечает»: страница занята дольше порога, Studio при этом работает; «Перезапустить» поднимает окно
      const child = page.frames().find(f => f.url().includes('/ui/index.html'));
      assert.ok(child, 'кадр главного окна найден');
      // Страница «зависла»: её таймеры останавливаются, сигнал «жива» (beat) больше не идёт. Настоящий бесконечный цикл в кадре здесь
      // блокирует и само окно Studio (в Chromium без Electron кадр делит с ним процесс), поэтому останавливаем сигнал
      await child.evaluate(() => { for (let i = 1; i < 2000; i++) clearInterval(i); });
      await page.getByTestId('module-hung').first().waitFor({ timeout: 15000 });
      ok(`${theme}: «Программа не отвечает» появилась после молчания страницы, остальная Studio отвечает`, (await page.getByTestId('module-hung').first().innerText()).includes('не отвечает') && await page.getByRole('button', { name: 'Снять обе темы' }).isEnabled());
      await page.screenshot({ path: path.join(shots, `studio-run-${theme}-6-hung.png`) });
      await page.getByTestId('module-hung').first().getByRole('button', { name: 'Перезапустить' }).click();
      await main.locator('#status').filter({ hasText: 'готово' }).waitFor();
      ok(`${theme}: «Перезапустить» поднимает страницу заново, плашка ушла`, (await page.getByTestId('module-hung').count()) === 0);
      await mainBox.waitFor();

      // «Снять обе темы» из вида файла: вид «Запуск» возвращается сам, снимки записаны в проект
      await tabs.getByRole('tab', { name: 'manifest.json' }).click();
      await page.getByTestId('file-editor').waitFor();
      await page.getByRole('button', { name: 'Снять обе темы' }).click();
      await page.getByText('Снимки обеих тем сохранены').waitFor();
      ok(`${theme}: «Снять обе темы» вернула вид «Запуск» и записала оба снимка в проект`, (await runTab.getAttribute('aria-selected')) === 'true' && fs.existsSync(path.join(data, 'projects', projectId, 'store', 'light.png')) && fs.existsSync(path.join(data, 'projects', projectId, 'store', 'dark.png')));
      ok(`${theme}: после снимков тема окна вернулась`, (await page.evaluate(() => document.documentElement.classList.contains('dark'))) === (theme === 'dark'));

      // «Запустить» сверху из вида файла: запуск идёт заново и вид «Запуск» открывается сам; окна прежнего запуска закрыты
      await tabs.getByRole('tab', { name: 'manifest.json' }).click();
      await page.getByTestId('file-editor').waitFor();
      await page.getByRole('button', { name: 'Запустить' }).first().click();
      await runTab.waitFor();
      await main.locator('#status').filter({ hasText: 'готово' }).waitFor();
      ok(`${theme}: «Запустить» сверху из вида файла открыла «Запуск», программа запущена заново с одним окном`, (await runTab.getAttribute('aria-selected')) === 'true' && await scene.isVisible() && (await page.locator('[data-testid="program-window"]').count()) === 1 && (await tabs.getByRole('tab', { name: '«Запуск»' }).count()) === 1);
      const asksOld = asked().length;
      await press('once');
      await page.getByTestId('studio-grant-prompt').waitFor();
      ok(`${theme}: новый запуск — «Только сейчас» забыто, программа спрашивает снова`, asked().length === asksOld + 1 && asked().at(-1).ask.connection === 'once');
      await page.getByTestId('grant-never').click();
      await main.locator('#status').filter({ hasText: /NOT_ALLOWED/ }).waitFor();
      await page.screenshot({ path: path.join(shots, `studio-run-${theme}-7-restart.png`), fullPage: true });

      // Закрыть вкладку «Запуск» — остановить программу
      await tabs.getByRole('button', { name: /Закрыть «Запуск»/ }).click();
      await page.locator('[data-testid="program-window"]').waitFor({ state: 'detached' });
      ok(`${theme}: закрытие вкладки «Запуск» остановило программу: окон нет, в панели снова «Запустить»`, (await runTab.count()) === 0 && (await page.locator('.studio-bottom').getByRole('button', { name: 'Запустить', exact: true }).count()) === 1
        && await service.handle('runConnect' as any, { connection: 'api', call: { op: 'http', method: 'GET', path: '/api/ping' } } as any).then((r: any) => r.code === 'DENIED', () => false));

      } catch (error) { await dump(error); }
      ok(`${theme}: ошибок страницы нет`, errors.length === 0);
      if (errors.length) console.log(errors);
      await page.close();
    }
    console.log(`\nFlux Studio: полный запуск программы в окне — ${passed} проверок пройдено, снимки: ${shots}`);
    console.log('Проверено в браузере с настоящей службой разработчика: настоящий HTTP-сервер, вопрос событием onRun, черновик-помощник на TypeScript, файл записан на диск. Заглушка — только системный диалог сохранения и снимок экрана; Studio на Windows этим набором не проверена.');
  } finally { await browser.close(); assets.close(); api.close(); fs.rmSync(temp, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error); process.exit(1); });
