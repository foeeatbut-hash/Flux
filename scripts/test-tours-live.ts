/**
 * Демонстрации помощника указывают на то, что действительно есть на экране.
 *
 * Проверка написана по жалобе владельца: «подсказки должны показывать
 * правильное место». Показывали они не туда по причине, которую глазами видно
 * только в одной оболочке из трёх: шаги ссылались на пункты ЛЕВОГО МЕНЮ, а в
 * оболочке с панелью задач левого меню нет вовсе. Подсветка не появлялась, а
 * подсказка всё равно просила нажать подсвеченный элемент — человек искал то,
 * чего на экране нет.
 *
 * Поэтому здесь каждый шаг каждой демонстрации открывается по-настоящему и
 * проверяется, находится ли его цель. Проверка живая, потому что ответ зависит
 * от оболочки, от прав и от того, выбран ли проект, — по исходному коду этого
 * не узнать.
 *
 * Запуск (нужен поднятый сервер):
 *   npx tsx server.ts > /tmp/srv.log 2>&1 &
 *   npx tsx scripts/test-tours-live.ts
 */
import { TOURS } from '../src/assistant/tours';

const BASE = process.env.FLUX_API || 'http://localhost:3000';
const LOGIN = { symbol: process.env.FLUX_USER || 'RaupovKhKh', password: process.env.FLUX_PASS || '1122' };
const CHROME = process.env.FLUX_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let f = 0;
const ok = (n: string, c: boolean, d?: any) =>
  c ? console.log('  ✓', n) : (f++, console.error('  ✗', n, d !== undefined ? JSON.stringify(d).slice(0, 200) : ''));

(async () => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: CHROME });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  await page.route('**/api/license/status', (r: any) => r.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ licensed: true, machineId: 'TEST', expiresAt: Date.now() + 9e8, daysLeft: 30, reason: '' }),
  }));

  try {
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(6500);
    const inputs = await page.$$('input');
    await inputs[0].fill(LOGIN.symbol);
    await inputs[1].fill(LOGIN.password);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(8000);
    ok('вход выполнен', await page.evaluate(() => !!document.querySelector('[data-taskbar]')));

    // Без выбранного проекта половина разделов показывает заглушку, и цели
    // шагов в них не существуют по совершенно законной причине
    // Проект кладём туда же, где его помнит сама программа: ключ привязан к
    // человеку. Без выбранного проекта половина разделов показывает заглушку,
    // и цели шагов в них отсутствуют по совершенно законной причине
    await page.evaluate(async () => {
      const me = JSON.parse(localStorage.getItem('pdm_session_user') || 'null');
      const list = await (await fetch('/api/projects')).json();
      const first = Array.isArray(list) ? list[0] : (list?.projects || [])[0];
      if (me && first) localStorage.setItem(`max_active_project_${me.id}`, JSON.stringify(first));
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(7000);

    const missing: string[] = [];
    let checked = 0;
    let later = 0;

    for (const tour of TOURS) {
      for (const [i, step] of tour.steps.entries()) {
        if (!step.target) continue;
        // Цель, появляющаяся после действия человека (выбрал собеседника,
        // открыл карточку), сейчас отсутствовать вправе. Такие шаги помечены в
        // самих демонстрациях — считаем их отдельно, чтобы пометка не стала
        // способом спрятать забытую цель
        if (step.afterAction) { later++; continue; }
        checked++;
        if (step.route) {
          await page.evaluate((r: string) => { window.location.hash = '#' + r; }, step.route);
          await page.waitForTimeout(1800);
        }
        // Ищем так же, как подсветка: первый ВИДИМЫЙ элемент по метке. Один и
        // тот же раздел помечен в трёх местах, и в каждой оболочке видно
        // только одно из них — обычный поиск возвращал скрытый пункт меню
        const found = await page.evaluate((sel: string) => {
          try {
            return Array.from(document.querySelectorAll(sel)).some((el) => {
              const r = (el as HTMLElement).getBoundingClientRect();
              return r.width > 2 && r.height > 2;
            });
          } catch (_) { return false; }
        }, step.target);
        if (!found) missing.push(`${tour.id} шаг ${i + 1}: ${step.target}`);
      }
    }

    console.log(`Проверено целей: ${checked}; появляются после действия: ${later}`);
    ok('каждый шаг находит свою цель на экране', missing.length === 0, missing.slice(0, 12));
    // Пометка «появится позже» не должна расползтись по всем шагам подряд
    ok('таких шагов немного', later <= checked / 4, { later, checked });
  } catch (e: any) {
    f++;
    console.error('  ✗ проба не дошла до конца:', e?.message || e);
  } finally {
    await browser.close();
  }

  console.log(f ? `\nПровалено проверок: ${f}` : '\nПроверка демонстраций пройдена');
  process.exit(f ? 1 : 0);
})();
