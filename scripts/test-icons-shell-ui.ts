/**
 * Значки на экране: размеры по ролям, формат файла → вид значка, отсутствие
 * системных картинок Windows, обе темы. Меряется то, что видит человек
 * (getBoundingClientRect), а не разметка: значок, нарисованный 14 вместо 16 или
 * подменённый картинкой из оболочки, в разметке выглядит правильно.
 *
 * Стенды: scripts/fixtures/icons-shell.html (стол, панель задач, Пуск) и
 * windows-explorer-ui.html?mix=1 (Проводник, файлы разных форматов).
 *
 * Запуск: FLUX_UI_URL=http://127.0.0.1:5197 FLUX_CHROME=… npx tsx scripts/test-icons-shell-ui.ts
 */
import { BAR_BTN, BAR_H, BAR_ICON, DESK, ICON_SIZE, START_W, TILE_ICON, explorerIconSize } from '../src/lib/metrics';

const BASE = process.env.FLUX_UI_URL || 'http://127.0.0.1:5173';
const CHROME = process.env.FLUX_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
let passed = 0; let failed = 0;
const ok = (name: string, value: boolean, details?: unknown) => {
  if (value) { passed++; console.log('✓', name); } else { failed++; console.error('✗', name, details === undefined ? '' : JSON.stringify(details).slice(0, 300)); }
};
type Page = import('playwright-core').Page;
const FILES: Record<string, string> = {
  'Договор.docx': 'doc', 'Смета.xlsx': 'sheet', 'Ведомость.csv': 'sheet', 'Чертёж АР-01.pdf': 'pdf', 'Схема щита.dwg': 'cad',
  'Проект.e3s': 'e3', 'Заметки.md': 'markdown', 'Фото узла.png': 'image', 'Архив.zip': 'archive', 'Данные.json': 'code',
  'Доклад.pptx': 'slide', 'Обзор.mp4': 'video', 'Запись.wav': 'audio', 'Setup.exe': 'app', 'Ярлык.lnk': 'shortcut',
  'Старый.doc': 'doc', 'Журнал.log': 'text', 'Модель.sldprt': 'closed', 'Библиотека.dll': 'closed',
};
const box = (page: Page, selector: string) => page.locator(selector).first().evaluate((element) => {
  const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
});
const sizes = (page: Page, selector: string) => page.locator(selector).evaluateAll((nodes) => nodes.map((node) => { const r = node.getBoundingClientRect(); return `${Math.round(r.width)}x${Math.round(r.height)}`; }));

(async () => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const errors: string[] = [];
  const open = async (url: string) => {
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(`${BASE}/scripts/fixtures/${url}`);
    return page;
  };
  try {
    for (const theme of ['light', 'dark'] as const) {
      const t = theme === 'dark' ? 'тёмная' : 'светлая';
      // ── Стол и панель задач ─────────────────────────────────────────────
      const desk = await open(`icons-shell.html?scene=desktop&theme=${theme}`);
      await desk.getByRole('button', { name: 'Пуск' }).waitFor();
      await desk.locator('[data-desktop-item]').first().waitFor();
      await desk.waitForTimeout(500);
      const deskSizes = await sizes(desk, '[data-desktop-item] svg[data-kind], [data-desktop-item] > svg');
      ok(`[${t}] Стол: значки ${DESK.normal.icon} точек`, deskSizes.length >= 19 && deskSizes.every((value) => value === `${ICON_SIZE.desktop}x${ICON_SIZE.desktop}`), deskSizes);
      const cell = await box(desk, '[data-desktop-item]');
      ok(`[${t}] Стол: клетка ${DESK.normal.w} точек шириной`, Math.round(cell.w) === DESK.normal.w, cell);
      ok(`[${t}] Стол: картинок из Windows нет`, await desk.locator('[data-desktop-item] img, section[aria-label="Рабочий стол Windows"] img').count() === 0);
      for (const [name, kind] of Object.entries(FILES)) {
        const found = await desk.locator(`[data-desktop-item][role="button"]:has-text("${name.replace(/\.[^.]+$/, '')}") svg[data-kind="${kind}"]`).count();
        if (found !== 1) ok(`[${t}] Стол: «${name}» — вид «${kind}»`, false, found);
      }
      ok(`[${t}] Стол: все форматы нарисованы своим видом`, true);
      ok(`[${t}] Стол: у неоткрываемого формата — «закрытый» лист с подписью DLL`, await desk.locator('[data-desktop-item]:has-text("Библиотека") svg[data-kind="closed"] text').textContent() === 'DLL');
      const sheetFill = await desk.locator('[data-desktop-item]:has-text("Договор") svg[data-kind="doc"] path').first().evaluate((node) => getComputedStyle(node).fill);
      // Цвет приходит как rgb() или oklch(): светлота — первое число oklch либо среднее rgb
      const lightness = (css: string) => css.startsWith('oklch') ? Number(css.match(/oklch\(([\d.]+)/)![1]) : css.match(/\d+/g)!.slice(0, 3).reduce((sum, part) => sum + Number(part), 0) / 765;
      ok(`[${t}] Лист файла: ${theme === 'dark' ? 'тёмный' : 'светлый'} фон`, theme === 'dark' ? lightness(sheetFill) < 0.4 : lightness(sheetFill) > 0.95, sheetFill);
      const bar = await desk.evaluate(() => {
        const start = document.querySelector('button[aria-label="Пуск"]')!; let node: HTMLElement | null = start.parentElement;
        while (node && node.getBoundingClientRect().width < 1000) node = node.parentElement;
        const r = node!.getBoundingClientRect(); return { h: r.height, bottom: r.bottom };
      });
      ok(`[${t}] Панель задач: высота ${BAR_H}, прижата к низу`, Math.round(bar.h) === BAR_H && Math.round(bar.bottom) === 768, bar);
      const buttons = desk.locator('button[data-tour^="nav-"]');
      const first = await buttons.first().evaluate((element) => { const r = element.getBoundingClientRect(); const s = element.querySelector('svg')!.getBoundingClientRect(); return { bw: r.width, bh: r.height, sw: s.width, sh: s.height, inside: s.left >= r.left && s.right <= r.right && s.top >= r.top && s.bottom <= r.bottom }; });
      ok(`[${t}] Панель задач: значок ${BAR_ICON} в кнопке ${BAR_BTN}`, Math.round(first.sw) === BAR_ICON && Math.round(first.sh) === BAR_ICON && Math.round(first.bw) === BAR_BTN && Math.round(first.bh) === BAR_BTN && first.inside, first);
      ok(`[${t}] Горизонтальной прокрутки нет`, await desk.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
      await desk.close();

      // ── Пуск ────────────────────────────────────────────────────────────
      const start = await open(`icons-shell.html?scene=start&theme=${theme}`);
      const dialog = start.getByRole('dialog', { name: 'Пуск' });
      await dialog.waitFor();
      const tile = await dialog.locator('button[data-tour^="nav-"]').first().evaluate((element) => {
        const r = element.getBoundingClientRect(); const s = element.querySelector('svg')!.getBoundingClientRect(); const label = element.querySelector('span.text-xs')!.getBoundingClientRect();
        return { w: r.width, sw: s.width, sh: s.height, labelBelow: label.top >= s.bottom - 0.5, inside: s.left >= r.left && s.right <= r.right };
      });
      ok(`[${t}] Пуск: значок плитки ${TILE_ICON}, подпись под значком`, Math.round(tile.sw) === TILE_ICON && Math.round(tile.sh) === TILE_ICON && tile.labelBelow && tile.inside, tile);
      const dialogBox = await box(start, '[role="dialog"][aria-label="Пуск"]');
      ok(`[${t}] Пуск: ширина ${START_W}, меню не выходит за экран`, Math.round(dialogBox.w) === START_W && dialogBox.right <= 1366 && dialogBox.y >= 0, dialogBox);
      const overflow = await dialog.locator('button[data-tour^="nav-"]').evaluateAll((nodes, width) => nodes.filter((node) => { const r = node.getBoundingClientRect(); const p = node.closest('[role="dialog"]')!.getBoundingClientRect(); return r.right > p.right || r.left < p.left || node.scrollWidth > node.clientWidth + 1 || r.width < 60 || width < 0; }).length, 0);
      ok(`[${t}] Пуск: плитки не вылезают за меню и не сжаты`, overflow === 0, overflow);
      ok(`[${t}] Пуск: картинок из Windows нет`, await dialog.locator('img').count() === 0);
      await start.close();

      // ── Проводник ───────────────────────────────────────────────────────
      const explorer = await open('windows-explorer-ui.html?mix=1');
      await explorer.evaluate((value) => document.documentElement.classList.toggle('dark', value === 'dark'), theme);
      await explorer.getByRole('row', { name: /Договор\.docx/ }).waitFor();
      const rowKinds = await explorer.locator('[role="row"][data-entry-key]').evaluateAll((rows) => rows.map((row) => ({ text: row.textContent || '', kind: row.querySelector('svg[data-kind]')?.getAttribute('data-kind') || (row.querySelector('svg') ? 'folder' : ''), size: Math.round(row.querySelector('svg')?.getBoundingClientRect().width || 0), img: row.querySelectorAll('img').length })));
      ok(`[${t}] Проводник, таблица: у каждой строки значок 16 точек`, rowKinds.length >= 20 && rowKinds.every((row) => row.size === ICON_SIZE.row && row.img === 0), rowKinds.filter((row) => row.size !== 16 || row.img));
      const wrong = Object.entries(FILES).filter(([name, kind]) => rowKinds.find((row) => row.text.includes(name))?.kind !== kind);
      ok(`[${t}] Проводник, таблица: формат файла → вид значка (в том числе .dll и .sldprt — «закрытый»)`, wrong.length === 0, wrong);
      ok(`[${t}] Проводник: панель навигации — значки 16, картинок нет`, (await sizes(explorer, '[data-place-icon] svg')).every((value) => value === '16x16') && await explorer.locator('[data-nav-pane] img').count() === 0);

      const views: Array<[string, string]> = [['Мелкие значки', 'small'], ['Список', 'list'], ['Плитки', 'tiles'], ['Содержимое', 'content'], ['Обычные значки', 'medium'], ['Крупные значки', 'large'], ['Огромные значки', 'extraLarge']];
      for (const [label, layout] of views) {
        await explorer.getByRole('button', { name: 'Просмотреть' }).click();
        await explorer.locator('[data-context-menu]').getByRole('button', { name: label, exact: true }).click();
        await explorer.waitForTimeout(400);
        const want = explorerIconSize(layout);
        const measured = await explorer.locator('[data-entry-key]').evaluateAll((rows) => rows.slice(0, 12).map((row) => {
          const mark = row.querySelector('svg, img'); const r = row.getBoundingClientRect(); const m = mark?.getBoundingClientRect();
          return { w: Math.round(m?.width || 0), h: Math.round(m?.height || 0), inside: !!m && m.left >= r.left - 1 && m.right <= r.right + 1 && m.top >= r.top - 1 && m.bottom <= r.bottom + 1 };
        }));
        ok(`[${t}] Проводник, «${label}»: значок ${want} точек и он внутри своей клетки`, measured.length > 0 && measured.every((item) => item.w === want && item.h === want && item.inside), measured.filter((item) => item.w !== want || !item.inside));
        if (layout === 'large' && theme === 'light') {
          const photo = await explorer.locator('[data-entry-key]:has-text("Фото узла") img').count();
          ok('Проводник, крупные: у картинки — настоящая миниатюра содержимого, у остальных — значок Flux', photo === 1 && await explorer.locator('[data-entry-key] img').count() === 1);
        }
      }
      const thumbCalls: any[] = await explorer.evaluate(() => (window as any).__windowsFilesCalls.filter((call: any) => call.action === 'thumbnail'));
      ok(`[${t}] Миниатюры просятся только с thumbnailOnly: системный значок оболочки не запрашивается`, thumbCalls.length > 0 && thumbCalls.every((call) => call.thumbnailOnly === true), thumbCalls.slice(0, 2));
      const iconCalls = await explorer.evaluate(() => (window as any).__windowsFilesCalls.filter((call: any) => call.action === 'placeIcon' || call.action === 'icon').length);
      ok(`[${t}] Проводник не обращается к значкам оболочки (icon, placeIcon)`, iconCalls === 0, iconCalls);
      ok(`[${t}] Горизонтальной прокрутки в Проводнике нет`, await explorer.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
      await explorer.close();
    }
  } finally { await browser.close(); }
  ok('Нет ошибок браузера', errors.length === 0, errors.slice(0, 3));
  console.log(`\n${passed} проверок пройдено, ${failed} провалено`);
  process.exit(failed ? 1 : 0);
})();
