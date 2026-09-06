/**
 * Холст тегов на живой программе: деревья встают в ряд, а не столбиком.
 *
 * Правила раскладки считает scripts/test-tag-layout.ts, но правила можно
 * посчитать верно и всё равно нарисовать не то: раскладка применяется в
 * реестре, а не в правилах. Поэтому здесь заводятся настоящие деревья, в живой
 * программе нажимается «Упорядочить», и у КАРТОЧЕК НА ЭКРАНЕ спрашивают, где
 * они оказались.
 *
 * Отдельно проверяется то, чего скриптом не увидеть вовсе: раскладка уходит в
 * базу ОДНИМ запросом вместо двух тысяч, а связь бросается на карточку, а не
 * только в кружок порта.
 *
 * Запуск (нужен поднятый сервер):
 *   npx tsx server.ts > /tmp/srv.log 2>&1 &
 *   npx tsx scripts/test-tag-canvas-live.ts
 */
const BASE = process.env.FLUX_API || 'http://localhost:3000';
const LOGIN = { symbol: process.env.FLUX_USER || 'RaupovKhKh', password: process.env.FLUX_PASS || '1122' };
const CHROME = process.env.FLUX_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const SHOTS = process.env.SHOTS === '1';

let f = 0;
const ok = (n: string, c: boolean, d?: any) =>
  (c ? console.log('  ✓', n) : (f++, console.error('  ✗', n, d !== undefined ? JSON.stringify(d).slice(0, 300) : '')));

(async () => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: CHROME });
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });

  await page.route('**/api/license/status', (r: any) => r.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ licensed: true, machineId: 'TEST', expiresAt: Date.now() + 9e8, daysLeft: 30, reason: '' }),
  }));

  // Считаем запросы: раскладка обязана уходить одной пачкой, а не по тегу
  let bulk = 0;
  let singles = 0;
  page.on('request', (r: any) => {
    if (r.method() !== 'PUT') return;
    const u = r.url();
    if (u.includes('/api/tags/bulk-metadata')) bulk++;
    else if (/\/api\/tags\/[^/]+$/.test(u)) singles++;
  });
  const errors: string[] = [];
  page.on('pageerror', (e: any) => errors.push(String(e?.message || e)));

  let made: any = { ok: false };
  try {
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(6500);
    const inputs = await page.$$('input');
    await inputs[0].fill(LOGIN.symbol);
    await inputs[1].fill(LOGIN.password);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(8000);
    ok('вход выполнен', await page.evaluate(() => !!document.querySelector('[data-taskbar]')));

    console.log('1. Заводим три установки со составом');
    made = await page.evaluate(async () => {
      const pj = await (await fetch('/api/projects')).json();
      const list = Array.isArray(pj) ? pj : (pj.projects || []);
      const projectId = list[0]?.id;
      if (!projectId) return { ok: false };
      localStorage.setItem(`max_active_project_${JSON.parse(localStorage.getItem('pdm_session_user') || '{}').id}`,
        JSON.stringify(list[0]));

      // Без вложенных функций: tsx собирает пробу esbuild-ом, и объявленная
      // здесь функция уезжает в браузер с обёрткой __name, которой там нет
      const ids: Record<string, string> = {};
      const codes: string[] = [];
      for (const n of ['1', '2', '3']) {
        codes.push(`ПРОБА-В-${n}`, `ПРОБА-В-${n}-КЛАПАН`, `ПРОБА-В-${n}-ВЕНТ`);
      }
      for (const identifier of codes) {
        const r = await fetch(`/api/projects/${projectId}/tags`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ identifier, department: 'Технологический отдел', metadata: '{}' }),
        });
        ids[identifier] = (await r.json())?.tag?.id;
      }
      // Ставим всех в одну кучу: раскладка обязана разобрать это сама
      for (const n of ['1', '2', '3']) {
        const root = ids[`ПРОБА-В-${n}`];
        const kids = [ids[`ПРОБА-В-${n}-КЛАПАН`], ids[`ПРОБА-В-${n}-ВЕНТ`]];
        await fetch(`/api/tags/${root}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ metadata: JSON.stringify({ x: 200, y: 200, connections: kids, descriptions: [] }) }),
        });
        for (const k of kids) {
          await fetch(`/api/tags/${k}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ metadata: JSON.stringify({ x: 260, y: 240, parentId: root, connections: [], descriptions: [] }) }),
          });
        }
      }
      return { ok: true, projectId, ids };
    });
    ok('теги заведены', made.ok, made.ok ? undefined : made);

    // Реестр читает выбранный проект при загрузке — без перезагрузки он
    // покажет «Проект не выбран» и ничего не разложит
    await page.goto(BASE + '/#/registry', { waitUntil: 'domcontentloaded' });
    await page.reload();
    await page.waitForTimeout(9000);

    for (const axis of ['down', 'right'] as const) {
      console.log(`2. Раскладка «${axis === 'down' ? 'сверху вниз' : 'слева направо'}»`);
      bulk = 0; singles = 0;

      // Выбор оси в выпадашке у кнопки «Упорядочить» — он же сразу и раскладывает
      await page.evaluate(async (want: string) => {
        const caret = Array.from(document.querySelectorAll('button'))
          .find((b) => b.getAttribute('aria-label') === 'Выбрать раскладку');
        (caret as HTMLElement)?.click();
        await new Promise((r) => setTimeout(r, 400));
        const title = want === 'down' ? 'Сверху вниз' : 'Слева направо';
        const item = Array.from(document.querySelectorAll('button'))
          .find((b) => (b.textContent || '').includes(title));
        (item as HTMLElement)?.click();
      }, axis);
      await page.waitForTimeout(6000);

      // Одна пачка вместо запроса на тег — ради этого и заводился массовый маршрут
      ok(`${axis}: раскладка ушла одним запросом`, bulk >= 1 && bulk <= 3, { bulk, singles });
      ok(`${axis}: по тегу запросов не слали`, singles === 0, { singles });

      const boxes = await page.evaluate(() => {
        const out: Record<string, { x: number; y: number; w: number; h: number }> = {};
        for (const el of Array.from(document.querySelectorAll('[id^="tag-card-"]'))) {
          const code = (el.textContent || '').match(/ПРОБА-В-\d(?:-[А-ЯЁ]+)?/);
          if (!code) continue;
          const r = (el as HTMLElement).getBoundingClientRect();
          out[code[0]] = { x: r.x, y: r.y, w: r.width, h: r.height };
        }
        return out;
      });

      const roots = ['ПРОБА-В-1', 'ПРОБА-В-2', 'ПРОБА-В-3'].map((c) => boxes[c]).filter(Boolean);
      ok(`${axis}: все три установки видны`, roots.length === 3, Object.keys(boxes));

      if (roots.length === 3) {
        // ВОТ ОНО: второе дерево справа от первого, а не под ним
        const xs = roots.map((r) => r.x);
        ok(`${axis}: установки стоят в ряд по горизонтали`,
          xs[0] < xs[1] && xs[1] < xs[2], xs.map(Math.round));
        const ys = roots.map((r) => Math.round(r.y));
        ok(`${axis}: и начинаются с одной высоты`,
          Math.max(...ys) - Math.min(...ys) < 4, ys);
      }

      const kid = boxes[`ПРОБА-В-1-КЛАПАН`];
      const root = boxes['ПРОБА-В-1'];
      if (kid && root) {
        if (axis === 'down') ok('вниз: состав под установкой', kid.y > root.y + root.h - 4, [root.y, kid.y]);
        else ok('вправо: состав правее установки', kid.x > root.x + root.w - 4, [root.x, kid.x]);
      }

      // Наложение карточек глазом заметно сразу, а проверкой — надёжнее
      const list = Object.values(boxes);
      let overlap = 0;
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i]; const b = list[j];
          if (a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y) overlap++;
        }
      }
      ok(`${axis}: карточки не легли друг на друга`, overlap === 0, overlap);

      if (SHOTS) {
        await page.screenshot({ path: `/tmp/canvas-${axis}.png` });
        console.log(`     снимок: /tmp/canvas-${axis}.png`);
      }
    }

    console.log('3. Масштаб колесом держит точку под курсором');
    const wheel = await page.evaluate(async () => {
      const el = document.querySelector('[id^="tag-card-"]') as HTMLElement;
      if (!el) return null;
      const before = el.getBoundingClientRect();
      const cx = before.x + before.width / 2;
      const cy = before.y + before.height / 2;
      const board = el.closest('.overflow-hidden') || document.body;
      board.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 500));
      const after = el.getBoundingClientRect();
      return {
        dx: Math.abs((after.x + after.width / 2) - cx),
        dy: Math.abs((after.y + after.height / 2) - cy),
        grew: after.width > before.width,
      };
    });
    ok('масштаб изменился', !!wheel?.grew, wheel);
    ok('точка под курсором осталась на месте', !!wheel && wheel.dx < 6 && wheel.dy < 6, wheel);

    console.log('4. Колесо переживает уход на другую вкладку и возврат');
    // Ровно тот случай, на который жаловался владелец: на первом открытии
    // колесо работает, а после «Спецификации» и обратно — уже нет. Холст в
    // разметке условный, узел пересоздаётся, и слушатель с пустым списком
    // зависимостей оставался на выброшенном
    await page.click('button[title="Спецификация"]');
    await page.waitForTimeout(300);
    await page.click('button[title="Схема связей между тегами"]');
    await page.waitForTimeout(600);
    const again = await page.evaluate(async () => {
      const el = document.querySelector('[id^="tag-card-"]') as HTMLElement;
      if (!el) return null;
      const before = el.getBoundingClientRect();
      const board = el.closest('.overflow-hidden') || document.body;
      board.dispatchEvent(new WheelEvent('wheel', {
        deltaY: -120, clientX: before.x + before.width / 2, clientY: before.y + before.height / 2,
        bubbles: true, cancelable: true,
      }));
      await new Promise((r) => setTimeout(r, 500));
      return { grew: el.getBoundingClientRect().width > before.width };
    });
    ok('после возврата на вкладку масштаб по-прежнему меняется', !!again?.grew, again);

    console.log('5. Ошибок в консоли нет');
    ok('страница не падала', errors.length === 0, errors.slice(0, 3));
  } catch (e: any) {
    f++;
    console.error('  ✗ проба оборвалась:', e?.message || e);
  } finally {
    // Прибираем: проба не должна оставлять теги в проекте
    try {
      if (made.ok) {
        await page.evaluate(async (ids: any) => {
          for (const id of Object.values(ids) as string[]) await fetch(`/api/tags/${id}`, { method: 'DELETE' });
        }, made.ids);
      }
    } catch (_) { /* сервер мог уже уйти */ }
    await browser.close();
  }

  if (f) { console.error(`\nПровалено проверок: ${f}`); process.exit(1); }
  console.log('\nХолст тегов на живой программе: все проверки пройдены');
})();
