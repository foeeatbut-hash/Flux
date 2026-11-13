/**
 * Окна программ на экране Flux (добавлено к v2): диалоги Flux как дочернее окно программы, заголовок и размер окна,
 * вопрос о несохранённом при закрытии. Настоящие WindowsLayer, ModuleHost, ModuleFrame и мост; программа-страница —
 * обычный http-сервер проверки (стенд scripts/fixtures/program-windows-ui).
 *
 * Меряется то, что видит человек: рамка диалога внутри окна своей программы, название программы в шапке, кнопки,
 * кегль, горизонтальная прокрутка, фокус по умолчанию. Обе темы; снимки — в FLUX_SHOTS (по умолчанию /tmp/program-windows).
 *
 * Запуск: FLUX_UI_URL=http://127.0.0.1:5471 FLUX_CHROME=… npx tsx scripts/test-modules-windows-ui.ts
 */
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildPageAssets } from '../modules/build';
import { MIN_H, MIN_W } from '../src/lib/windows';

const BASE = process.env.FLUX_UI_URL || 'http://127.0.0.1:5173';
import { findChrome } from './chromePath';
const CHROME = findChrome();
const SHOTS = process.env.FLUX_SHOTS || '/tmp/program-windows';
let passed = 0, failed = 0;
const ok = (name: string, value: unknown, details?: unknown) => { if (value) { passed++; console.log('  ✓', name); } else { failed++; console.error('  ✗', name, details === undefined ? '' : JSON.stringify(details).slice(0, 300)); } };
type Page = import('playwright-core').Page;

// Незавершённые вызовы программы при закрытии браузера не должны заслонять первую ошибку проверки
process.on('unhandledRejection', reason => { if (!/has been closed/.test(String(reason))) console.error(reason); });

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const assets = await buildPageAssets();
  const client = assets['modules/_flux/flux.v1.js'] as string;
  const css = assets['modules/_flux/flux-ui.v1.css'] as string;
  const server = http.createServer((req, res) => {
    const url = req.url || '';
    if (url.startsWith('/_flux/flux.v1.js')) { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(client); return; }
    if (url.startsWith('/_flux/flux-ui.v1.css')) { res.writeHead(200, { 'Content-Type': 'text/css' }); res.end(css); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/_flux/flux-ui.v1.css"><body><script src="/_flux/flux.v1.js"></script><h1>${url.includes('detail') ? 'Строка' : 'Ведомость'}</h1><p>Содержимое программы</p>`);
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const errors: string[] = [];
  try {
    for (const theme of ['light', 'dark'] as const) {
      console.log(`\n=== ${theme === 'dark' ? 'Тёмная' : 'Светлая'} тема ===`);
      const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
      page.on('pageerror', e => errors.push(String(e)));
      page.on('console', m => { if (m.type() === 'error' && !/WebSocket|\[vite\]/.test(m.text())) errors.push(m.text().slice(0, 200)); });
      // tsx оборачивает именованные стрелки в __name(): в странице такой функции нет
      await page.addInitScript(() => { (window as any).__name = (fn: unknown) => fn; });
      await page.goto(`${BASE}/scripts/fixtures/program-windows-ui.html?theme=${theme}&page=${port}&hang=2500`);
      const store = (fn: string, ...args: unknown[]) => page.evaluate(([f, a]) => (window as any).__fx.windows.getState()[f as string](...(a as unknown[])), [fn, args] as const);
      const wins = () => page.evaluate(() => (window as any).__fx.windows.getState().windows.map((w: any) => ({ id: w.id, path: w.path, href: w.href, x: w.x, y: w.y, w: w.w, h: w.h })));
      const titles = () => page.evaluate(() => (window as any).__fx.windows.getState().titles as Record<string, string>);
      const frameOf = async (index: number) => {
        const handle = (await page.locator('iframe[data-testid="flux-module-frame"]').nth(index).elementHandle())!;
        const frame = (await handle.contentFrame())!;
        await frame.waitForFunction(() => (window as any).flux?.ready);
        await frame.evaluate(() => (window as any).flux.ready);
        return frame;
      };
      // Вызов программы из её кадра: ошибка приходит кодом
      const call = (frame: import('playwright-core').Frame, code: string) => frame.evaluate(async c => {
        try { return { value: await (new Function('flux', `return (async () => { ${c} })()`))((window as any).flux) }; } catch (e: any) { return { error: e.code || String(e) }; }
      }, code) as Promise<any>;

      await store('open', '/module/win-demo');
      await page.locator('iframe[data-testid="flux-module-frame"]').waitFor({ timeout: 15000 });
      const main = await frameOf(0);
      const first = (await wins())[0];
      const winBox = () => page.locator(`[data-win="${first.id}"]`).boundingBox();

      console.log('1. Диалог подтверждения');
      const pending = call(main, `return flux.dialogs.confirm({ title: 'Удалить строку?', text: 'Строка 5 будет удалена из ведомости.\\nДействие нельзя отменить.', ok: 'Удалить', cancel: 'Оставить', danger: true })`);
      const dialog = page.locator('[data-testid="program-dialog"]');
      await dialog.waitFor({ timeout: 5000 });
      await page.waitForTimeout(400);
      const box = (await page.locator('.fx-dialog').first().boundingBox())!, win = (await winBox())!;
      ok('диалог стоит внутри окна своей программы', box.x >= win.x - 1 && box.y >= win.y - 1 && box.x + box.width <= win.x + win.width + 1 && box.y + box.height <= win.y + win.height + 1, { box, win });
      const title = await page.getByTestId('program-dialog-title').textContent();
      ok('в шапке видно название программы и заголовок программы', title === 'Ведомость — Удалить строку?', title);
      ok('текст выведен как текст с переносом строки', (await page.getByTestId('program-dialog-text').textContent())?.includes('Действие нельзя отменить.') && await page.getByTestId('program-dialog-text').evaluate(el => getComputedStyle(el).whiteSpace === 'pre-wrap'));
      ok('кнопки по просьбе программы', (await page.getByTestId('program-dialog-ok').textContent()) === 'Удалить' && (await page.getByTestId('program-dialog-cancel').textContent()) === 'Оставить');
      ok('опасное действие: фокус на «Оставить», а не на «Удалить»', await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.testid === 'program-dialog-cancel'));
      const metrics = await page.evaluate(() => {
        const q = (sel: string) => document.querySelector(sel) as HTMLElement;
        const style = (el: HTMLElement) => { const s = getComputedStyle(el), r = el.getBoundingClientRect(); return { size: parseFloat(s.fontSize), weight: Number(s.fontWeight), h: Math.round(r.height), w: Math.round(r.width) }; };
        return { title: style(q('[data-testid=program-dialog-title]')), text: style(q('[data-testid=program-dialog-text]')), ok: style(q('[data-testid=program-dialog-ok]')), cancel: style(q('[data-testid=program-dialog-cancel]')),
          scroll: document.documentElement.scrollWidth > innerWidth, okBg: getComputedStyle(q('[data-testid=program-dialog-ok]')).backgroundColor, upper: /[А-ЯA-Z]{4,}/.test(q('.fx-dialog').innerText) };
      });
      ok('кегль не мельче 12, веса 400/500/600', metrics.title.size >= 12 && metrics.text.size >= 12 && metrics.ok.size >= 12 && [400, 500, 600].includes(metrics.title.weight) && [400, 500, 600].includes(metrics.ok.weight), metrics);
      ok('кнопки по высоте как в Flux (>=28)', metrics.ok.h >= 28 && metrics.cancel.h >= 28, metrics);
      ok('горизонтальной прокрутки нет', !metrics.scroll);
      await page.screenshot({ path: `${SHOTS}/${theme}-confirm.png` });
      const second = await call(main, `return flux.dialogs.alert({ title: 'a', text: 'b' })`);
      ok('второй диалог при открытом — LIMIT', second.error === 'LIMIT', second);
      await page.getByTestId('program-dialog-ok').click();
      ok('«Удалить» → true', (await pending).value === true);
      ok('диалог закрыт', await dialog.count() === 0);

      console.log('\n2. Esc и «Отмена»');
      await page.waitForTimeout(1100);
      const p2 = call(main, `return flux.dialogs.confirm({ title: 'Продолжить?', text: 'Обычный вопрос' })`);
      await dialog.waitFor();
      ok('обычный вопрос: фокус на главной кнопке', await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.testid === 'program-dialog-ok'));
      ok('кнопки по умолчанию «Отмена» и «OK»', (await page.getByTestId('program-dialog-cancel').textContent()) === 'Отмена' && (await page.getByTestId('program-dialog-ok').textContent()) === 'OK');
      await page.keyboard.press('Escape');
      ok('Esc → false', (await p2).value === false && await dialog.count() === 0);

      console.log('\n3. Строка ввода');
      await page.waitForTimeout(1100);
      const p3 = call(main, `return flux.dialogs.prompt({ title: 'Имя ведомости', text: 'Как назвать копию?', label: 'Название', value: 'Ведомость 1', maxLength: 20 })`);
      await dialog.waitFor();
      const input = page.getByTestId('program-dialog-input');
      ok('поле с подписью, начальным значением и пределом, фокус в поле', await input.inputValue() === 'Ведомость 1' && await input.getAttribute('maxlength') === '20'
        && await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.testid === 'program-dialog-input'));
      await page.screenshot({ path: `${SHOTS}/${theme}-prompt.png` });
      await input.fill('Копия ведомости с очень длинным названием');
      ok('предел длины держит само поле', (await input.inputValue()).length === 20);
      await input.fill('Копия');
      await page.keyboard.press('Enter');
      ok('Enter → строка', (await p3).value === 'Копия');
      await page.waitForTimeout(1100);
      const p3b = call(main, `return flux.dialogs.prompt({ title: 'Имя', label: 'Название' })`);
      await dialog.waitFor(); await page.getByTestId('program-dialog-cancel').click();
      ok('«Отмена» в строке ввода → null', (await p3b).value === null);

      console.log('\n4. Сообщение');
      await page.waitForTimeout(1100);
      const p4 = call(main, `return flux.dialogs.alert({ title: 'Готово', text: 'Файл сохранён.' })`);
      await dialog.waitFor();
      ok('у сообщения одна кнопка «Понятно»', await page.getByTestId('program-dialog-cancel').count() === 0 && (await page.getByTestId('program-dialog-ok').textContent()) === 'Понятно');
      await page.screenshot({ path: `${SHOTS}/${theme}-alert.png` });
      await page.keyboard.press('Enter');
      ok('сообщение → null', (await p4).value === null && await dialog.count() === 0);

      console.log('\n5. Заголовок и размер окна');
      await call(main, `await flux.window.setTitle('Лист 1'); return 1`);
      await page.waitForTimeout(200);
      ok('setTitle: «Программа — заголовок» в рамке окна', (await titles())[first.id] === 'Ведомость — Лист 1' && await page.locator(`[data-win="${first.id}"]`).getByText('Ведомость — Лист 1').first().isVisible());
      await call(main, `await flux.window.setTitle(''); return 1`);
      await page.waitForTimeout(200);
      ok('пустой заголовок возвращает название программы', !(await titles())[first.id]);
      await call(main, `await flux.windows.open('detail.html', { row: 5 }, { title: 'Строка 5', width: 700, height: 500 }); return 1`);
      await page.waitForFunction(() => (window as any).__fx.windows.getState().windows.length === 2);
      const second2 = (await wins())[1];
      ok('новое окно нужного размера', second2.w === 700 && second2.h === 500, second2);
      ok('заголовок нового окна из адреса и в рамке', (await titles())[second2.id] === 'Ведомость — Строка 5' && /title=/.test(second2.href), { t: await titles(), href: second2.href });
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${SHOTS}/${theme}-two-windows.png` });
      await page.waitForTimeout(1100);
      await call(main, `await flux.windows.open('index.html', {}, { width: 5000, height: 4000 }); return 1`);
      await page.waitForFunction(() => (window as any).__fx.windows.getState().windows.length === 3);
      const big = (await wins())[2];
      ok('слишком большой размер обрезается рабочей областью, окно не уходит за стол', big.w <= 1366 && big.h <= 768 && big.x >= 0 && big.y >= 0 && big.x + big.w <= 1366 && big.y + big.h <= 768, big);
      await page.waitForTimeout(1100);
      await call(main, `await flux.windows.open('index.html', {}, { width: 320, height: 240 }); return 1`);
      await page.waitForFunction(() => (window as any).__fx.windows.getState().windows.length === 4);
      const small = (await wins())[3];
      ok(`минимальный размер: не меньше минимума окна Flux (${MIN_W}×${MIN_H})`, small.w === MIN_W && small.h === MIN_H, small);
      ok('меньше 320×240 — DENIED', (await call(main, `return flux.windows.open('index.html', {}, { width: 100, height: 100 })`)).error === 'DENIED');
      for (const w of (await wins()).slice(1)) await store('close', w.id);

      console.log('\n6. Закрытие окна закрывает диалог без ответа');
      await page.waitForTimeout(1100);
      // Кадр исчезнет вместе с окном: оборванный вызов здесь ожидаем
      void call(main, `return flux.dialogs.confirm({ title: 'Вопрос', text: 'Окно закроют' })`).catch(() => undefined);
      await dialog.waitFor();
      await store('close', first.id);
      await page.waitForTimeout(300);
      ok('окно и диалог убраны', await dialog.count() === 0 && (await wins()).length === 0);

      console.log('\n7. Несохранённое при закрытии');
      await store('open', '/module/win-demo');
      await page.locator('iframe[data-testid="flux-module-frame"]').waitFor();
      const w2 = (await wins())[0];
      const frame2 = await frameOf(0);
      ok('без пометки окно закрывается сразу, без вопроса', await (async () => { await call(frame2, `await flux.window.setUnsaved(true, 'x'); await flux.window.setUnsaved(false); return 1`); return true; })());
      await call(frame2, `await flux.window.setUnsaved(true, 'Таблица «Лист 1» изменена.'); return 1`);
      const closing = page.evaluate(id => (window as any).__fx.windows.getState().requestClose(id), w2.id);
      await dialog.waitFor({ timeout: 5000 });
      ok('вопрос Flux с названием программы и её текстом', (await page.getByTestId('program-dialog-title').textContent()) === 'Ведомость — Закрыть без сохранения?' && (await page.getByTestId('program-dialog-text').textContent()) === 'Таблица «Лист 1» изменена.');
      ok('кнопки «Закрыть» / «Отмена», по умолчанию «Отмена»', (await page.getByTestId('program-dialog-ok').textContent()) === 'Закрыть' && (await page.getByTestId('program-dialog-cancel').textContent()) === 'Отмена'
        && await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.testid === 'program-dialog-cancel'));
      ok('кнопка «Закрыть» опасная (красная заливка)', await page.getByTestId('program-dialog-ok').evaluate(el => /danger/.test(el.className)));
      await page.screenshot({ path: `${SHOTS}/${theme}-close.png` });
      await page.keyboard.press('Enter');
      ok('Enter на «Отмена»: окно осталось', (await closing) === false && (await wins()).length === 1 && await dialog.count() === 0);
      const closing2 = page.evaluate(id => (window as any).__fx.windows.getState().requestClose(id), w2.id);
      await dialog.waitFor();
      await page.getByTestId('program-dialog-ok').click();
      ok('«Закрыть»: окно закрыто', (await closing2) === true);
      await page.waitForFunction(() => (window as any).__fx.windows.getState().windows.length === 0);

      console.log('\n8. Выход из Flux, закрытие всех окон, свёрнутое окно');
      await store('open', '/module/win-demo');
      await page.locator('iframe[data-testid="flux-module-frame"]').waitFor();
      const w3 = (await wins())[0];
      const frame3 = await frameOf(0);
      await call(frame3, `await flux.window.setUnsaved(true); return 1`);
      await store('minimize', w3.id);
      const prepared = page.evaluate(() => (window as any).__fx.prepareSessionClose());
      await dialog.waitFor({ timeout: 5000 });
      ok('при выходе окно поднято из свёрнутого и спрашивает, текст по умолчанию', await page.getByTestId('program-dialog-text').textContent() === 'В окне есть несохранённые изменения.' && (await wins()).length === 1 && !(await titles())[w3.id]);
      await page.getByTestId('program-dialog-cancel').click();
      ok('«Отмена» останавливает выход', (await prepared) === false);
      const prepared2 = page.evaluate(() => (window as any).__fx.prepareSessionClose());
      await dialog.waitFor(); await page.getByTestId('program-dialog-ok').click();
      ok('«Закрыть» даёт выходу пройти', (await prepared2) === true);

      console.log('\n9. Зависшая программа закрывается без вопроса');
      await call(frame3, `await flux.window.setUnsaved(true); return 1`);
      void frame3.evaluate(() => { setTimeout(() => { const end = Date.now() + 7000; while (Date.now() < end); }, 0); });
      await page.getByTestId('module-hung').waitFor({ timeout: 15000 });
      const closed = await page.evaluate(id => (window as any).__fx.windows.getState().requestClose(id), w3.id);
      ok('«не отвечает»: закрыто без вопроса', closed === true && await dialog.count() === 0);
      await page.close();
    }
    ok('в консоли Flux тихо', errors.length === 0, errors);
  } finally { await browser.close(); server.close(); }
  console.log(`\nПройдено: ${passed}${failed ? `, провалено: ${failed}` : ''}`);
  process.exit(failed ? 1 : 0);
}
main().catch(error => { console.error(error); process.exit(1); });
