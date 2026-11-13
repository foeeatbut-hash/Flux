/**
 * «Окна Flux вместе с окнами Windows», сторона окна: какие сигналы указателя
 * получает главный процесс — пустой стол, значок, окно раздела, панель задач —
 * и выключатель в «Параметры → Мониторы» (замеры и снимки в обеих темах).
 *
 * Стенд: scripts/fixtures/desk-focus-ui.html, мост главного процесса подменён.
 * Запуск: FLUX_UI_URL=http://127.0.0.1:5231 FLUX_CHROME=… npx tsx scripts/test-desk-focus-ui.ts
 * Снимки: SHOTS=/tmp/папка — кроме проверок сохраняет PNG.
 */
import fs from 'node:fs';
const BASE = process.env.FLUX_UI_URL || 'http://127.0.0.1:5173';
import { findChrome } from './chromePath';
const CHROME = findChrome();
const SHOTS = process.env.SHOTS || '';
let passed = 0; let failed = 0;
const ok = (name: string, value: boolean, details?: unknown) => {
  if (value) { passed++; console.log('✓', name); } else { failed++; console.error('✗', name, details === undefined ? '' : JSON.stringify(details).slice(0, 300)); }
};

(async () => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.goto(`${BASE}/scripts/fixtures/desk-focus-ui.html`);
    await page.locator('[data-flux-desk]').waitFor();
    await page.locator('[data-desktop-item]').first().waitFor();
    await page.evaluate(() => (window as any).__fx.windows.getState().open('/calendar'));
    await page.locator('.fx-win').first().waitFor();
    const signals = () => page.evaluate(() => [...(window as any).__deskSignals] as boolean[]);
    const clear = () => page.evaluate(() => { (window as any).__deskSignals.length = 0; });
    /** Что лежит под точкой: признаки по тому же правилу, что у окна, — для самопроверки точек. */
    const under = (x: number, y: number) => page.evaluate(([px, py]) => {
      const el = document.elementFromPoint(px, py);
      return { desk: !!el?.closest('[data-flux-desk]'), item: !!el?.closest('button,[data-desktop-item]'),
        win: !!el?.closest('.fx-win'), bar: !!el?.closest('[data-taskbar], nav, footer') };
    }, [x, y]);
    const center = async (selector: string) => {
      const b = await page.locator(selector).first().boundingBox();
      if (!b) throw new Error(`нет ${selector}`);
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    };
    /** Пустое место стола: сетка точек, первая над областью стола, вне значков и окон. */
    const emptyDesk = async () => {
      for (let y = 40; y < 700; y += 40) for (let x = 1340; x > 600; x -= 40) {
        const u = await under(x, y);
        if (u.desk && !u.item && !u.win) return { x, y };
      }
      throw new Error('нет пустого места стола');
    };

    const empty = await emptyDesk();
    const icon = await center('[data-desktop-item]');
    const win = await center('.fx-win .fx-win-title');
    const bar = await page.evaluate(() => {
      const start = [...document.querySelectorAll('button')].find(b => /Пуск|Start/i.test(b.getAttribute('aria-label') || b.textContent || ''));
      const r = start?.getBoundingClientRect();
      return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
    });
    ok('Точки стенда: пустой стол, значок, окно, панель найдены', !!bar, { empty, icon, win, bar });

    await clear();
    await page.mouse.move(empty.x, empty.y);
    ok('Пустой стол: сигнал true', (await signals()).at(-1) === true, await signals());
    await page.mouse.move(empty.x - 10, empty.y + 5); await page.mouse.move(empty.x - 20, empty.y + 5);
    ok('Движение по пустому столу не шлёт повторов', (await signals()).length === 1, await signals());
    await page.mouse.move(icon.x, icon.y);
    ok('Значок стола: сигнал false (щелчок работает как раньше)', (await signals()).at(-1) === false && (await under(icon.x, icon.y)).item, await signals());
    await page.mouse.move(empty.x, empty.y);
    await page.mouse.move(win.x, win.y);
    ok('Окно раздела: сигнал false', (await signals()).slice(-2).join() === 'true,false' && (await under(win.x, win.y)).win, await signals());
    await page.mouse.move(empty.x, empty.y);
    if (bar) await page.mouse.move(bar.x, bar.y);
    ok('Панель задач Flux и кнопка «Пуск»: сигнал false', (await signals()).slice(-2).join() === 'true,false', await signals());
    const seq = await signals();
    ok('Сигналы строго чередуются: подряд одинаковых нет', seq.every((v, i) => i === 0 || v !== seq[i - 1]), seq);

    // Указатель ушёл за окно; потеря активности стирает память окна.
    await page.mouse.move(empty.x, empty.y);
    await clear();
    await page.evaluate(() => document.body.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: null })));
    ok('Указатель ушёл за окно Flux: сигнал false', (await signals()).join() === 'false', await signals());
    await page.mouse.move(empty.x, empty.y + 1);
    await clear();
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await page.mouse.move(empty.x + 1, empty.y + 1);
    ok('После blur то же значение отправляется заново', (await signals()).join() === 'true', await signals());

    // Выключатель снят в окне до запуска: слежения нет.
    const off = await browser.newPage({ viewport: { width: 1366, height: 768 } });
    await off.goto(`${BASE}/scripts/fixtures/desk-focus-ui.html?deskOff=1`);
    await off.locator('[data-flux-desk]').waitFor();
    await off.waitForTimeout(300);
    await off.mouse.move(empty.x, empty.y); await off.mouse.move(icon.x, icon.y);
    ok('Выключатель снят: окно не шлёт сигналов', (await off.evaluate(() => (window as any).__deskSignals.length)) === 0);
    await off.close();

    // «Параметры → Мониторы»: строка, замеры, обе темы.
    for (const theme of ['light', 'dark']) {
      const s = await browser.newPage({ viewport: { width: 1100, height: 700 } });
      await s.goto(`${BASE}/scripts/fixtures/desk-focus-ui.html?scene=settings${theme === 'dark' ? '&theme=dark' : ''}`);
      const toggle = s.getByRole('switch', { name: 'Нажатие по столу не выводит Flux поверх других программ' });
      await toggle.waitFor();
      const m = await s.evaluate(() => {
        const sw = [...document.querySelectorAll('[role=switch]')].find(x => /Нажатие по столу/.test(x.getAttribute('aria-label') || '')) as HTMLElement;
        const row = sw.closest('.fx-set-row') as HTMLElement;
        const title = row.querySelector('.fx-set-text') as HTMLElement;
        const desc = row.querySelector('.fx-set-desc') as HTMLElement;
        const [titleStyle, descStyle] = [title, desc].map(e => { const c = getComputedStyle(e); return { size: parseFloat(c.fontSize), weight: Number(c.fontWeight) }; });
        const rr = row.getBoundingClientRect(), sr = sw.getBoundingClientRect(), tr = title.getBoundingClientRect();
        return { row: { w: rr.width, h: rr.height }, title: titleStyle, desc: descStyle, sw: { w: sr.width, h: sr.height, right: rr.right - sr.right },
          overflow: row.scrollWidth > row.clientWidth + 1, textRight: tr.right <= sr.left + 1,
          upper: /[A-ZА-ЯЁ]{4,}/.test(title.firstChild?.textContent || '') };
      });
      ok(`${theme}: строка настройки без переполнения, текст слева, переключатель справа`, !m.overflow && m.textRight && m.sw.right >= 0, m);
      ok(`${theme}: название 13 / пояснение 12, вес 400–600, не мельче 12`, m.title.size >= 13 - .01 && m.desc.size >= 12 - .01 && [m.title.weight, m.desc.weight].every(w => [400, 500, 600].includes(w)), m);
      ok(`${theme}: заглавных слов нет`, !m.upper);
      ok(`${theme}: включён по умолчанию`, (await toggle.getAttribute('aria-checked')) === 'true');
      if (SHOTS) await s.screenshot({ path: `${SHOTS}/desk-focus-${theme}.png` });
      if (theme === 'light') {
        await toggle.click();
        ok('Нажатие по выключателю уходит в главный процесс и меняет состояние',
          (await toggle.getAttribute('aria-checked')) === 'false' && (await s.evaluate(() => (window as any).__deskSaved)).join() === 'false');
        await toggle.click();
        ok('Повторное нажатие включает снова', (await toggle.getAttribute('aria-checked')) === 'true');
      }
      await s.close();
    }
    if (SHOTS) {
      await page.mouse.move(empty.x, empty.y);
      await page.screenshot({ path: `${SHOTS}/desk-focus-desk.png` });
    }
    ok('Ошибок страницы нет', errors.length === 0, errors);
  } finally { await browser.close(); }
  console.log(`\nУспешно: ${passed}, провалов: ${failed}`);
  if (failed) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
