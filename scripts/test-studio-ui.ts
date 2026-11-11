/**
 * Окна Flux Studio в браузере: вход — тот же экран и порядок шагов, что у Flux; замеры и снимки в обеих темах.
 *
 * Собираются настоящие пакеты разработчика и владельца; мост окна с главным процессом подменён заглушкой, остальное —
 * настоящий интерфейс (те же компоненты входа, что у Flux, оформление Flux). Снимки (PNG) лежат в каталоге
 * FLUX_STUDIO_SHOTS (по умолчанию в TEMP) и уходят артефактом CI, в git не кладутся.
 *
 * Что проверяется по состояниям: «Подключение» (поля, запомненная база), «Вход» (отказ сервера, вход владельца: выбор
 * файла, неверный пароль, успех), «Подпрограммы» пустые и со списком; у владельца — разделы в меню только после входа
 * владельца. В обеих темах: фон сплошной, нет горизонтальной прокрутки, поля подписаны, контраст основного текста
 * не ниже 4.5:1, нет ошибок страницы; тема переключается кнопкой, выбор запоминается.
 *
 * Запуск: FLUX_CHROME=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome npx tsx scripts/test-studio-ui.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Page } from 'playwright-core';

const { buildStudio } = require('../studio/build.cjs');
let passed = 0;
const ok = (name: string, value: unknown) => { assert.ok(value, name); passed++; console.log(`  ✓ ${name}`); };
const shots = process.env.FLUX_STUDIO_SHOTS || path.join(os.tmpdir(), 'flux-studio-shots');

/** Заглушка моста: ведёт себя как главный процесс, но без Electron */
const bridge = (build: string, sections: { id: string; title: string }[], modules: unknown[], remembered = '') => `(() => {
  const name = ${JSON.stringify(build === 'owner' ? 'Flux Studio — Владелец' : 'Flux Studio')};
  let state = { version: '9.9.9', build: ${JSON.stringify(build)}, name, connected: false, display: '', remembered: ${JSON.stringify(remembered)}, user: null, warning: '', sections: [] };
  const listeners = new Set(); window.__calls = [];
  const push = () => listeners.forEach(fn => fn(state));
  window.electron = { windowControls: { minimize() { window.__calls.push(['window:minimize']); }, maximize() {}, close() {}, isMaximized: async () => false, onMaximizedChange: () => () => {} } };
  window.studio = {
    onState: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    onProgress: () => () => {},
    call: async (action, args) => {
      window.__calls.push([action, args]);
      if (action === 'state') return { ok: true, value: state };
      if (action === 'connect' || action === 'connectRemembered') {
        if (args && args.uri === 'broken') return { ok: false, error: 'Не найден Flux рядом со Studio: нужен файл Flux-9.9.9-x64.exe. Положите его в одну папку с этой программой и подключитесь снова или выберите файл вручную.' };
        state = { ...state, connected: true, display: 'MariaDB / MySQL · db.example:3306/Flux' }; return { ok: true, value: state };
      }
      if (action === 'login') {
        if (args.password !== 'good') return { ok: false, error: 'Flux Studio открывается с правом «Разработка подпрограмм». Попросите администратора выдать его.' };
        state = { ...state, user: { id: 'dev', name: 'Разработчик' } }; return { ok: true, value: state };
      }
      if (action === 'ownerSelectKey') return { ok: true, value: { canceled: false, name: 'vault.flux-owner' } };
      if (action === 'ownerLogin') {
        if (args.password !== 'правильный пароль владельца') return { ok: false, error: 'Не удалось расшифровать хранилище. Проверьте пароль именно этого файла, раскладку и Caps Lock.' };
        state = { ...state, user: { id: 'owner', name: 'Владелец' }, sections: ${JSON.stringify(sections)} }; return { ok: true, value: state };
      }
      if (action === 'modules') return { ok: true, value: ${JSON.stringify(modules)} };
      if (action === 'openSection') return { ok: true, value: { opened: true } };
      if (action === 'disconnect') { state = { ...state, connected: false, user: null, sections: [] }; return { ok: true, value: state }; }
      if (action === 'logout') { state = { ...state, user: null, sections: [] }; return { ok: true, value: state }; }
      return { ok: true, value: state };
    },
  };
})();`;

const luminance = (rgb: number[]) => { const [r, g, b] = rgb.map(v => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a: number[], b: number[]) => { const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };

async function measure(page: Page, label: string) {
  // Chromium отдаёт цвета Flux в oklch(): для контраста сводим их к RGB через холст
  const info = await page.evaluate(`(() => {
    const rgb = css => { const c = document.createElement('canvas').getContext('2d'); c.clearRect(0, 0, 1, 1); c.fillStyle = css; c.fillRect(0, 0, 1, 1); const d = c.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
    const body = getComputedStyle(document.body);
    return {
      bg: rgb(body.backgroundColor), color: rgb(body.color), overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      unlabeled: [...document.querySelectorAll('input:not([type=checkbox])')].filter(i => !i.labels?.length && !i.getAttribute('aria-label')).length,
    };
  })()`) as { bg: number[]; color: number[]; overflowX: number; unlabeled: number };
  ok(`${label}: фон сплошной`, info.bg[3] === 1);
  ok(`${label}: нет горизонтальной прокрутки`, info.overflowX <= 0);
  ok(`${label}: у полей есть подписи`, info.unlabeled === 0);
  ok(`${label}: контраст текста не ниже 4.5:1`, contrast(info.color.slice(0, 3), info.bg.slice(0, 3)) >= 4.5);
}

async function open(browser: Awaited<ReturnType<typeof chromium.launch>>, file: string, theme: 'light' | 'dark', script: string) {
  const page = await browser.newPage({ viewport: { width: 1180, height: 800 } });
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript((value: string) => { try { localStorage.setItem('theme', value); } catch { /* приватный режим */ } }, theme);
  await page.addInitScript(script);
  await page.goto('file://' + file);
  return { page, errors };
}

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-studio-ui-'));
  fs.mkdirSync(shots, { recursive: true });
  const browser = await chromium.launch({ ...(process.env.FLUX_CHROME ? { executablePath: process.env.FLUX_CHROME } : {}), args: ['--no-sandbox'] });
  try {
    const rows = [
      { moduleId: 'equipment-inspector', version: '1.1.0', state: 'pending', createdAt: new Date().toISOString(), requests: 2 },
      { moduleId: 'report-builder', version: '0.3.0', state: 'returned', createdAt: new Date().toISOString(), requests: 1 },
    ];
    for (const target of ['developer', 'owner'] as const) {
      console.log(target === 'developer' ? 'Сборка разработчика' : 'Сборка владельца');
      const built = await buildStudio({ target, outDir: path.join(temp, target) });
      const file = path.join(built.app, 'renderer', 'index.html');
      const sections = target === 'owner' ? [{ id: 'owner', title: 'Лицензии и выпуск обновлений' }] : [];
      const product = target === 'owner' ? 'Flux Studio — Владелец' : 'Flux Studio';
      for (const theme of ['light', 'dark'] as const) {
        const tag = `${target}/${theme}`;
        const { page, errors } = await open(browser, file, theme, bridge(target, sections, rows));
        // Заставка из Flux гаснет, когда окно получило состояние
        await page.getByRole('heading', { name: 'Подключение к общей базе' }).waitFor();
        await page.waitForFunction(() => !document.getElementById('boot-splash'));
        ok(`${tag}: заставка Flux показана и погашена`, await page.evaluate(() => !document.getElementById('boot-splash')));
        ok(`${tag}: класс темы — как во Flux (dark на <html>)`, (await page.evaluate(() => document.documentElement.classList.contains('dark'))) === (theme === 'dark'));
        ok(`${tag}: заголовок карточки — название программы`, (await page.locator('#login-screen-root').innerText()).includes(product));
        await measure(page, `${tag}/подключение`);
        await page.screenshot({ path: path.join(shots, `studio-${target}-${theme}-1-connect.png`) });
        ok(`${tag}: адрес базы скрыт полем пароля`, (await page.getByLabel('URI базы MariaDB/MySQL').getAttribute('type')) === 'password');
        // Отказ подключения показан причиной, а не «отменено»
        await page.getByLabel('URI базы MariaDB/MySQL').fill('broken');
        await page.getByRole('button', { name: 'Подключиться' }).click();
        await page.getByRole('alert').waitFor();
        ok(`${tag}: причина отказа подключения показана словами`, /Не найден Flux рядом со Studio/.test(await page.getByRole('alert').innerText()));
        await page.screenshot({ path: path.join(shots, `studio-${target}-${theme}-1b-connect-refused.png`) });
        await page.getByLabel('URI базы MariaDB/MySQL').fill('mysql://U:P@H:3306/Flux');
        await page.getByRole('button', { name: 'Подключиться' }).click();
        await page.locator('#login-input').waitFor();
        ok(`${tag}: после подключения — тот же вход, что у Flux (логин, пароль, «Запомнить логин»)`, (await page.locator('#password-input').count()) === 1 && (await page.locator('#remember-me-checkbox').count()) === 1);
        ok(`${tag}: под карточкой — подключённая база`, (await page.getByRole('button', { name: /База · db\.example:3306\/Flux/ }).count()) === 1);
        await page.fill('#login-input', 'dev'); await page.fill('#password-input', 'bad');
        await page.getByRole('button', { name: 'Войти', exact: true }).click();
        await page.getByRole('alert').waitFor();
        ok(`${tag}: отказ сервера показан текстом`, /Разработка подпрограмм/.test(await page.getByRole('alert').innerText()));
        await measure(page, `${tag}/вход`);
        await page.screenshot({ path: path.join(shots, `studio-${target}-${theme}-2-login-refused.png`) });

        // Вход владельца: тот же порядок, что у Flux — файл ключа, пароль ключа, «Войти с ключом»
        await page.getByRole('button', { name: 'Вход владельца', exact: true }).click();
        const submit = page.getByRole('button', { name: 'Войти с ключом' });
        ok(`${tag}: «Войти с ключом» недоступна без файла и пароля`, await submit.isDisabled());
        await page.getByRole('button', { name: 'Выбрать файл ключа' }).click();
        await page.getByRole('button', { name: 'vault.flux-owner' }).waitFor();
        await page.getByLabel('Пароль ключа владельца').fill('неверный пароль владельца');
        await submit.click();
        await page.getByText('Проверьте пароль именно этого файла').waitFor();
        ok(`${tag}: неверный пароль ключа — причина показана, пароль из поля убран`, (await page.getByLabel('Пароль ключа владельца').inputValue()) === '');
        await page.screenshot({ path: path.join(shots, `studio-${target}-${theme}-2b-owner-refused.png`) });
        await page.getByLabel('Пароль ключа владельца').fill('правильный пароль владельца');
        await submit.click();
        await page.getByRole('heading', { name: 'Подпрограммы' }).waitFor();
        ok(`${tag}: владелец вошёл ключом`, true);
        const nav = await page.getByRole('navigation', { name: 'Разделы Studio' }).innerText();
        ok(`${tag}: раздел владельца в меню — ${target === 'owner' ? 'есть' : 'нет'}`, nav.includes('Лицензии и выпуск обновлений') === (target === 'owner'));
        if (target === 'owner') {
          await page.getByRole('button', { name: 'Лицензии и выпуск обновлений' }).click();
          ok('меню передаёт открытие раздела в главный процесс', await page.evaluate(() => (window as any).__calls.some((c: unknown[]) => c[0] === 'openSection' && (c[1] as any).id === 'owner')));
        }
        await page.getByRole('button', { name: 'Выйти' }).click();
        await page.locator('#login-input').waitFor();
        await page.fill('#login-input', 'dev'); await page.fill('#password-input', 'good');
        await page.getByRole('button', { name: 'Войти', exact: true }).click();
        await page.getByRole('heading', { name: 'Подпрограммы' }).waitFor();
        await page.getByRole('cell', { name: 'equipment-inspector' }).waitFor();
        ok(`${tag}: состояние показано по-русски`, (await page.locator('tbody').innerText()).includes('На проверке'));
        await measure(page, `${tag}/подпрограммы`);
        ok(`${tag}: разделов владельца у вошедшего по логину нет`, !(await page.getByRole('navigation', { name: 'Разделы Studio' }).innerText()).includes('Лицензии и выпуск обновлений'));
        await page.screenshot({ path: path.join(shots, `studio-${target}-${theme}-3-modules.png`) });
        // Тема переключается кнопкой, выбор запоминается (тот же ключ, что у Flux)
        await page.getByRole('button', { name: 'Переключить тему' }).click();
        ok(`${tag}: кнопка темы переключает класс и запоминает выбор`, (await page.evaluate(() => document.documentElement.classList.contains('dark') === (localStorage.getItem('theme') === 'dark'))) && (await page.evaluate(() => document.documentElement.classList.contains('dark'))) === (theme === 'light'));
        ok(`${tag}: ошибок страницы нет`, errors.length === 0);
        await page.close();
      }
    }
    // Запомненная база: показана без пароля, подключение одной кнопкой
    const remembered = await open(browser, path.join(temp, 'developer', 'app', 'renderer', 'index.html'), 'light', bridge('developer', [], [], 'MariaDB / MySQL · db.example:3306/Flux'));
    await remembered.page.getByTestId('remembered').waitFor();
    ok('запомненная база показана без пароля', (await remembered.page.getByTestId('remembered').innerText()) === 'MariaDB / MySQL · db.example:3306/Flux');
    await remembered.page.screenshot({ path: path.join(shots, 'studio-developer-light-0-remembered.png') });
    await remembered.page.getByRole('button', { name: 'Подключиться' }).click();
    await remembered.page.locator('#login-input').waitFor();
    ok('подключение по запомненной базе — сразу вход', true);
    await remembered.page.close();
    // Пустой список
    const empty = await open(browser, path.join(temp, 'developer', 'app', 'renderer', 'index.html'), 'light', bridge('developer', [], []));
    await empty.page.getByLabel('URI базы MariaDB/MySQL').fill('x'); await empty.page.getByRole('button', { name: 'Подключиться' }).click();
    await empty.page.fill('#login-input', 'dev'); await empty.page.fill('#password-input', 'good'); await empty.page.getByRole('button', { name: 'Войти', exact: true }).click();
    await empty.page.getByText('Вы ещё не отправляли подпрограмм').waitFor();
    ok('пустой список объяснён, а не пуст', true);
    await empty.page.screenshot({ path: path.join(shots, 'studio-developer-light-4-empty.png') });
    console.log(`\nFlux Studio: окна — ${passed} проверок пройдено, снимки: ${shots}`);
  } finally { await browser.close(); fs.rmSync(temp, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error); process.exit(1); });
