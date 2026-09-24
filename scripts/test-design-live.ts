/**
 * Вид разделов по методологии — замер вычисленных стилей в живой программе.
 *
 * Храповик в test-architecture считает классы в разметке, но не видит, что
 * получилось на экране: жирный может прийти из браузерного <b>, заглавные —
 * из чужого класса, мелкий кегль — из inline-стиля. Здесь меряется то, что
 * человек видит в окне раздела (docs/methodology/01-design.md):
 *   - текста весом 700 и больше нет;
 *   - мельче 12 px текста нет, кроме счётчиков fx-badge и инициалов fx-av;
 *   - заглавных нет;
 *   - у переведённых разделов строки таблиц и списков — 28–40 px.
 *
 * Запуск (нужен поднятый сервер):  npx tsx scripts/test-design-live.ts
 * SHOTS=1 — снимки окон в /tmp/flux-design; THEME=dark — тёмная тема;
 * ONLY=/logs,/users — только эти разделы.
 */
const BASE = process.env.FLUX_API || 'http://localhost:3000';
const LOGIN = { symbol: process.env.FLUX_USER || 'RaupovKhKh', password: process.env.FLUX_PASS || '1122' };
const CHROME = process.env.FLUX_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const THEME = process.env.THEME === 'dark' ? 'dark' : 'light';
const SHOTS = process.env.SHOTS === '1' ? `/tmp/flux-design/${THEME}` : '';
const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);

let f = 0;
const ok = (n: string, c: boolean, d?: any) =>
  c ? console.log('  ✓', n) : (f++, console.error('  ✗', n, d !== undefined ? JSON.stringify(d).slice(0, 300) : ''));

/**
 * Разделы и признак «переведён»: у переведённого проверяется ещё и высота
 * строк. Список пополняется по мере перевода — страница программы в
 * docs/methodology/03-programs/ пишется тогда же.
 */
const SECTIONS: Array<[string, string, boolean]> = [
  ['Главная', '/', true],
  ['Проекты', '/projects', true],
  ['Теги', '/registry', true],
  ['Оборудование', '/equipment', true],
  ['Справочник', '/directory', true],
  ['Менеджмент', '/management', true],
  ['Настройки', '/settings', true],
  ['Журнал', '/logs', true],
  ['Сотрудники', '/users', true],
  ['Мессенджер', '/chat', true],
];

const PROBE = String.raw`(() => {
  const wins = [...document.querySelectorAll('[data-win]')].filter((w) => w.style.display !== 'none').sort((a, b) => +b.style.zIndex - +a.style.zIndex);
  const root = (wins[0] && wins[0].querySelector('[data-window-body]')) || document.body;
  const rr = root.getBoundingClientRect();
  const out = { bold: [], small: [], upper: [], rows: [] };
  for (const el of root.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || r.bottom < rr.top || r.top > rr.bottom) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') continue;
    // Строка данных, а не пустое состояние или прокладка виртуального списка:
    // у тех одна ячейка на всю ширину
    if (el.tagName === 'TR' && el.parentElement && el.parentElement.tagName === 'TBODY' && el.cells.length > 1) out.rows.push(Math.round(r.height));
    if (el.classList.contains('fx-li')) out.rows.push(Math.round(r.height));
    if (el.closest('.fx-badge, .fx-av, .stamp, .graf, svg, [data-art]')) continue;
    for (const n of el.childNodes) {
      if (n.nodeType !== 3) continue;
      const t = n.textContent.trim();
      if (!t || !/[A-Za-zА-Яа-яЁё]/.test(t)) continue;
      const s = t.slice(0, 40);
      if (+cs.fontWeight >= 700) out.bold.push(s);
      if (parseFloat(cs.fontSize) < 11.5) out.small.push(s + ' ' + cs.fontSize);
      if (cs.textTransform === 'uppercase') out.upper.push(s);
    }
  }
  return out;
})()`;

(async () => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const jsErrors: string[] = [];
  page.on('pageerror', (e: any) => jsErrors.push(String(e.message).slice(0, 160)));
  await page.route('**/api/license/status', (r: any) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ licensed: true, machineId: 'TEST', expiresAt: Date.now() + 9e8, daysLeft: 30, reason: '' }),
  }));
  try {
    console.log('1. Вход');
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(6500);
    const inputs = await page.$$('input');
    await inputs[0].fill(LOGIN.symbol);
    await inputs[1].fill(LOGIN.password);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(8000);
    ok('вход выполнен', await page.evaluate(() => !!document.querySelector('[data-taskbar]')));
    await page.evaluate(async () => {
      const me = JSON.parse(localStorage.getItem('pdm_session_user') || 'null');
      const list = await (await fetch('/api/projects')).json();
      const first = Array.isArray(list) ? list[0] : (list?.projects || [])[0];
      if (me && first) localStorage.setItem(`max_active_project_${me.id}`, JSON.stringify(first));
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(6500);
    if (THEME === 'dark') await page.evaluate(() => document.documentElement.classList.add('dark'));
    if (SHOTS) (await import('fs')).mkdirSync(SHOTS, { recursive: true });

    console.log('\n2. Разделы');
    for (const [name, path, done] of SECTIONS) {
      if (ONLY.length && !ONLY.includes(path)) continue;
      if (path === '/') {
        // Адрес «/» — это рабочий стол; Главная открывается из подвала Пуска
        await page.click('button[aria-label="Пуск"]');
        await page.waitForTimeout(700);
        await page.click('[role="dialog"][aria-label="Пуск"] button[title="Главная — сводка по проекту"]');
      } else {
        await page.evaluate((p: string) => { window.location.hash = '#' + p; }, path);
      }
      await page.waitForTimeout(3500);
      const p: any = await page.evaluate(PROBE);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/${path.replace(/\W/g, '') || 'home'}.png` });
      ok(`${name}: текста весом 700 нет`, p.bold.length === 0, p.bold.slice(0, 4));
      ok(`${name}: мельче 12 px текста нет`, p.small.length === 0, p.small.slice(0, 4));
      ok(`${name}: заглавных нет`, p.upper.length === 0, p.upper.slice(0, 4));
      if (done && p.rows.length) {
        const off = p.rows.filter((h: number) => h < 28 || h > 40);
        ok(`${name}: строки 28–40 px`, off.length <= Math.floor(p.rows.length / 10), { всего: p.rows.length, вне: off.slice(0, 6) });
      }
    }

    console.log('\n3. Тишина в консоли');
    ok('ни исключений, ни ошибок отрисовки', jsErrors.length === 0, Array.from(new Set(jsErrors)).slice(0, 5));
  } finally {
    await browser.close();
  }
  console.log(f ? `\nПРОВАЛОВ: ${f}` : '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ');
  process.exit(f ? 1 : 0);
})();
