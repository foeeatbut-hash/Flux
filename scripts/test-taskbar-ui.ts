/**
 * Панель задач и правые панели на экране: метки запуска, карточки окон при
 * наведении, центр уведомлений с календарём и помощник.
 *
 * Меряется то, что видит человек (getBoundingClientRect, computed style), а не
 * разметка: метка шириной в шесть точек, спрятанная обрезкой полосы кнопок,
 * в разметке выглядела бы правильно (так оно и было).
 *
 * Стенд: scripts/fixtures/taskbar-win11.html — настоящие WindowsLayer, Taskbar
 * и RightDock; мост снимков подменён картинкой на canvas, поэтому проверяется
 * вся цепочка «наведение → запрос → карточка», но не сам capturePage.
 *
 * Запуск: FLUX_UI_URL=http://127.0.0.1:5391 FLUX_CHROME=… npx tsx scripts/test-taskbar-ui.ts
 */
const BASE = process.env.FLUX_UI_URL || 'http://127.0.0.1:5173';
import { findChrome } from './chromePath';
const CHROME = findChrome();
let passed = 0; let failed = 0;
const ok = (name: string, value: boolean, details?: unknown) => {
  if (value) { passed++; console.log('✓', name); } else { failed++; console.error('✗', name, details === undefined ? '' : JSON.stringify(details).slice(0, 300)); }
};
type Page = import('playwright-core').Page;

/** Окна открываются по одному с паузой: снимок «последнего вида» берётся при смене верхнего окна */
async function openWindows(page: Page) {
  const run = (fn: string, arg?: string) => page.evaluate(([f, a]) => {
    const s = (window as any).__fx.windows.getState();
    if (f === 'minCal') s.minimize(s.windows.find((x: any) => x.path === '/calendar').id); else s[f](a);
  }, [fn, arg]);
  for (const [fn, arg] of [['open', '/calendar'], ['open', '/registry'], ['openAnother', '/registry'], ['open', '/equipment'], ['minCal', '']]) {
    await run(fn, arg); await page.waitForTimeout(350);
  }
}

(async () => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const errors: string[] = [];
  const open = async (query = '') => {
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text().slice(0, 200)); });
    await page.goto(`${BASE}/scripts/fixtures/taskbar-win11.html${query}`);
    await page.waitForSelector('[data-taskbar]');
    return page;
  };
  const count = (page: Page, sel: string) => page.locator(sel).count();
  try {
    for (const theme of ['light', 'dark'] as const) {
      const t = theme === 'dark' ? 'тёмная' : 'светлая';
      const page = await open(`?theme=${theme}`);
      await openWindows(page);
      const bar = await page.locator('[data-taskbar]').evaluate((el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; });

      // ── Метки запуска ────────────────────────────────────────────────────
      const marks = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('button[data-tour^="nav-"]')].map((b) => {
        const m = b.querySelector('[data-run-mark]');
        if (!m) return [b.getAttribute('data-tour'), null];
        const r = m.getBoundingClientRect(); const br = b.getBoundingClientRect();
        return [b.getAttribute('data-tour'), { kind: m.getAttribute('data-run-mark'), w: Math.round(r.width), h: Math.round(r.height), color: getComputedStyle(m).backgroundColor, inside: r.bottom <= br.bottom + 0.5 && r.top >= br.top }];
      })));
      const active = marks['nav-/equipment'] as any; const open1 = marks['nav-/registry'] as any; const min1 = marks['nav-/calendar'] as any;
      ok(`[${t}] Метка: активная длинная (16), открытая короче, свёрнутая самая короткая`, active?.w === 16 && open1?.w === 6 && min1?.w === 4, { active, open1, min1 });
      ok(`[${t}] Метка: у закрытой программы её нет`, marks['nav-/notes'] === null || marks['nav-/notes'] === undefined);
      ok(`[${t}] Метка: цвета различаются — акцентная, серая, бледная`, new Set([active?.color, open1?.color, min1?.color]).size === 3, { active, open1, min1 });
      ok(`[${t}] Метка видна: лежит внутри кнопки, а не под обрезкой полосы`, [active, open1, min1].every((m) => m?.inside));

      // ── Наведение: карточки окон ─────────────────────────────────────────
      const reg = page.locator('button[data-tour="nav-/registry"]');
      await reg.hover();
      await page.waitForTimeout(250);
      ok(`[${t}] Карточки: раньше 400 мс не появляются`, await count(page, '[data-taskbar-peek]') === 0);
      await page.waitForTimeout(350);
      ok(`[${t}] Карточки: после задержки видны`, await count(page, '[data-taskbar-peek]') === 1);
      const cards = page.locator('[data-peek-card]');
      ok(`[${t}] Карточки: по одной на каждое из двух окон программы`, await cards.count() === 2, await cards.count());
      const card = await cards.first().evaluate((el) => ({
        icons: el.querySelectorAll('svg').length, img: !!el.querySelector('img'), text: (el.textContent || '').trim(),
        close: !!el.querySelector('button[aria-label="Закрыть окно"]'),
      }));
      ok(`[${t}] Карточка: значок, заголовок, крестик и снимок`, card.icons >= 2 && card.text.includes('Теги') && card.close && card.img, card);
      ok(`[${t}] Снимки запрошены у основного процесса до показа карточек`, (await page.evaluate(() => (window as any).__fx.thumbCalls.length)) > 0);
      const geo = await page.evaluate(() => {
        const peek = document.querySelector('[data-taskbar-peek]')!.getBoundingClientRect();
        const btn = document.querySelector('button[data-tour="nav-/registry"]')!.getBoundingClientRect();
        return { bottom: peek.bottom, left: peek.left, right: peek.right, btnTop: btn.top, vw: innerWidth };
      });
      ok(`[${t}] Карточки стоят над панелью задач и не выходят за экран`, geo.bottom <= bar.top + 1.5 && geo.left >= 0 && geo.right <= geo.vw, { geo, bar });

      // Наведение на карточку подсвечивает окно на столе
      await cards.first().hover();
      await page.waitForTimeout(100);
      const lit = await page.evaluate(() => ({ peeked: (window as any).__fx.windows.getState().peeked, ids: [...document.querySelectorAll('[data-peek-card]')].map((e) => e.getAttribute('data-peek-card')) }));
      ok(`[${t}] Наведение на карточку подсвечивает её окно`, lit.peeked === lit.ids[0], lit);

      // Переход на соседнюю кнопку: карточки переезжают, а не мигают
      await page.evaluate(() => document.querySelector('[data-taskbar-peek]')!.setAttribute('data-marker', 'same'));
      await page.locator('button[data-tour="nav-/calendar"]').hover();
      await page.waitForTimeout(120);
      const moved = await page.evaluate(() => ({ same: document.querySelector('[data-taskbar-peek]')?.getAttribute('data-marker') === 'same', cards: document.querySelectorAll('[data-peek-card]').length, text: document.querySelector('[data-taskbar-peek]')?.textContent || '' }));
      ok(`[${t}] Переход на соседнюю кнопку: те же карточки, без паузы в 400 мс`, moved.same && moved.cards === 1 && moved.text.includes('Календарь'), moved);
      ok(`[${t}] У свёрнутого окна карточка с последним снимком и пометкой`, moved.text.includes('свёрнуто') && await page.locator('[data-peek-card] img').count() === 1);

      // Уход мыши гасит карточки
      await page.mouse.move(600, 300);
      await page.waitForTimeout(250);
      ok(`[${t}] Уход мыши гасит карточки`, await count(page, '[data-taskbar-peek]') === 0);
      ok(`[${t}] И снимает подсветку окна`, await page.evaluate(() => (window as any).__fx.windows.getState().peeked === null));

      // Мышь доходит от кнопки до карточки, не погасив её
      await reg.hover(); await page.waitForTimeout(600);
      const cardBox = await page.locator('[data-peek-card]').first().boundingBox();
      await page.mouse.move(cardBox!.x + 30, cardBox!.y + 30, { steps: 6 });
      await page.waitForTimeout(200);
      ok(`[${t}] Мышь доходит от кнопки до карточки: они остаются`, await count(page, '[data-taskbar-peek]') === 1);

      // Щелчок по карточке поднимает окно; крестик закрывает
      const firstId = await page.locator('[data-peek-card]').nth(1).getAttribute('data-peek-card');
      await page.locator('[data-peek-card]').nth(1).click();
      await page.waitForTimeout(200);
      const topId = await page.evaluate(() => { const s = (window as any).__fx.windows.getState(); return s.windows.reduce((a: any, b: any) => (b.z > a.z ? b : a)).id; });
      ok(`[${t}] Щелчок по карточке поднимает окно`, topId === firstId, { topId, firstId });
      ok(`[${t}] и закрывает карточки`, await count(page, '[data-taskbar-peek]') === 0);
      await page.mouse.move(600, 300);

      // Средняя кнопка по карточке закрывает окно
      await reg.hover(); await page.waitForTimeout(600);
      const before = await page.evaluate(() => (window as any).__fx.windows.getState().windows.length);
      await page.locator('[data-peek-card]').first().click({ button: 'middle' });
      await page.waitForTimeout(500);
      const after = await page.evaluate(() => (window as any).__fx.windows.getState().windows.length);
      ok(`[${t}] Средняя кнопка по карточке закрывает окно`, after === before - 1, { before, after });
      await page.mouse.move(600, 300); await page.waitForTimeout(250);

      // ── Правая кнопка ────────────────────────────────────────────────────
      await reg.click({ button: 'right' });
      await page.getByRole('button', { name: 'Открепить от панели' }).or(page.getByRole('button', { name: 'Закрепить на панели' })).first().waitFor();
      ok(`[${t}] Меню программы: открыть, закрепить, закрыть окно`, await page.getByRole('button', { name: 'Открыть', exact: true }).count() === 1
        && await page.getByRole('button', { name: /Закрыть окно|Закрыть все окна/ }).count() === 1);
      await page.keyboard.press('Escape');

      // ── Центр уведомлений и календарь ────────────────────────────────────
      const tray = await page.evaluate(() => {
        const bell = document.querySelector('[data-tour="notif-btn"]')!.getBoundingClientRect();
        const clock = document.querySelector('[data-tour="clock-btn"]')!.getBoundingClientRect();
        const edge = document.querySelector('button[aria-label="Свернуть все окна"]')!.getBoundingClientRect();
        return { bellRight: bell.right, clockLeft: clock.left, clockRight: clock.right, edgeLeft: edge.left, vw: innerWidth };
      });
      ok(`[${t}] Колокольчик вплотную слева от часов, часы у самого угла`, tray.clockLeft - tray.bellRight <= 2 && tray.edgeLeft - tray.clockRight <= 10 && tray.vw - tray.clockRight < 30, tray);
      await page.locator('[data-tour="clock-btn"]').click();
      await page.waitForSelector('[data-dock-notifications]');
      await page.waitForTimeout(500);
      const dock = await page.evaluate(() => {
        const n = document.querySelector('[data-dock-notifications]')!.getBoundingClientRect();
        const c = document.querySelector('[data-dock-calendar]')!.getBoundingClientRect();
        const radius = getComputedStyle(document.querySelector('[data-dock-notifications]')!).borderTopLeftRadius;
        const today = document.querySelector('[data-today]')?.textContent?.trim();
        return { nBottom: n.bottom, cTop: c.top, cBottom: c.bottom, right: Math.max(n.right, c.right), radius, today, vw: innerWidth, groups: document.querySelectorAll('[data-notif-group]').length };
      });
      ok(`[${t}] Клик по часам: сверху уведомления, под ними календарь`, dock.nBottom <= dock.cTop + 0.5, dock);
      ok(`[${t}] Карточки скруглены и стоят над панелью задач у правого края`, parseFloat(dock.radius) >= 8 && dock.cBottom <= bar.top && dock.vw - dock.right >= 4 && dock.vw - dock.right <= 16, dock);
      ok(`[${t}] В календаре отмечен сегодняшний день`, dock.today === String(new Date().getDate()), dock);
      ok(`[${t}] Уведомления сгруппированы по программам`, dock.groups === 2, dock);
      ok(`[${t}] Фон карточек — класс fx-glass`, await page.locator('[data-dock-notifications].fx-glass, [data-dock-calendar].fx-glass').count() === 2);
      // Календарь складывается и помнит это
      await page.locator('[data-dock-calendar] button[aria-expanded]').first().click();
      ok(`[${t}] Календарь складывается до строки с датой`, await count(page, '[data-today]') === 0);
      await page.locator('[data-dock-calendar] button[aria-expanded]').first().click();

      // Помощник рядом, без перекрытия
      await page.locator('[data-tour="guide-btn"]').click();
      await page.waitForSelector('[data-dock-assistant]');
      await page.waitForTimeout(500);
      const cols = await page.evaluate(() => [...document.querySelectorAll('[data-dock-column]')].map((c) => { const r = c.getBoundingClientRect(); return { id: c.getAttribute('data-dock-column'), l: r.left, r: r.right, b: r.bottom }; }).sort((a, b) => a.l - b.l));
      ok(`[${t}] Помощник — левее уведомлений, колонки не перекрываются`, cols.length === 2 && cols[0].id === 'assistant' && cols[0].r <= cols[1].l + 0.5, cols);
      ok(`[${t}] Обе колонки над панелью задач`, cols.every((c) => c.b <= bar.top));
      await page.screenshot({ path: `/tmp/flux-tb-${theme}.png` });

      // Щелчок мимо закрывает уведомления, помощник остаётся
      await page.mouse.click(300, 300);
      await page.waitForTimeout(400);
      ok(`[${t}] Щелчок мимо закрывает уведомления`, await count(page, '[data-dock-notifications]') === 0);
      ok(`[${t}] а помощник остаётся`, await count(page, '[data-dock-assistant]') === 1);
      await page.locator('[data-tour="guide-btn"]').click();
      await page.waitForTimeout(400);
      ok(`[${t}] Кнопка помощника в трее закрывает его`, await count(page, '[data-dock-assistant]') === 0);

      // «Удалить все»
      await page.locator('[data-tour="notif-btn"]').click();
      await page.waitForSelector('[data-dock-notifications]');
      await page.getByRole('button', { name: 'Удалить все' }).click();
      await page.waitForTimeout(200);
      ok(`[${t}] «Удалить все» очищает ленту`, await count(page, '[data-notif-group]') === 0);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
      ok(`[${t}] Esc закрывает центр уведомлений`, await count(page, '[data-dock-notifications]') === 0);
      await page.close();
    }

    // ── Браузер без Electron: вместо снимка значок программы ────────────────
    const plain = await open('?bridge=0');
    await openWindows(plain);
    await plain.locator('button[data-tour="nav-/registry"]').hover();
    await plain.waitForTimeout(700);
    const stub = await plain.locator('[data-peek-card]').first().evaluate((el) => ({ img: el.querySelectorAll('img').length, svg: el.querySelectorAll('svg').length, text: (el.textContent || '').trim() }));
    ok('Без Electron: вместо снимка значок и заголовок', stub.img === 0 && stub.svg >= 2 && stub.text.includes('Теги'), stub);
    await plain.close();

    ok('Ошибок в консоли нет', errors.length === 0, errors.slice(0, 3));
  } finally {
    await browser.close();
  }
  console.log(failed ? `\nПровалено проверок: ${failed} из ${passed + failed}` : `\nВсе проверки панели задач на экране пройдены (${passed})`);
  process.exit(failed ? 1 : 0);
})();
