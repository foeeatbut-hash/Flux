/**
 * Окно Studio, разделы разработчика, в браузере и в обеих темах.
 *
 * Собирается настоящий пакет разработчика. Мост окна с главным процессом подключён к НАСТОЯЩЕЙ службе
 * разработчика (studio/shell/developer.ts: ключ, проекты, тестовая база, проверка, запуск); сервер Flux заменён
 * маленькой заглушкой с готовыми ответами. Подпрограмма запускается в настоящем <iframe sandbox> с настоящим
 * runtime.js и настоящим мостом — только адрес страницы http://127.0.0.1 вместо flux-module:// (Chromium без Electron
 * не знает эту схему), для чего в копии index.html расширен frame-src.
 *
 * Что проверяется: навигация шести разделов; создание проекта и его файлы; запуск на тестовой базе (данные позиции
 * видны в окне подпрограммы, журнал моста пишет чтения); непройденная и пройденная проверка; ключ, запрос сертификата,
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
import { DeveloperService } from '../studio/shell/developer';
import { ALL_ACTIONS } from '../studio/shell/actions';

const { buildStudio, editorsEntry } = require('../studio/build.cjs');
let passed = 0;
const ok = (name: string, value: unknown) => { assert.ok(value, name); passed++; console.log(`  ✓ ${name}`); };
const shots = process.env.FLUX_STUDIO_SHOTS || path.join(os.tmpdir(), 'flux-studio-shots');

const luminance = (rgb: number[]) => { const [r, g, b] = rgb.map(v => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a: number[], b: number[]) => { const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
const parse = (css: string) => (css.match(/[\d.]+/g) || []).map(Number);

async function measure(page: Page, label: string) {
  for (const width of [1180, 1024]) {
    await page.setViewportSize({ width, height: 800 });
    const info = await page.evaluate(() => {
      const body = getComputedStyle(document.body);
      const small = [...document.querySelectorAll('main *')].filter(e => e.childNodes.length && [...e.childNodes].some(n => n.nodeType === 3 && n.textContent!.trim()) && parseFloat(getComputedStyle(e).fontSize) < 12).length;
      return { bg: body.backgroundColor, color: body.color, overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        unlabeled: [...document.querySelectorAll('input:not([type=checkbox]), select, textarea')].filter(i => !(i as HTMLInputElement).labels?.length).length, small };
    });
    const bg = parse(info.bg), fg = parse(info.color);
    ok(`${label} (${width}): фон сплошной, нет горизонтальной прокрутки, поля подписаны, текст не мельче 12 px`, (bg.length === 3 || bg[3] === 1) && info.overflowX <= 0 && info.unlabeled === 0 && info.small === 0);
    if (width === 1180) ok(`${label}: контраст текста не ниже 4.5:1`, contrast(fg.slice(0, 3), bg.slice(0, 3)) >= 4.5);
  }
  await page.setViewportSize({ width: 1180, height: 800 });
}

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-studio-ui-dev-'));
  fs.mkdirSync(shots, { recursive: true });
  const built = await buildStudio({ target: 'developer', outDir: path.join(temp, 'developer') });
  const renderer = path.join(built.app, 'renderer');
  // Только для проверки: Chromium без Electron не знает схему flux-module, поэтому подпрограмма открывается по http с loopback
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
  flux.get('/api/studio/certificate', (_q, r) => r.json({ status: 'none', name: '' }));
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
    capture: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8]),
  });
  // Страницу и runtime запущенной подпрограммы отдаёт та же функция, что обслуживает flux-module://
  const assets = http.createServer((req, res) => {
    const asset = service.asset(`flux-module://run${req.url?.split('#')[0].split('?')[0]}`);
    if (!asset) { res.writeHead(404).end(); return; }
    res.writeHead(asset.status, asset.headers).end(asset.body as any);
  });
  await new Promise<void>(resolve => assets.listen(0, '127.0.0.1', resolve));
  const assetsOrigin = `http://127.0.0.1:${(assets.address() as any).port}`;

  const browser = await chromium.launch({ ...(process.env.FLUX_CHROME ? { executablePath: process.env.FLUX_CHROME } : {}), args: ['--no-sandbox'] });
  try {
    ok('точка подключения редакторов: пока раздела нет, подставляется заглушка', editorsEntry().endsWith('editorsStub.tsx'));
    for (const theme of ['light', 'dark'] as const) {
      console.log(theme === 'light' ? 'Светлая тема' : 'Тёмная тема');
      fs.rmSync(path.join(data, 'drafts'), { recursive: true, force: true });
      fs.rmSync(path.join(data, 'developer-key.json'), { force: true });
      const page = await browser.newPage({ viewport: { width: 1180, height: 800 }, colorScheme: theme });
      const errors: string[] = [];
      page.on('pageerror', e => errors.push(e.message));
      page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
      const requested: string[] = [];
      await page.exposeFunction('__studioCall', async (action: string, args: any) => {
        requested.push(action);
        if (!ALL_ACTIONS.includes(action)) return { ok: false, error: 'Недоступное действие.' };
        try {
          if (action === 'state') return { ok: true, value: { version: '1.0.0', build: 'developer', connected: true, display: 'MariaDB / MySQL · db:3306/Flux', warning: '', remembered: '', user: { id: 'dev', name: 'Разработчик' }, sections: [] } };
          if (action === 'logout') return { ok: true, value: {} };
          if (action === 'modules') return { ok: true, value: requestRows().map(r => ({ moduleId: r.moduleId, version: r.version, state: r.state, createdAt: r.createdAt, requests: 1 })) };
          const value: any = await service.handle(action as any, args || {});
          // Страница подпрограммы лежит на loopback-сервере теста
          if (action === 'runStart') value.url = `${assetsOrigin}/index.html`;
          return { ok: true, value };
        } catch (e: any) { return { ok: false, error: String(e?.message || e) }; }
      });
      await page.addInitScript(`window.studio = { onState: () => () => {}, onProgress: () => () => {}, call: (a, g) => window.__studioCall(a, g) };`);
      await page.goto('file://' + path.join(renderer, 'index.html'));
      const nav = page.getByRole('navigation', { name: 'Разделы Studio' });
      await page.getByRole('heading', { name: 'Подпрограммы' }).waitFor();
      const names = ['Подпрограммы', 'Проект подпрограммы', 'Редактор', 'Проверка перед отправкой', 'Публикация', 'Ошибки'];
      ok(`${theme}: в навигации шесть разделов в нужном порядке`, (await nav.getByRole('button').allInnerTexts()).filter(t => names.includes(t)).join('|') === names.join('|') );
      await measure(page, `${theme}/подпрограммы`);

      // Проект
      await nav.getByRole('button', { name: 'Проект подпрограммы' }).click();
      await page.getByRole('heading', { name: 'Проект подпрограммы' }).waitFor();
      await page.getByText('Проектов пока нет').waitFor();
      ok(`${theme}: языков в списке заготовок семь`, (await page.locator('#tpl option').count()) === 7);
      await page.selectOption('#tpl', 'typescript');
      await page.fill('#pid', 'demo-ui'); await page.fill('#pname', 'Пример для окна');
      await page.getByRole('button', { name: 'Создать проект' }).click();
      await page.getByRole('heading', { name: 'Файлы проекта «demo-ui»' }).waitFor();
      ok(`${theme}: файлы проекта видны, логика и контрольные примеры на месте`, (await page.locator('table', { hasText: 'Размер' }).innerText()).includes('logic/main.ts') && (await page.locator('table', { hasText: 'Размер' }).innerText()).includes('examples/controls.json'));
      await measure(page, `${theme}/проект`);
      await page.screenshot({ path: path.join(shots, `studio-dev-${theme}-1-project.png`), fullPage: true });

      // Запуск на тестовой базе: настоящий iframe с настоящим runtime
      await page.selectOption('#run-entity', 'p1-e-fan');
      await page.getByRole('button', { name: 'Запустить' }).click();
      const frame = page.frameLocator('[data-testid="studio-module-frame"]');
      await frame.getByText('Вентилятор радиальный').waitFor();
      await frame.getByText('Статистика числовых параметров').waitFor();
      const shown = async () => (await frame.locator('#module-root').innerText()).replace(/\s+/g, ' ');
      // Расчёт идёт в Worker подпрограммы после первой отрисовки: ждём результат по состоянию окна, а не по таймеру
      for (let i = 0; i < 100 && !/Значений 4/.test(await shown()); i++) await page.waitForTimeout(50);
      const text = await shown();
      ok(`${theme}: подпрограмма показала позицию из тестовой базы и свой расчёт (${text.slice(0, 120)})`, text.includes('ВР-80-75') && /Значений 4/.test(text) && /Сумма 6031\.5/.test(text));
      ok(`${theme}: окно подпрограммы изолировано (sandbox без allow-same-origin)`, (await page.locator('[data-testid="studio-module-frame"]').getAttribute('sandbox')) === 'allow-scripts');
      ok(`${theme}: журнал моста записал чтение`, (await page.locator('table.log').innerText()).includes('equipment'));
      await page.screenshot({ path: path.join(shots, `studio-dev-${theme}-2-run.png`), fullPage: true });
      ok(`${theme}: файл тестовой базы лежит в каталоге данных`, fs.existsSync(path.join(data, 'test-base.sqlite')));
      await page.getByRole('button', { name: 'Сбросить тестовую базу' }).click();
      await page.getByText('Проекты: 2').waitFor();
      ok(`${theme}: сброс тестовой базы возвращает образцы`, true);

      // Редактор
      await nav.getByRole('button', { name: 'Редактор' }).click();
      await page.getByTestId('editors-stub').waitFor();
      ok(`${theme}: раздел «Редактор» — заглушка «раздел в работе»`, (await page.getByTestId('editors-stub').innerText()).includes('Раздел в работе'));
      await measure(page, `${theme}/редактор`);
      await page.screenshot({ path: path.join(shots, `studio-dev-${theme}-3-editor.png`) });

      // Проверка: сначала не пройдена
      await nav.getByRole('button', { name: 'Проверка перед отправкой' }).click();
      await page.fill('#changelog', 'Первая версия');
      await page.getByRole('button', { name: 'Проверить' }).click();
      await page.getByText('Проверка не пройдена').waitFor();
      ok(`${theme}: без снимков проверка не пройдена, отправка недоступна`, (await page.locator('tbody').innerText()).includes('Не прошло') && (await page.getByRole('button', { name: 'Перейти к публикации' }).count()) === 0);
      ok(`${theme}: границы проверки названы («не проверяется автоматически»)`, (await page.locator('tbody').innerText()).includes('Не проверяется автоматически'));
      await measure(page, `${theme}/проверка-не-пройдена`);
      await page.screenshot({ path: path.join(shots, `studio-dev-${theme}-4-check-failed.png`), fullPage: true });

      // Снять обе темы и проверить снова
      await nav.getByRole('button', { name: 'Проект подпрограммы' }).click();
      await page.getByRole('button', { name: 'Запустить' }).waitFor();
      await page.selectOption('#run-entity', 'p1-e-fan');
      await page.getByRole('button', { name: 'Запустить' }).click();
      await frame.getByText('Вентилятор радиальный').waitFor();
      await page.getByRole('button', { name: 'Снять обе темы' }).click();
      await page.getByText('Снимки обеих тем сохранены').waitFor();
      await nav.getByRole('button', { name: 'Проверка перед отправкой' }).click();
      await page.getByRole('button', { name: 'Проверить' }).click();
      await page.getByText('Проверка пройдена').waitFor();
      ok(`${theme}: после снимков проверка пройдена, видна кнопка перехода к публикации`, (await page.getByRole('button', { name: 'Перейти к публикации' }).count()) === 1);
      await measure(page, `${theme}/проверка-пройдена`);
      await page.screenshot({ path: path.join(shots, `studio-dev-${theme}-5-check-ok.png`), fullPage: true });

      // Публикация
      await page.getByRole('button', { name: 'Перейти к публикации' }).click();
      await page.getByRole('heading', { name: 'Публикация' }).waitFor();
      await page.getByRole('button', { name: 'Создать ключ' }).click();
      await page.getByTestId('public-key').waitFor();
      ok(`${theme}: показана открытая часть ключа; закрытой на странице нет`, /^[0-9a-f]{64}$/.test(await page.getByTestId('public-key').innerText()) && !(await page.content()).includes('PRIVATE KEY'));
      ok(`${theme}: статус сертификата — «запросите его у владельца»`, (await page.locator('.facts').innerText()).includes('Сертификата нет'));
      await page.getByRole('button', { name: 'Отправить владельцу' }).click();
      await page.getByText('Запрос отправлен владельцу, ждём сертификат').waitFor();
      ok(`${theme}: запрос ушёл в очередь владельца с ключом и именем, профиль — из сессии, статус виден`, certRequests.length >= 1 && /^[0-9a-f]{64}$/.test(certRequests.at(-1).key) && !('userId' in certRequests.at(-1)) && (await page.getByRole('button', { name: 'Отправить владельцу' }).isDisabled()));
      await page.getByRole('button', { name: 'Показать текст запроса' }).click();
      await page.locator('#cert-request').waitFor();
      ok(`${theme}: запрос сертификата показан для передачи владельцу`, (await page.locator('#cert-request').inputValue()).startsWith('FLUXDEVCERTREQ1.'));
      ok(`${theme}: замечания владельца и комментарий к строке видны`, (await page.locator('tbody').last().innerText()).includes('Подпись длиннее 60 знаков'));
      ok(`${theme}: «Исправить и отправить заново» только у возвращённой`, (await page.getByRole('button', { name: 'Исправить и отправить заново' }).count()) === 1);
      await page.getByRole('button', { name: 'Отправить на публикацию' }).click();
      await page.getByRole('alert').filter({ hasText: 'сертификата' }).waitFor();
      ok(`${theme}: отказ сервера показан текстом, запрос подписан и дошёл до сервера`, submitted.length >= 1 && typeof submitted.at(-1).signature === 'string' && submitted.at(-1).signature.startsWith('FLUXMODREQ1.'));
      await measure(page, `${theme}/публикация`);
      await page.screenshot({ path: path.join(shots, `studio-dev-${theme}-6-publish.png`), fullPage: true });

      // Исправить и отправить заново: проект возвращается из пакета запроса. Заглушка не хранит пакеты — ошибка называется
      await page.getByRole('button', { name: 'Исправить и отправить заново' }).click();
      await page.getByRole('alert').filter({ hasText: /Flux ответил|Запрос не найден|не найден/ }).first().waitFor();
      ok(`${theme}: «исправить и отправить заново» идёт за пакетом запроса и честно сообщает, если его нет`, true);

      // Ошибки
      await nav.getByRole('button', { name: 'Ошибки' }).click();
      await page.getByRole('cell', { name: 'Расчёт зависает на больших позициях' }).waitFor();
      ok(`${theme}: обращения и счётчики сбоев по своей подпрограмме`, (await page.locator('tbody').nth(1).innerText()).includes('Не уложилась во время') && (await page.locator('tbody').first().innerText()).includes('Не могу продолжить'));
      ok(`${theme}: отметка недоступна, пока версия не вида 1.2.3`, await page.getByRole('button', { name: 'Отметить' }).isDisabled());
      await page.fill(`#fix-${reportId}`, '1.2.0');
      await page.getByRole('button', { name: 'Отметить' }).click();
      await page.waitForFunction(() => true);
      ok(`${theme}: «исправлено в версии» ушло на сервер`, await (async () => { for (let i = 0; i < 50 && !transitions.length; i++) await new Promise(r => setTimeout(r, 100)); return transitions[0]?.resolvedVersion === '1.2.0' && transitions[0].to === 'VERIFY'; })());
      transitions.length = 0;
      await measure(page, `${theme}/ошибки`);
      await page.screenshot({ path: path.join(shots, `studio-dev-${theme}-7-errors.png`), fullPage: true });

      ok(`${theme}: окно вызывало только перечисленные действия`, requested.every(a => ALL_ACTIONS.includes(a)));
      ok(`${theme}: ошибок страницы нет`, errors.length === 0);
      if (errors.length) console.log(errors);
      await page.close();
    }
    console.log(`\nFlux Studio: разделы разработчика в окне — ${passed} проверок пройдено, снимки: ${shots}`);
  } finally { await browser.close(); fluxServer.close(); assets.close(); fs.rmSync(temp, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error); process.exit(1); });
