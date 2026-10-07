/**
 * Окно Проводника в браузере, часть первая: слот заголовка в настоящем
 * WindowsLayer, замер размеров и цветов против эталона (тёмная и светлая
 * темы), вкладки и клавиши окна.
 *
 * Запуск: FLUX_UI_URL=http://127.0.0.1:5391 FLUX_CHROME=… npx tsx scripts/test-explorer-shell-ui.ts
 * EXPLORER_SHOTS=/папка — дополнительно снимки стенда и окна со слотом.
 */
import type { Page } from 'playwright-core';
import { SHELL_KEYS, type ShellAction, type ShellBinding } from '../src/components/files/explorerKeys';
import { SHOTS, checks, chord, launch, measure, near, openStand, rgb, shell } from './fixtures/explorer-shell/harness';

const { ok, done } = checks();

(async () => {
  const browser = await launch();
  const allErrors: string[] = [];
  try {
    // ── 1. Слот заголовка в настоящем окне ───────────────────────────────────
    {
      const { page, errors } = await openStand(browser, 'window.html', '?theme=dark', { width: 1280, height: 800 });
      await page.locator('[data-desk]').waitFor();
      await page.evaluate(() => { const s = (window as any).__windowStore.getState(); s.open('/handbook'); s.open('/calendar'); });
      await page.locator('[data-win]').nth(1).waitFor();
      const ids: string[] = await page.evaluate(() => (window as any).__windowStore.getState().windows.map((w: any) => w.id));
      const frame = (id: string) => page.locator(`[data-win="${id}"]`);
      const header = (id: string) => frame(id).locator(':scope > div').first();
      const box = async (id: string) => header(id).evaluate((el) => { const r = el.getBoundingClientRect(); return { h: r.height, bg: getComputedStyle(el).backgroundColor, text: el.textContent || '', caps: [...el.querySelectorAll('button')].filter((b) => ['Свернуть', 'Развернуть', 'Закрыть'].includes(b.getAttribute('aria-label') || '')).map((b) => { const q = b.getBoundingClientRect(); return [q.width, q.height]; }) }; });
      const winGeometry = (id: string) => page.evaluate((i) => { const w = (window as any).__windowStore.getState().windows.find((x: any) => x.id === i); return { x: w.x, y: w.y, maximized: w.maximized, minimized: w.minimized }; }, id);

      const before = await box(ids[0]);
      ok('Обычный заголовок: 34 точки, кнопки 28×28 — как до слота', before.h === 34 && before.caps.every(([w, h]) => w === 28 && h === 28) && before.caps.length === 3, before);
      const beforeOther = await box(ids[1]);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/window-before-claim.png` });

      await page.evaluate((id) => (window as any).__probe(id), ids[0]);
      await frame(ids[0]).locator('[data-explorer-tabs]').waitFor();
      const claimed = await box(ids[0]);
      ok('Слот занят: заголовок 38 точек', claimed.h === 38, claimed);
      ok('Слот занят: фон полосы задаёт раздел (#202020 в тёмной теме)', claimed.bg === rgb(32, 32, 32), claimed.bg);
      ok('Слот занят: название раздела не рисуется, вместо него вкладка', !claimed.text.includes('Справка') && claimed.text.includes('Главная'), claimed.text);
      ok('Кнопки окна на месте: три штуки, 46 точек шириной, на всю высоту полосы', claimed.caps.length === 3 && claimed.caps.every(([w, h]) => w === 46 && h === 38), claimed.caps);
      const other = await box(ids[1]);
      ok('Соседнее окно слот не задевает: заголовок, фон и кнопки те же', JSON.stringify(other) === JSON.stringify(beforeOther), { other, beforeOther });
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/window-claimed.png` });

      // Перетаскивание за пустое место полосы остаётся рамы: нажатие проходит сквозь слот
      const hb = (await header(ids[0]).boundingBox())!;
      const empty = { x: hb.x + hb.width - 46 * 3 - 60, y: hb.y + 19 };
      const g0 = await winGeometry(ids[0]);
      await page.mouse.move(empty.x, empty.y); await page.mouse.down(); await page.mouse.move(empty.x + 40, empty.y + 20, { steps: 4 }); await page.mouse.move(empty.x + 60, empty.y + 40, { steps: 4 }); await page.mouse.up();
      const g1 = await winGeometry(ids[0]);
      ok('Пустое место полосы тащит окно', near(g1.x - g0.x, 60) && near(g1.y - g0.y, 40), { g0, g1 });
      const tab = (await frame(ids[0]).locator('[role="tab"]').first().boundingBox())!;
      await page.mouse.move(tab.x + 60, tab.y + 12); await page.mouse.down(); await page.mouse.move(tab.x + 110, tab.y + 40, { steps: 6 }); await page.mouse.up();
      const g2 = await winGeometry(ids[0]);
      ok('Нажатие на вкладку окно не тащит', g2.x === g1.x && g2.y === g1.y, { g1, g2 });
      const hb2 = (await header(ids[0]).boundingBox())!;
      await page.mouse.dblclick(hb2.x + hb2.width - 46 * 3 - 60, hb2.y + 19);
      ok('Двойной щелчок по пустому месту полосы разворачивает окно', (await winGeometry(ids[0])).maximized === true);
      await page.mouse.move(0, 0);
      await frame(ids[0]).getByRole('button', { name: 'Развернуть', exact: true }).hover();
      await page.getByRole('group', { name: 'Куда поставить окно' }).waitFor({ timeout: 3000 }).catch(() => undefined);
      ok('Наведение на «Развернуть» раскрывает доли экрана и в окне со слотом', await page.getByRole('group', { name: 'Куда поставить окно' }).isVisible());
      await page.keyboard.press('Escape');
      await frame(ids[0]).getByRole('button', { name: 'Развернуть', exact: true }).click();
      ok('Кнопка «Развернуть» возвращает размер', (await winGeometry(ids[0])).maximized === false);
      await frame(ids[0]).getByRole('button', { name: 'Свернуть', exact: true }).click();
      ok('Кнопка «Свернуть» сворачивает окно со слотом', (await winGeometry(ids[0])).minimized === true);
      await page.evaluate((id) => (window as any).__windowStore.getState().restore(id), ids[0]);
      await page.evaluate(() => (window as any).__probe(null));
      await page.waitForFunction((id) => (document.querySelector(`[data-win="${id}"] > div`) as HTMLElement).getBoundingClientRect().height === 34, ids[0]);
      const released = await box(ids[0]);
      ok('Слот освобождён: заголовок вернулся к 34 точкам с названием раздела', released.h === 34 && released.text.includes('Справка') && released.bg === before.bg, released);
      await page.evaluate((id) => (window as any).__probe(id), ids[0]);
      await frame(ids[0]).locator('[data-explorer-tabs]').waitFor();
      await frame(ids[0]).getByRole('button', { name: 'Закрыть', exact: true }).click();
      await page.waitForFunction(() => (window as any).__windowStore.getState().windows.length === 1);
      ok('Кнопка «Закрыть» закрывает окно со слотом', await page.locator('[data-win]').count() === 1);
      allErrors.push(...errors); await page.close();
    }

    // ── 2. Размеры и цвета против эталона ────────────────────────────────────
    for (const theme of ['dark', 'light'] as const) {
      const { page, errors } = await openStand(browser, 'shell.html', shell(theme));
      await page.locator('#frame').waitFor();
      await page.locator('[role="treeitem"][title="Локальный диск (C:)"]').waitFor();
      const dark = theme === 'dark';
      const want = dark
        ? { strip: rgb(32, 32, 32), surface: rgb(44, 44, 44), field: rgb(56, 56, 56), pane: rgb(25, 25, 25), selected: rgb(51, 51, 51), group: rgb(56, 56, 56) }
        : { strip: rgb(233, 233, 233), surface: rgb(249, 249, 249), field: rgb(255, 255, 255), pane: rgb(255, 255, 255), selected: rgb(229, 229, 229), group: rgb(224, 224, 224) };
      const t = theme === 'dark' ? 'тёмная' : 'светлая';

      const strip = await measure(page, '[data-fake-title]');
      ok(`[${t}] Вкладки: полоса высотой 38, фон ${want.strip}`, strip.h === 38 && strip.bg === want.strip, strip);
      const tab = await measure(page, '[role="tab"][aria-selected="true"]');
      ok(`[${t}] Активная вкладка: фон ${want.surface}, высота 32, стоит на нижнем крае полосы`, tab.bg === want.surface && tab.h === 32 && near(tab.y + tab.h, strip.y + strip.h, 0.5), tab);
      ok(`[${t}] Вкладка начинается в 8 точках от края полосы, шире 56 и не шире 240`, near(tab.x - strip.x, 8) && tab.w >= 56 && tab.w <= 240, tab);
      ok(`[${t}] Вкладка: 12 px, значок, название, «×»; рядом «+»`, tab.font === '12px' && await page.locator('[role="tab"][aria-selected="true"]').getByRole('button', { name: /Закрыть вкладку/ }).count() === 1 && await page.getByRole('button', { name: 'Новая вкладка' }).count() === 1);

      const row = await measure(page, '[data-address-bar]');
      ok(`[${t}] Строка адреса: высота 48, фон ${want.surface}, сразу под вкладками`, row.h === 48 && row.bg === want.surface && near(row.y, strip.y + strip.h, 0.5), row);
      const steps = await Promise.all(['Назад', 'Вперёд', 'Вверх', 'Обновить'].map((name) => page.getByRole('button', { name, exact: true }).evaluate((el) => { const r = (el.parentElement as HTMLElement).getBoundingClientRect(); return { x: r.x, w: r.width, h: r.height }; })));
      ok(`[${t}] Назад, Вперёд, Вверх, Обновить: шаг 48, клетка 48×48`, steps.every((s, i) => s.w === 48 && s.h === 48 && (i === 0 || near(s.x - steps[i - 1].x, 48, 0.5))), steps);
      const field = await measure(page, '[data-address-field]');
      const search = await measure(page, '[data-search-box]');
      ok(`[${t}] Поле адреса: высота 32, фон ${want.field}, отступ сверху и снизу по 8`, field.h === 32 && field.bg === want.field && near(field.y - row.y, 8, 0.5), field);
      ok(`[${t}] Поле поиска: той же высоты, на той же линии, тот же фон`, search.h === 32 && search.y === field.y && search.bg === want.field && near(search.w, 295, 1), search);
      ok(`[${t}] Поле адреса стоит после кнопок (x ≥ 192), поиск — справа от него`, field.x >= 192 && search.x > field.x + field.w, { field, search });
      const crumb = await measure(page, '[data-crumb]');
      ok(`[${t}] Крошки 14 px`, crumb.font === '14px', crumb);

      const nav = await measure(page, '[data-nav-pane]');
      ok(`[${t}] Панель навигации: ширина 287, фон ${want.pane}`, nav.w === 287 && nav.bg === want.pane, nav);
      ok(`[${t}] Панель навигации начинается там же, где эталонная: 38+48+1+46+1 = 134`, near(nav.y, 134, 0.5), nav);
      const item = await measure(page, '[role="treeitem"]');
      ok(`[${t}] Пункт навигации: высота 32, шрифт 12 px`, item.h === 32, item);
      const pill = await page.locator('[role="treeitem"][aria-selected="true"] > span[aria-hidden]').first().evaluate((el) => { const r = el.getBoundingClientRect(); return { bg: getComputedStyle(el).backgroundColor, h: r.height }; });
      ok(`[${t}] Выбранный пункт: фон ${want.selected}`, pill.bg === want.selected, pill);
      const group = await page.locator('[role="separator"] > div').first().evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, h: el.getBoundingClientRect().height }));
      ok(`[${t}] Разделитель группы: линия в 1 точку, цвет ${want.group}`, group.bg === want.group && group.h === 1, group);

      // Отступы значка, стрелки и подписи — те же, что на эталоне (стрелка 21, значок 45, подпись 59; уровнем ниже +8)
      const at = (selector: string) => page.locator(selector).first().evaluate((el, left) => { const r = el.getBoundingClientRect(); return { c: r.x + r.width / 2 - left, l: r.x - left }; }, nav.x);
      const yandex = '[role="treeitem"][title="Яндекс Диск"]', disk = '[role="treeitem"][title="Локальный диск (C:)"]';
      const lvl0 = { chevron: await at(`${yandex} [data-nav-chevron]`), icon: await at(`${yandex} img`), label: await at(`${yandex} span.truncate`) };
      const lvl1 = { chevron: await at(`${disk} [data-nav-chevron]`), label: await at(`${disk} span.truncate`) };
      ok(`[${t}] Первый уровень: стрелка 21, значок 45, подпись с 59 точек`, near(lvl0.chevron.c, 21) && near(lvl0.icon.c, 45) && near(lvl0.label.l, 59), lvl0);
      ok(`[${t}] Второй уровень сдвинут на 8: стрелка 29, подпись с 67`, near(lvl1.chevron.c, 29) && near(lvl1.label.l, 67), lvl1);
      ok(`[${t}] Значок Windows через мост: у «Рабочего стола» и у диска — PNG из getIcon`, await page.locator('[role="treeitem"][title="Рабочий стол"] img[src^="data:image/png"]').count() === 1 && await page.locator(`${disk} img[src^="data:image/png"]`).count() === 1);
      ok(`[${t}] Шрифт — системный стек Windows`, (await measure(page, '[data-nav-pane]')).family.startsWith('"Segoe UI Variable Text"'));
      ok(`[${t}] Горизонтальной прокрутки нет`, await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/shell-${theme}.png` });
      allErrors.push(...errors); await page.close();
    }

    // ── 3. Вкладки ───────────────────────────────────────────────────────────
    let page!: Page;
    let pageErrors: string[] = [];
    const fresh = async (extra = '') => {
      if (page) { allErrors.push(...pageErrors); await page.close(); }
      const opened = await openStand(browser, 'shell.html', shell('dark', extra));
      page = opened.page; pageErrors = opened.errors;
      await page.locator('#frame').waitFor();
      await page.locator('[role="treeitem"][title="Локальный диск (C:)"]').waitFor();
      // Клавиши слушает корень окна: фокус внутри него, как у человека, который уже работает в окне
      await page.locator('#frame').focus();
    };
    const tabNames = () => page.locator('[role="tab"]').evaluateAll((tabs) => tabs.map((t) => (t.textContent || '').trim()));
    const activeAt = () => page.locator('[role="tab"]').evaluateAll((tabs) => tabs.findIndex((t) => t.getAttribute('aria-selected') === 'true'));
    const place = () => page.getByTestId('place').textContent();
    const nav = (label: string) => page.locator(`[role="treeitem"][title="${label}"]`);
    const sleep = (ms: number) => page.waitForTimeout(ms);

    await fresh();
    ok('Вкладки: при открытии одна, на «Главной»', JSON.stringify(await tabNames()) === JSON.stringify(['Главная']) && await place() === 'Главная');
    await page.getByRole('button', { name: 'Новая вкладка' }).click();
    ok('«+» открывает вкладку на «Главной», она активна', await page.locator('[role="tab"]').count() === 2 && await activeAt() === 1 && await place() === 'Главная');
    await nav('Рабочий стол').click();
    await page.locator('[role="tab"]').nth(1).getByText('Рабочий стол').waitFor();
    ok('Вкладка носит название открытого места', JSON.stringify(await tabNames()) === JSON.stringify(['Главная', 'Рабочий стол']));
    await page.locator('[role="tab"]').nth(0).click();
    ok('Щелчок по вкладке переключает; у первой «Главная» и своя история', await place() === 'Главная' && await page.getByRole('button', { name: 'Назад', exact: true }).isDisabled());
    await page.locator('[role="tab"]').nth(1).click();
    ok('У второй вкладки история своя: «Назад» доступна и ведёт на «Главную»', await page.getByRole('button', { name: 'Назад', exact: true }).isEnabled());
    await page.getByRole('button', { name: 'Назад', exact: true }).click();
    ok('«Назад» во второй вкладке не трогает первую', await place() === 'Главная' && (await tabNames())[1] === 'Главная' && (await tabNames())[0] === 'Главная');
    await page.getByRole('button', { name: /Закрыть вкладку «Главная»/ }).last().click();
    ok('«×» закрывает вкладку, активной становится соседняя', await page.locator('[role="tab"]').count() === 1);
    await page.getByRole('button', { name: /Закрыть вкладку/ }).click();
    ok('Закрытие последней вкладки набор не закрывает, а просит рамку закрыть окно', await page.locator('[role="tab"]').count() === 1 && await page.evaluate(() => (window as any).__lastClosed) === 1);
    await page.getByRole('button', { name: 'Новая вкладка' }).click(); await page.getByRole('button', { name: 'Новая вкладка' }).click();
    await page.locator('[role="tab"]').nth(1).click({ button: 'middle' });
    ok('Средняя кнопка закрывает вкладку', await page.locator('[role="tab"]').count() === 2);

    // Перестановка и бросок файлов
    await nav('Рабочий стол').click(); await nav('Яндекс Диск').click();
    await page.getByRole('button', { name: 'Новая вкладка' }).click(); await nav('Новый том (D:)').click();
    const order = () => page.locator('[role="tab"]').evaluateAll((tabs) => tabs.map((t) => t.getAttribute('data-tab-id')));
    const idsBefore = await order();
    await page.locator('[role="tab"]').nth(0).dragTo(page.locator('[role="tab"]').nth(2));
    const idsAfter = await order();
    ok('Перетаскивание переставляет вкладку', idsAfter.length === 3 && idsAfter[2] === idsBefore[0] && idsAfter[0] === idsBefore[1], { idsBefore, idsAfter });
    ok('Перестановка не меняет активную вкладку', (await page.locator('[role="tab"][aria-selected="true"]').getAttribute('data-tab-id')) === idsBefore[2]);
    await page.locator('[role="tab"]').nth(0).evaluate((el) => {
      const data = new DataTransfer(); data.items.add(new File(['x'], 'a.txt'));
      el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }));
      el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
    });
    const drops: string[] = await page.evaluate(() => (window as any).__drops);
    ok('Файлы, брошенные на вкладку, уходят событием наружу вместе с вкладкой', drops.length === 1 && drops[0].startsWith(`${idsAfter[0]}:`) && drops[0].includes('Files'), drops);
    ok('Бросок файлов вкладки не переставляет и не переключает', JSON.stringify(await order()) === JSON.stringify(idsAfter));

    // Набор вкладок переживает закрытие окна: viewState → перезагрузка страницы
    await nav('Локальный диск (C:)').click();
    const savedNames = await tabNames(); const savedActive = await activeAt(); const savedHistory = await page.getByTestId('history').textContent();
    await sleep(700);
    ok('Набор вкладок записан в viewState', await page.evaluate(() => (window as any).__calls.some((c: any) => c.action === 'viewStateSet' && c.entries['explorer.tabs.v1'])));
    await page.reload(); await page.locator('#frame').waitFor();
    ok('После перезапуска набор вкладок, активная и история на месте', JSON.stringify(await tabNames()) === JSON.stringify(savedNames) && await activeAt() === savedActive && await page.getByTestId('history').textContent() === savedHistory, { savedNames, savedHistory });

    // ── 4. Клавиши окна: сценарий на каждую ──────────────────────────────────
    const press = async (b: ShellBinding) => { await page.keyboard.press(chord(b.label)); };
    const active = () => page.locator('[role="tab"][aria-selected="true"]').getAttribute('data-tab-id');
    const SCENARIOS: Record<ShellAction, (b: ShellBinding) => Promise<boolean>> = {
      newTab: async (b) => { await fresh(); await press(b); return await page.locator('[role="tab"]').count() === 2 && await activeAt() === 1 && await place() === 'Главная'; },
      closeTab: async (b) => { await fresh(); await page.getByRole('button', { name: 'Новая вкладка' }).click(); await press(b); return await page.locator('[role="tab"]').count() === 1; },
      nextTab: async (b) => {
        await fresh(); await page.getByRole('button', { name: 'Новая вкладка' }).click(); await page.getByRole('button', { name: 'Новая вкладка' }).click();
        await page.locator('[role="tab"]').nth(0).click(); await press(b); const stepped = await activeAt() === 1;
        await page.locator('[role="tab"]').nth(2).click(); await press(b);
        return stepped && await activeAt() === 0;
      },
      prevTab: async (b) => {
        await fresh(); await page.getByRole('button', { name: 'Новая вкладка' }).click(); await page.getByRole('button', { name: 'Новая вкладка' }).click();
        await page.locator('[role="tab"]').nth(0).click(); await press(b); return await activeAt() === 2;
      },
      goBack: async (b) => { await fresh(); await nav('Рабочий стол').click(); await press(b); return await place() === 'Главная'; },
      goForward: async (b) => { await fresh(); await nav('Рабочий стол').click(); await press({ ...b, label: 'Alt+←' } as ShellBinding); await press(b); return await place() === 'Рабочий стол'; },
      goUp: async (b) => { await fresh(); await nav('Локальный диск (C:)').click(); await press(b); return await place() === 'Этот компьютер'; },
      address: async (b) => {
        await fresh(); await press(b);
        const input = page.getByRole('combobox', { name: 'Адрес' });
        const shown = await input.isVisible() && await input.evaluate((el) => document.activeElement === el);
        await page.keyboard.press('Escape');
        return shown && await input.count() === 0;
      },
      search: async (b) => { await fresh(); await press(b); return await page.getByRole('searchbox').evaluate((el) => document.activeElement === el); },
      refresh: async (b) => { await fresh(); const before = Number(await page.getByTestId('refreshes').textContent()); await press(b); return Number(await page.getByTestId('refreshes').textContent()) === before + 1; },
    };
    for (const binding of SHELL_KEYS) {
      const scenario = SCENARIOS[binding.action];
      ok(`Для клавиши ${binding.label} есть сценарий проверки`, !!scenario);
      if (!scenario) continue;
      try { ok(`Клавиша ${binding.label}: ${binding.does}`, await scenario(binding)); }
      catch (cause: any) { console.error(String(cause?.message || cause).split('\n')[0]); ok(`Клавиша ${binding.label}: ${binding.does}`, false); }
    }
    await fresh();
    await page.getByRole('searchbox').click(); await page.keyboard.press('Control+t');
    ok('Клавиши окна работают и из поля поиска', await page.locator('[role="tab"]').count() === 2);
    await fresh();
    await page.locator('#frame').evaluate((el) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'е', code: 'KeyT', ctrlKey: true, bubbles: true, cancelable: true })));
    ok('Ctrl+T при русской раскладке открывает вкладку', await page.locator('[role="tab"]').count() === 2);
    const first = await active();
    await page.keyboard.press('Control+w');
    ok('Ctrl+W закрывает активную вкладку и отдаёт место соседней', await page.locator('[role="tab"]').count() === 1 && (await active()) !== first);

    allErrors.push(...pageErrors);
    ok('Консоль и страница молчат: ни ошибок, ни необработанных исключений', allErrors.length === 0, allErrors.slice(0, 3));
  } finally {
    await browser.close();
  }
  process.exit(done());
})().catch((error) => { console.error(error); process.exit(1); });
