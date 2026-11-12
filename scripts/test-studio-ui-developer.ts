/**
 * Окно Studio, разделы разработчика, в браузере и в обеих темах.
 *
 * Собирается настоящий пакет разработчика. Мост окна с главным процессом подключён к НАСТОЯЩЕЙ службе
 * разработчика (studio/shell/developer.ts: ключ, проекты, тестовая база, проверка, запуск); сервер Flux заменён
 * маленькой заглушкой с готовыми ответами. Программа запускается в настоящем <iframe sandbox> с настоящим
 * runtime.js и настоящим мостом — только адрес страницы http://127.0.0.1 вместо flux-module:// (Chromium без Electron
 * не знает эту схему), для чего в копии index.html расширен frame-src.
 *
 * Что проверяется: стартовый экран, диалог «Новая программа», дерево файлов и вкладки, поиск; запуск на тестовой базе (данные позиции
 * видны в окне программы, журнал моста пишет чтения); непройденная и пройденная проверка; ключ, запрос сертификата,
 * отправка, статусы и замечания владельца, «исправить и отправить заново»; ошибки и отметка «исправлено»;
 * заглушка редактора; в обеих темах — сплошной фон, нет горизонтальной прокрутки (1180 и 1024), поля подписаны,
 * контраст. Снимки — каталог FLUX_STUDIO_SHOTS (артефакт CI).
 *
 * Запуск: FLUX_CHROME=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome npx tsx scripts/test-studio-ui-developer.ts
 */
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Page } from 'playwright-core';
import { createControlsEngine } from '../studio/shared/controlsEngine';
import { createTsBuilder } from '../studio/shared/tsBuildHost';
import { DeveloperService } from '../studio/shell/developer';
import { ALL_ACTIONS } from '../studio/shell/actions';

const { buildStudio, editorsEntry } = require('../studio/build.cjs');
let passed = 0;
const ok = (name: string, value: unknown) => { assert.ok(value, name); passed++; console.log(`  ✓ ${name}`); };
const shots = process.env.FLUX_STUDIO_SHOTS || path.join(os.tmpdir(), 'flux-studio-shots');

const luminance = (rgb: number[]) => { const [r, g, b] = rgb.map(v => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a: number[], b: number[]) => { const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };

async function measure(page: Page, label: string) {
  const rgb = `css => { const c = document.createElement('canvas').getContext('2d'); c.clearRect(0, 0, 1, 1); c.fillStyle = css; c.fillRect(0, 0, 1, 1); const d = c.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; }`;
  for (const width of [1180, 1024]) {
    await page.setViewportSize({ width, height: 800 });
    const info = await page.evaluate(`(() => {
      const rgb = ${rgb};
      const body = getComputedStyle(document.body);
      const small = [...document.querySelectorAll('main *')].filter(e => e.childNodes.length && [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()) && parseFloat(getComputedStyle(e).fontSize) < 12).length;
      return { bg: rgb(body.backgroundColor), color: rgb(body.color), overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        unlabeled: [...document.querySelectorAll('input:not([type=checkbox]), select, textarea')].filter(i => !i.labels?.length && !i.getAttribute('aria-label')).length, small };
    })()`) as { bg: number[]; color: number[]; overflowX: number; unlabeled: number; small: number };
    if (!(info.bg[3] === 1 && info.overflowX <= 0 && info.unlabeled === 0 && info.small === 0)) console.log(JSON.stringify(info), await page.evaluate(`[...document.querySelectorAll('input:not([type=checkbox]), select, textarea')].filter(i => !i.labels?.length && !i.getAttribute('aria-label')).map(i => i.outerHTML.slice(0, 120)).concat([...document.querySelectorAll('main *')].filter(e => [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()) && parseFloat(getComputedStyle(e).fontSize) < 12).map(e => e.outerHTML.slice(0, 120)))`));
    ok(`${label} (${width}): фон сплошной, нет горизонтальной прокрутки, поля подписаны, текст не мельче 12 px`, info.bg[3] === 1 && info.overflowX <= 0 && info.unlabeled === 0 && info.small === 0);
    if (width === 1180) ok(`${label}: контраст текста не ниже 4.5:1`, contrast(info.color.slice(0, 3), info.bg.slice(0, 3)) >= 4.5);
  }
  await page.setViewportSize({ width: 1180, height: 800 });
}

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-studio-ui-dev-'));
  fs.mkdirSync(shots, { recursive: true });
  const built = await buildStudio({ target: 'developer', outDir: path.join(temp, 'developer') });
  const renderer = path.join(built.app, 'renderer');
  // Только для проверки: Chromium без Electron не знает схему flux-module, поэтому программа открывается по http с loopback
  const indexFile = path.join(renderer, 'index.html');
  fs.writeFileSync(indexFile, fs.readFileSync(indexFile, 'utf8').replace('frame-src flux-module:', 'frame-src flux-module: http://127.0.0.1:*'));

  // Сервер Flux: готовые ответы
  const flux = express();
  flux.use(express.json({ limit: '60mb' }));
  const submitted: any[] = [], transitions: any[] = [];
  const reportId = '22222222-2222-4222-8222-222222222222';
  const requestRows = () => [
    { id: 'req-2', moduleId: 'report-builder', version: '0.3.0', state: 'returned', parentId: null, changelog: 'Отчёты', channel: 'test', createdAt: '2026-11-10T09:00:00Z', decidedAt: '2026-11-10T12:00:00Z',
      review: { note: 'Поправьте подпись поля и уберите вызов сети.', comments: [{ path: 'form.json', line: 4, text: 'Подпись длиннее 60 знаков' }] } },
    { id: 'req-1', moduleId: 'equipment-inspector', version: '1.1.0', state: 'pending', parentId: null, changelog: 'Новое', channel: 'test', createdAt: '2026-11-09T09:00:00Z', decidedAt: null, review: null },
  ];
  flux.get('/api/health', (_q, r) => r.json({ version: '1.0.0' }));
  const certificate = { status: 'none' };
  flux.get('/api/studio/certificate', (_q, r) => r.json({ status: certificate.status, name: '' }));
  // Тот же договор, что у маршрута из PR владельца (server/routes/moduleCertRequests.ts): тело {key, name}, профиль из входа
  const certRequests: any[] = [];
  flux.post('/api/modules/certificate-requests', (q, r) => { certRequests.push(q.body); r.json({ ok: true }); });
  flux.get('/api/studio/modules', (_q, r) => r.json({ modules: requestRows().map(x => ({ moduleId: x.moduleId, version: x.version, state: x.state, createdAt: x.createdAt, requests: 1 })) }));
  flux.get('/api/studio/releases', (_q, r) => r.json({ releases: [] }));
  flux.get('/api/studio/requests', (_q, r) => r.json({ requests: requestRows() }));
  flux.post('/api/modules/requests', (q, r) => { submitted.push(q.body); r.status(400).json({ error: 'Заглушка сервера не принимает запросы: у ключа нет сертификата владельца.' }); });
  flux.get('/api/feedback/reports', (_q, r) => r.json({ data: [
    { id: reportId, number: 12, title: 'Расчёт зависает на больших позициях', moduleId: 'equipment-inspector', moduleVersion: '1.1.0', status: 'IN_PROGRESS', impact: 'HIGH', priority: 'P1', revision: 2, resolvedVersion: null, createdAt: '2026-11-10' },
    { id: '33333333-3333-4333-8333-333333333333', number: 9, title: 'Неверная единица измерения', moduleId: 'equipment-inspector', moduleVersion: '1.0.0', status: 'VERIFY', impact: 'NORMAL', priority: 'P2', revision: 4, resolvedVersion: '1.1.0', createdAt: '2026-11-01' }] }));
  flux.get('/api/modules/crashes', (_q, r) => r.json({ data: [{ moduleId: 'equipment-inspector', version: '1.1.0', kind: 'timeout', count: 5 }, { moduleId: 'equipment-inspector', version: '1.0.0', kind: 'crash', count: 2 }] }));
  flux.post('/api/feedback/reports/:id/transition', (q, r) => { transitions.push(q.body); r.json({ data: {} }); });
  const fluxServer = await new Promise<http.Server>(resolve => { const s = flux.listen(0, '127.0.0.1', () => resolve(s)); });
  const origin = `http://127.0.0.1:${(fluxServer.address() as any).port}`;

  // Настоящая служба разработчика над временным каталогом данных
  const data = path.join(temp, 'data');
  const storage = { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s).reverse(), decryptString: (b: Buffer) => Buffer.from(b).reverse().toString() };
  const service = new DeveloperService({
    dir: data, storage, version: '1.0.0', session: () => ({ origin, token: 'token-dev-long-enough', user: { id: 'dev', name: 'Разработчик' }, owner: false }),
    assets: { templatesRoot: path.join(built.app, 'templates'), runtimeDir: path.join(built.app, 'runtime') },
    engine: createControlsEngine({ workerFile: path.join(built.app, 'controls-worker.cjs'), timeoutMs: 5000 }),
    tsBuilder: createTsBuilder({ workerFile: path.join(built.app, 'ts-build-worker.cjs'), wasmFile: path.join(built.app, 'esbuild.wasm') }),
    capture: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8]),
  });
  // Страницу и runtime запущенной программы отдаёт та же функция, что обслуживает flux-module://
  const assets = http.createServer((req, res) => {
    const asset = service.asset(`flux-module://run${req.url?.split('#')[0].split('?')[0]}`);
    if (!asset) { res.writeHead(404).end(); return; }
    res.writeHead(asset.status, asset.headers).end(asset.body as any);
  });
  await new Promise<void>(resolve => assets.listen(0, '127.0.0.1', resolve));
  const assetsOrigin = `http://127.0.0.1:${(assets.address() as any).port}`;

  const browser = await chromium.launch({ ...(process.env.FLUX_CHROME ? { executablePath: process.env.FLUX_CHROME } : {}), args: ['--no-sandbox'] });
  try {
    ok('точка подключения редакторов: настоящий раздел вместо заглушки', editorsEntry().endsWith('editors/index.tsx'));
    for (const theme of ['light', 'dark'] as const) {
      console.log(theme === 'light' ? 'Светлая тема' : 'Тёмная тема');
      fs.rmSync(path.join(data, 'drafts'), { recursive: true, force: true });
      fs.rmSync(path.join(data, 'projects'), { recursive: true, force: true });
      fs.rmSync(path.join(data, 'developer-key.json'), { force: true });
      const page = await browser.newPage({ viewport: { width: 1180, height: 800 } });
      await page.addInitScript((value: string) => { try { localStorage.setItem('theme', value); } catch { /* приватный режим */ } }, theme);
      const errors: string[] = [];
      page.on('pageerror', e => errors.push(e.message));
      page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
      const requested: string[] = [];
      await page.exposeFunction('__studioCall', async (action: string, args: any) => {
        requested.push(action);
        if (!ALL_ACTIONS.includes(action)) return { ok: false, error: 'Недоступное действие.' };
        try {
          if (action === 'state') return { ok: true, value: { version: '1.0.0', build: 'developer', name: 'Flux Studio', owner: false, sections: [], connected: true, display: 'MariaDB / MySQL · db:3306/Flux', warning: '', remembered: '', user: { id: 'dev', name: 'Разработчик' } } };
          if (action === 'logout') return { ok: true, value: {} };
          if (action === 'modules') return { ok: true, value: requestRows().map(r => ({ moduleId: r.moduleId, version: r.version, state: r.state, createdAt: r.createdAt, requests: 1 })) };
          const value: any = await service.handle(action as any, args || {});
          // Страница программы лежит на loopback-сервере теста
          if (action === 'runStart') value.url = `${assetsOrigin}/index.html`;
          return { ok: true, value };
        } catch (e: any) { return { ok: false, error: String(e?.message || e) }; }
      });
      await page.addInitScript(`window.studio = { onState: () => () => {}, onProgress: () => () => {}, onProject: () => () => {}, call: (a, g) => window.__studioCall(a, g) };`);
      await page.goto('file://' + path.join(renderer, 'index.html'));
      const nav = page.getByRole('navigation', { name: 'Flux Studio' });
      await page.getByRole('heading', { name: 'Мои программы' }).waitFor();
      ok(`${theme}: в меню один пункт «Мои программы», прежних шести разделов нет`, (await nav.getByRole('button', { name: 'Мои программы' }).count()) === 1
        && (await nav.innerText()).split('\n').every(t => !['Проект программы', 'Редактор', 'Проверка перед отправкой', 'Публикация', 'Ошибки'].includes(t.trim())));
      // Отправленные раньше программы, которых нет на этом компьютере, видны в списке и открываются как проект
      await page.getByText('equipment-inspector').waitFor();
      ok(`${theme}: отправленные программы видны и без папки на этом компьютере`, (await page.getByRole('button', { name: 'Открыть как проект' }).count()) === 2);
      ok(`${theme}: подсказка «путь за 5 шагов» показана при первом запуске`, (await page.getByLabel('Как пройти путь за 5 шагов').locator('li').count()) === 5);
      await measure(page, `${theme}/мои-программы`);
      await page.screenshot({ path: path.join(shots, `studio-dev-${theme}-1-home.png`), fullPage: true });

      // «Новая программа»: один диалог
      await page.getByRole('button', { name: 'Новая программа' }).first().click();
      const dialog = page.getByRole('dialog');
      await dialog.waitFor();
      ok(`${theme}: в диалоге семь языков расчётов и три примера`, (await dialog.locator('#np-lang option').count()) === 7 && (await dialog.locator('#np-sample option').count()) === 3);
      await dialog.locator('#np-sample').selectOption('none');
      await dialog.locator('#np-lang').selectOption('typescript');
      await dialog.getByLabel('Название').fill('Пример для окна');
      await measure(page, `${theme}/новая-программа`);
      await dialog.getByRole('button', { name: 'Создать', exact: true }).click();
      await page.getByRole('toolbar', { name: 'Запуск, проверка, публикация' }).waitFor();
      const tree = page.getByRole('tree', { name: 'Файлы проекта' });
      await tree.getByText('main.ts').waitFor();
      ok(`${theme}: рабочее окно открылось сразу, в дереве логика и контрольные примеры`, (await tree.innerText()).includes('manifest.json') && (await tree.innerText()).includes('controls.json'));
      ok(`${theme}: три кнопки сверху и четыре вкладки внизу`, (await page.getByRole('toolbar', { name: 'Запуск, проверка, публикация' }).getByRole('button').allInnerTexts()).join('|') === 'Запустить|Проверить|Опубликовать'
        && (await page.getByRole('tablist', { name: 'Нижняя панель' }).getByRole('tab').allInnerTexts()).map(t => t.replace(/\d+$/, '').trim()).join('|') === 'Запуск|Проблемы|Публикация|Сбои у пользователей');
      const projectId = fs.readdirSync(path.join(data, 'projects'))[0];
      ok(`${theme}: проект — папка на диске`, fs.existsSync(path.join(data, 'projects', projectId, 'manifest.json')));

      // Файлы: вкладки, создать, переименовать, удалить с подтверждением
      await tree.getByText('manifest.json').click();
      await page.getByRole('tablist', { name: 'Открытые файлы' }).getByRole('tab', { name: 'manifest.json' }).waitFor();
      await tree.getByText('form.json').click();
      ok(`${theme}: открытые файлы — вкладки`, (await page.getByRole('tablist', { name: 'Открытые файлы' }).getByRole('tab').count()) >= 2);
      await page.getByRole('button', { name: 'Новый файл' }).click();
      await page.getByLabel('Имя').fill('notes.txt'); await page.getByRole('button', { name: 'Готово' }).click();
      await tree.getByText('notes.txt').waitFor();
      await tree.getByText('notes.txt').click();
      await page.getByRole('button', { name: 'Переименовать' }).click();
      await page.getByLabel('Новое имя').fill('readme.txt'); await page.getByRole('button', { name: 'Готово' }).click();
      await tree.getByText('readme.txt').waitFor();
      ok(`${theme}: файл создан и переименован на диске`, await (async () => { const f = fs.readdirSync(path.join(data, 'projects', projectId), { recursive: true }).map(String); return f.some(x => x.endsWith('readme.txt')) && !f.some(x => x.endsWith('notes.txt')); })());
      await tree.getByText('readme.txt').click();
      await page.getByRole('button', { name: 'Удалить', exact: true }).click();
      await page.getByRole('dialog').getByText('будет удалён').waitFor();
      await page.getByRole('dialog').getByRole('button', { name: 'Отмена' }).click();
      ok(`${theme}: удаление спрашивает подтверждение, отмена оставляет файл`, (await tree.getByText('readme.txt').count()) === 1);
      await page.getByRole('button', { name: 'Удалить', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Удалить' }).click();
      await tree.getByText('readme.txt').waitFor({ state: 'detached' });
      ok(`${theme}: после подтверждения файл удалён`, true);

      // Поиск по проекту
      await page.getByRole('button', { name: 'Поиск по проекту' }).click();
      await page.getByRole('textbox', { name: 'Поиск по проекту' }).fill('version');
      await page.locator('.studio-hits button').first().waitFor();
      ok(`${theme}: поиск по проекту находит строки с переходом к файлу`, (await page.locator('.studio-hits').innerText()).includes('manifest.json'));
      await page.getByRole('button', { name: 'Поиск по проекту' }).click();

      // «Собрать»: TypeScript собирается внутри Studio, ошибка приходит с файлом и строкой, нажатие открывает файл на этой строке
      await service.handle('draftSave', { id: projectId, path: 'logic/extra.ts', text: 'export const ok = 1;\nexport const bad: = 2;\n' });
      await page.getByRole('button', { name: 'Собрать TypeScript' }).click();
      await page.locator('.studio-problem').filter({ hasText: 'logic/extra.ts:2' }).first().waitFor({ timeout: 60000 });
      ok(`${theme}: «Собрать» показала ошибку сборки с файлом и строкой во вкладке «Проблемы»`, (await page.locator('.studio-problem-src').first().innerText()) === 'Сборка');
      await page.locator('.studio-problem').filter({ hasText: 'logic/extra.ts:2' }).first().click();
      await page.getByRole('tablist', { name: 'Открытые файлы' }).getByRole('tab', { name: 'extra.ts' }).waitFor();
      ok(`${theme}: нажатие на ошибку открыло файл во вкладке`, true);
      await service.handle('draftRemoveFile', { id: projectId, path: 'logic/extra.ts' });
      await page.getByRole('button', { name: 'Собрать TypeScript' }).click();
      await page.getByText('Сборка прошла').waitFor({ timeout: 60000 });
      ok(`${theme}: после исправления «Собрать» сообщает, что ошибок нет`, true);

      // Редакторы формы из #155 во вкладке form.json
      await page.getByRole('tab', { name: 'form.json' }).first().click();
      await page.getByTestId('editors').waitFor();
      ok(`${theme}: вкладка form.json — настоящие редакторы, заглушки нет`, (await page.getByTestId('editors-stub').count()) === 0);
      await measure(page, `${theme}/рабочее-окно`);
      await page.screenshot({ path: path.join(shots, `studio-dev-${theme}-2-workspace.png`), fullPage: true });

      // «Запустить»: настоящий iframe с настоящим runtime в нижней панели
      await page.getByRole('button', { name: 'Запустить' }).first().click();
      await page.locator('#run-entity').waitFor();
      await page.selectOption('#run-entity', 'p1-e-fan');
      await page.locator('#run-title').locator('xpath=..').getByRole('button', { name: /Запустить|Перезапустить/ }).click();
      const frame = page.frameLocator('[data-testid="studio-module-frame"]');
      await frame.getByText('Вентилятор радиальный').waitFor();
      const shown = async () => (await frame.locator('#module-root').innerText()).replace(/\s+/g, ' ');
      for (let i = 0; i < 100 && !/Значений 4/.test(await shown()); i++) await page.waitForTimeout(50);
      const text = await shown();
      ok(`${theme}: программа показала позицию из тестовой базы и свой расчёт (${text.slice(0, 100)})`, text.includes('ВР-80-75') && /Значений 4/.test(text) && /Сумма 6031\.5/.test(text));
      ok(`${theme}: окно программы изолировано (sandbox без allow-same-origin)`, (await page.locator('[data-testid="studio-module-frame"]').getAttribute('sandbox')) === 'allow-scripts');
      ok(`${theme}: журнал моста записал чтение`, (await page.locator('table.log').innerText()).includes('equipment'));
      await page.screenshot({ path: path.join(shots, `studio-dev-${theme}-3-run.png`), fullPage: true });

      // «Опубликовать» сама проверяет: без снимков — «Проблемы», окно версии не открывается
      await page.getByRole('button', { name: 'Опубликовать' }).click();
      await page.locator('.studio-problem').first().waitFor();
      ok(`${theme}: без снимков «Опубликовать» остановилась на проблемах и не открыла окно версии`, (await page.getByRole('dialog').count()) === 0 && (await page.locator('.studio-problems').innerText()).length > 0);
      await measure(page, `${theme}/проблемы`);
      await page.screenshot({ path: path.join(shots, `studio-dev-${theme}-4-problems.png`), fullPage: true });
      await page.getByRole('tab', { name: 'Запуск' }).click();
      await page.getByRole('button', { name: 'Снять обе темы' }).click();
      await page.getByText('Снимки обеих тем сохранены').waitFor();

      // Ключ создан сам; одна кнопка запроса права
      await page.getByRole('tab', { name: 'Публикация' }).click();
      ok(`${theme}: ключ создан сам (файл есть), на странице закрытой части нет`, fs.existsSync(path.join(data, 'developer-key.json')) && !(await page.content()).includes('PRIVATE KEY'));
      await page.getByRole('button', { name: 'Запросить право публиковать' }).first().click();
      await page.getByText('Запрос отправлен владельцу').first().waitFor();
      ok(`${theme}: запрос права ушёл в очередь владельца с ключом и именем, профиль — из сессии`, certRequests.length >= 1 && /^[0-9a-f]{64}$/.test(certRequests.at(-1).key) && !('userId' in certRequests.at(-1)));

      // Окно «Опубликовать» при праве «ждём»: версия предложена, отправка закрыта
      await page.getByRole('button', { name: 'Опубликовать' }).click();
      const pub = page.getByRole('dialog', { name: 'Опубликовать' });
      await pub.waitFor({ timeout: 8000 }).catch(async e => { console.log(await page.locator('.studio-bottom').innerText(), await page.locator('main').innerText().then(t => t.slice(0, 300))); throw e; });
      ok(`${theme}: проверка пройдена, предложен номер версии`, /^\d+\.\d+\.\d+$/.test(await pub.getByLabel('Номер версии').inputValue()));
      ok(`${theme}: пока права нет, отправка закрыта`, await pub.getByRole('button', { name: 'Отправить владельцу' }).isDisabled());
      await pub.getByRole('button', { name: 'Отмена' }).click();

      // Владелец выдал право (сервер теперь отвечает «выдан») — отправка открывается, сервер всё равно проверяет сам
      certificate.status = 'issued';
      await page.reload();
      await page.getByRole('heading', { name: 'Мои программы' }).waitFor();
      await page.getByRole('button', { name: 'Пример для окна' }).click();
      await page.getByRole('toolbar', { name: 'Запуск, проверка, публикация' }).waitFor();
      await page.getByRole('button', { name: 'Опубликовать' }).click();
      await pub.waitFor();
      await pub.getByLabel('Что нового').fill('Первая версия');
      await page.screenshot({ path: path.join(shots, `studio-dev-${theme}-5-publish.png`), fullPage: true });
      await pub.getByRole('button', { name: 'Отправить владельцу' }).click();
      await pub.getByRole('alert').waitFor();
      ok(`${theme}: отказ сервера показан текстом, запрос подписан и дошёл до сервера`, submitted.length >= 1 && typeof submitted.at(-1).signature === 'string' && submitted.at(-1).signature.startsWith('FLUXMODREQ1.'));
      await pub.getByRole('button', { name: 'Отмена' }).click();
      certificate.status = 'none';

      // Сбои у пользователей
      await page.getByRole('tab', { name: 'Сбои у пользователей' }).click();
      await page.getByRole('cell', { name: 'Расчёт зависает на больших позициях' }).waitFor();
      ok(`${theme}: обращения и счётчики сбоев по своей программе`, (await page.locator('tbody').nth(1).innerText()).includes('Не уложилась во время') && (await page.locator('tbody').first().innerText()).includes('Не могу продолжить'));
      ok(`${theme}: отметка недоступна, пока версия не вида 1.2.3`, await page.getByRole('button', { name: 'Отметить' }).isDisabled());
      await page.fill(`#fix-${reportId}`, '1.2.0');
      await page.getByRole('button', { name: 'Отметить' }).click();
      ok(`${theme}: «исправлено в версии» ушло на сервер`, await (async () => { for (let i = 0; i < 50 && !transitions.length; i++) await new Promise(r => setTimeout(r, 100)); return transitions[0]?.resolvedVersion === '1.2.0' && transitions[0].to === 'VERIFY'; })());
      transitions.length = 0;
      await measure(page, `${theme}/сбои`);
      await page.screenshot({ path: path.join(shots, `studio-dev-${theme}-6-failures.png`), fullPage: true });

      ok(`${theme}: окно вызывало только перечисленные действия`, requested.every(a => ALL_ACTIONS.includes(a)));
      ok(`${theme}: ошибок страницы нет`, errors.length === 0);
      if (errors.length) console.log(errors);
      await page.close();
    }
    console.log(`\nFlux Studio: разделы разработчика в окне — ${passed} проверок пройдено, снимки: ${shots}`);
  } finally { await browser.close(); fluxServer.close(); assets.close(); fs.rmSync(temp, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error); process.exit(1); });
