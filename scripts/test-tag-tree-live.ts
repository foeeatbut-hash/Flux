/**
 * Дерево тегов на живой программе: испорченные связи выправляются сами.
 *
 * Правила считает scripts/test-tag-tree.ts, но правила можно посчитать верно и
 * всё равно оставить кривое дерево в базе: выправление живёт в загрузке
 * реестра, а не в правилах. Поэтому здесь связи ломаются по-настоящему — так,
 * как их ломала прежняя карточка, — реестр открывается, и проверяется, что в
 * базе стало правильно.
 *
 * Запуск (нужен поднятый сервер):
 *   npx tsx server.ts > /tmp/srv.log 2>&1 &
 *   npx tsx scripts/test-tag-tree-live.ts
 */
const BASE = process.env.FLUX_API || 'http://localhost:3000';
const LOGIN = { symbol: process.env.FLUX_USER || 'RaupovKhKh', password: process.env.FLUX_PASS || '1122' };
const CHROME = process.env.FLUX_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let f = 0;
const ok = (n: string, c: boolean, d?: any) =>
  c ? console.log('  ✓', n) : (f++, console.error('  ✗', n, d !== undefined ? JSON.stringify(d).slice(0, 300) : ''));

(async () => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: CHROME });
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });

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

    console.log('1. Заводим приточную установку с испорченными связями');
    const made = await page.evaluate(async () => {
      const pj = await (await fetch('/api/projects')).json();
      const list = Array.isArray(pj) ? pj : (pj.projects || []);
      const projectId = list[0]?.id;
      if (!projectId) return { ok: false };
      localStorage.setItem(`max_active_project_${JSON.parse(localStorage.getItem('pdm_session_user') || '{}').id}`,
        JSON.stringify(list[0]));

      // Без вложенных функций: tsx собирает пробу esbuild-ом, и объявленная
      // здесь функция уезжает в браузер с обёрткой __name, которой там нет
      const ids: string[] = [];
      for (const identifier of ['ПРОБА-AHU-1', 'ПРОБА-КЛАПАН-1', 'ПРОБА-ПРИВОД-1']) {
        const r = await fetch(`/api/projects/${projectId}/tags`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ identifier, department: 'Технологический отдел', metadata: '{}' }),
        });
        ids.push((await r.json())?.tag?.id);
      }
      const [ahu, valve, drive] = ids;

      // Ровно то, что делала прежняя карточка: ребёнок держит РОДИТЕЛЯ в своём
      // списке детей, а настоящий родитель о ребёнке не знает
      const metas: any[] = [
        { x: 100, y: 100, connections: [], descriptions: [] },
        { x: 400, y: 100, parentId: ahu, connections: [ahu], descriptions: [] },
        { x: 700, y: 100, parentId: valve, connections: [valve], descriptions: [] },
      ];
      for (let i = 0; i < ids.length; i++) {
        await fetch(`/api/tags/${ids[i]}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ metadata: JSON.stringify(metas[i]) }),
        });
      }
      return { ok: true, projectId, ahu, valve, drive };
    });
    ok('теги заведены', made.ok, made);

    // Реестр читает выбранный проект при загрузке — без перезагрузки он
    // покажет «Проект не выбран» и ничего не выправит
    await page.goto(BASE + '/#/registry', { waitUntil: 'domcontentloaded' });
    await page.reload();
    await page.waitForTimeout(9000);

    console.log('2. Дерево выправлено в базе, а не только на экране');
    const tree = await page.evaluate(async (ids: any) => {
      const r = await (await fetch(`/api/projects/${ids.projectId}/tags`)).json();
      const tags = r.tags || r;
      const out: any = {};
      for (const key of ['ahu', 'valve', 'drive']) {
        const t = tags.find((x: any) => x.id === ids[key]);
        try { out[key] = JSON.parse(t?.metadata || '{}'); } catch (_) { out[key] = {}; }
      }
      return out;
    }, made);

    ok('установка знает свой клапан', (tree.ahu.connections || []).includes(made.valve), tree.ahu.connections);
    ok('клапан знает свой привод', (tree.valve.connections || []).includes(made.drive), tree.valve.connections);
    // Главное: родитель больше не числится ребёнком своего же ребёнка
    ok('клапан не держит установку в детях', !(tree.valve.connections || []).includes(made.ahu), tree.valve.connections);
    ok('привод не держит клапан в детях', !(tree.drive.connections || []).includes(made.valve), tree.drive.connections);
    ok('родитель клапана — установка', tree.valve.parentId === made.ahu, tree.valve.parentId);
    ok('родитель привода — клапан, а не установка', tree.drive.parentId === made.valve, tree.drive.parentId);
    ok('у установки родителя нет', !tree.ahu.parentId, tree.ahu.parentId);

    console.log('3. Строки «Родительский тег» в карточке больше нет');
    const card = await page.evaluate(async () => {
      const cards = Array.from(document.querySelectorAll('*'))
        .filter((el) => /ПРОБА-КЛАПАН-1/.test(el.textContent || '') && el.children.length < 8);
      (cards[cards.length - 1] as HTMLElement)?.click();
      await new Promise((r) => setTimeout(r, 1200));
      return document.body.innerText;
    });
    ok('поля выбора родителя в карточке нет', !/Родительский тег/.test(card));

    // Прибираем: проба не должна оставлять теги в проекте
    await page.evaluate(async (ids: any) => {
      for (const id of [ids.drive, ids.valve, ids.ahu]) await fetch(`/api/tags/${id}`, { method: 'DELETE' });
    }, made);
  } catch (e: any) {
    f++;
    console.error('  ✗ проба оборвалась:', e?.message || e);
  } finally {
    await browser.close();
  }

  if (f) { console.error(`\nПровалено проверок: ${f}`); process.exit(1); }
  console.log('\nДерево тегов на живой программе: все проверки пройдены');
})();
