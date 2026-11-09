/**
 * Окна Flux Studio в браузере: замеры и снимки в обеих темах.
 *
 * Собирается настоящий пакет разработчика и владельца; мост окна с главным процессом
 * подменён заглушкой, остальное — настоящий интерфейс. Снимки (PNG) лежат в каталоге
 * FLUX_STUDIO_SHOTS (по умолчанию в TEMP) и уходят артефактом CI, в git не кладутся.
 *
 * Что проверяется: экраны «Подключение», «Вход» (с отказом сервера), «Подпрограммы»
 * пустые и со списком, в сборке владельца — раздел в меню; в обеих темах фон
 * сплошной (без прозрачности), нет горизонтальной прокрутки, нет ошибок страницы,
 * поля подписаны, контраст основного текста не ниже 4.5:1, меню Studio открывает раздел.
 *
 * Запуск: FLUX_CHROME=/opt/pw-browsers/chromium-1194/chrome-linux/chrome npx tsx scripts/test-studio-ui.ts
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
const bridge = (sections: { id: string; title: string }[], modules: unknown[]) => `(() => {
  let state = { version: '9.9.9', build: 'x', connected: false, display: '', user: null, sections: ${JSON.stringify(sections)} };
  const listeners = new Set(); window.__calls = [];
  const push = () => listeners.forEach(fn => fn(state));
  window.studio = {
    onState: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    onProgress: () => () => {},
    call: async (action, args) => {
      window.__calls.push([action, args]);
      if (action === 'state') return { ok: true, value: state };
      if (action === 'connect') { state = { ...state, connected: true, display: 'MariaDB / MySQL · db.example:3306/Flux' }; return { ok: true, value: state }; }
      if (action === 'login') {
        if (args.password !== 'good') return { ok: false, error: 'Flux Studio открывается с правом «Разработка подпрограмм». Попросите администратора выдать его.' };
        state = { ...state, user: { id: 'dev', name: 'Разработчик' } }; return { ok: true, value: state };
      }
      if (action === 'modules') return { ok: true, value: ${JSON.stringify(modules)} };
      if (action === 'openSection') return { ok: true, value: { opened: true } };
      if (action === 'logout') { state = { ...state, user: null }; return { ok: true, value: state }; }
      return { ok: true, value: state };
    },
  };
})();`;

const luminance = (rgb: number[]) => { const [r, g, b] = rgb.map(v => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a: number[], b: number[]) => { const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
const parse = (css: string) => (css.match(/[\d.]+/g) || []).map(Number);

async function measure(page: Page, label: string) {
  const info = await page.evaluate(() => {
    const body = getComputedStyle(document.body), main = document.querySelector('main, .main') as HTMLElement | null;
    return {
      bg: body.backgroundColor, color: body.color, overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      unlabeled: [...document.querySelectorAll('input')].filter(i => !i.labels?.length).length, hasMain: !!main,
    };
  });
  const bg = parse(info.bg), fg = parse(info.color);
  ok(`${label}: фон сплошной`, bg.length === 3 || bg[3] === 1);
  ok(`${label}: нет горизонтальной прокрутки`, info.overflowX <= 0);
  ok(`${label}: у полей есть подписи`, info.unlabeled === 0);
  ok(`${label}: контраст текста не ниже 4.5:1`, contrast(fg.slice(0, 3), bg.slice(0, 3)) >= 4.5);
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
      const sections = target === 'owner' ? [{ id: 'owner', title: 'Лицензии и обновления Flux' }] : [];
      for (const theme of ['light', 'dark'] as const) {
        const page = await browser.newPage({ viewport: { width: 1180, height: 800 }, colorScheme: theme });
        const errors: string[] = [];
        page.on('pageerror', e => errors.push(e.message));
        page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
        await page.addInitScript(bridge(sections, rows));
        await page.goto('file://' + path.join(built.app, 'renderer', 'index.html'));
        await page.getByRole('heading', { name: 'Подключение к общей базе' }).waitFor();
        await measure(page, `${target}/${theme}/подключение`);
        await page.screenshot({ path: path.join(shots, `studio-${target}-${theme}-1-connect.png`) });
        ok(`${target}/${theme}: адрес базы скрыт полем пароля`, (await page.locator('#uri').getAttribute('type')) === 'password');
        await page.fill('#uri', 'mysql://U:P@H:3306/Flux');
        await page.getByRole('button', { name: 'Подключиться' }).click();
        await page.getByRole('heading', { name: 'Вход в Flux Studio' }).waitFor();
        await page.fill('#symbol', 'dev'); await page.fill('#password', 'bad');
        await page.getByRole('button', { name: 'Войти' }).click();
        await page.getByRole('alert').waitFor();
        ok(`${target}/${theme}: отказ сервера показан текстом`, /Разработка подпрограмм/.test(await page.getByRole('alert').innerText()));
        await measure(page, `${target}/${theme}/вход`);
        await page.screenshot({ path: path.join(shots, `studio-${target}-${theme}-2-login-refused.png`) });
        await page.fill('#password', 'good');
        await page.getByRole('button', { name: 'Войти' }).click();
        await page.getByRole('heading', { name: 'Подпрограммы' }).waitFor();
        await page.getByRole('cell', { name: 'equipment-inspector' }).waitFor();
        ok(`${target}/${theme}: состояние показано по-русски`, (await page.locator('tbody').innerText()).includes('На проверке'));
        await measure(page, `${target}/${theme}/подпрограммы`);
        const nav = await page.getByRole('navigation', { name: 'Разделы Studio' }).innerText();
        ok(`${target}/${theme}: раздел владельца в меню — ${target === 'owner' ? 'есть' : 'нет'}`, nav.includes('Лицензии и обновления Flux') === (target === 'owner'));
        if (target === 'owner') {
          await page.getByRole('button', { name: 'Лицензии и обновления Flux' }).click();
          ok('меню передаёт открытие раздела в главный процесс', await page.evaluate(() => (window as any).__calls.some((c: unknown[]) => c[0] === 'openSection' && (c[1] as any).id === 'owner')));
        }
        await page.screenshot({ path: path.join(shots, `studio-${target}-${theme}-3-modules.png`) });
        ok(`${target}/${theme}: ошибок страницы нет`, errors.length === 0);
        await page.close();
      }
    }
    // Пустой список
    const page = await browser.newPage({ viewport: { width: 1180, height: 800 } });
    await page.addInitScript(bridge([], []));
    await page.goto('file://' + path.join(temp, 'developer', 'app', 'renderer', 'index.html'));
    await page.fill('#uri', 'x'); await page.getByRole('button', { name: 'Подключиться' }).click();
    await page.fill('#symbol', 'dev'); await page.fill('#password', 'good'); await page.getByRole('button', { name: 'Войти' }).click();
    await page.getByText('Вы ещё не отправляли подпрограмм').waitFor();
    ok('пустой список объяснён, а не пуст', true);
    await page.screenshot({ path: path.join(shots, 'studio-developer-light-4-empty.png') });
    console.log(`\nFlux Studio: окна — ${passed} проверок пройдено, снимки: ${shots}`);
  } finally { await browser.close(); fs.rmSync(temp, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error); process.exit(1); });
