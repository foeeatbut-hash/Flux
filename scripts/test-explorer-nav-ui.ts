/**
 * Окно Проводника в браузере, часть вторая: строка адреса (история, крошки,
 * текстовый путь, поиск) и панель навигации (порядок, Быстрый доступ, ленивое
 * дерево, ширина, клавиатура).
 *
 * Запуск: FLUX_UI_URL=http://127.0.0.1:5391 FLUX_CHROME=… npx tsx scripts/test-explorer-nav-ui.ts
 */
import type { Page } from 'playwright-core';
import { SHOTS, checks, launch, near, openStand, shell } from './fixtures/explorer-shell/harness';

const { ok, done } = checks();
const MENU = '[data-context-menu]';

(async () => {
  const browser = await launch();
  const allErrors: string[] = [];
  let page!: Page;
  let pageErrors: string[] = [];
  const fresh = async (extra = '') => {
    if (page) { allErrors.push(...pageErrors); await page.close(); }
    const opened = await openStand(browser, 'shell.html', shell('dark', extra));
    page = opened.page; pageErrors = opened.errors;
    await page.locator('#frame').waitFor();
    await page.locator('[role="treeitem"][title="Сеть"]').waitFor();
    await page.locator('#frame').focus();
  };
  const nav = (label: string) => page.locator(`[role="treeitem"][title="${label}"]`);
  const place = () => page.getByTestId('place').textContent();
  const btn = (name: string) => page.getByRole('button', { name, exact: true });
  const callsOf = (action: string) => page.evaluate((a) => (window as any).__calls.filter((c: any) => c.action === a), action);
  const crumbs = () => page.locator('[data-crumb]').allInnerTexts();
  const typePath = async (text: string, submit = true) => {
    await page.keyboard.press('Control+l');
    const input = page.getByRole('combobox', { name: 'Адрес' });
    await input.fill(text);
    if (submit) await input.press('Enter');
    return input;
  };
  const results = async () => ({ status: await page.getByTestId('results-status').textContent().catch(() => null), count: await page.getByTestId('results-count').textContent().catch(() => null) });
  const lastSearch = () => page.evaluate(() => (window as any).__searches.at(-1));

  try {
    // ── История и кнопки ─────────────────────────────────────────────────────
    await fresh();
    ok('Назад, Вперёд, Вверх на «Главной» приглушены, Обновить доступна', await btn('Назад').isDisabled() && await btn('Вперёд').isDisabled() && await btn('Вверх').isDisabled() && await btn('Обновить').isEnabled());
    await btn('Обновить').click();
    ok('«Обновить» просит обновить открытое место', await page.getByTestId('refreshes').textContent() === '1');
    await nav('Локальный диск (C:)').click();
    ok('Выбор диска в панели открывает его', await place() === 'C:' && await btn('Вверх').isEnabled());
    await btn('Вверх').click();
    ok('«Вверх» с диска — «Этот компьютер»', await place() === 'Этот компьютер' && await page.getByTestId('kind').textContent() === 'computer');
    await btn('Назад').click();
    ok('«Назад» возвращает на диск', await place() === 'C:');
    await btn('Вперёд').click();
    ok('«Вперёд» возвращает в «Этот компьютер»', await place() === 'Этот компьютер');
    await nav('Рабочий стол').click(); await nav('Локальный диск (C:)').click(); await nav('Новый том (D:)').click();
    await btn('Назад').click({ button: 'right' });
    const recent = page.getByRole('listbox', { name: 'Недавние места' });
    await recent.waitFor();
    const recentNames = await recent.getByRole('option').allInnerTexts();
    ok('Правая кнопка на «Назад» — список недавних мест, ближайшее первым', JSON.stringify(recentNames) === JSON.stringify(['Локальный диск (C:)', 'Рабочий стол', 'Этот компьютер', 'Локальный диск (C:)', 'Главная']), recentNames);
    await recent.getByRole('option', { name: 'Рабочий стол' }).click();
    ok('Выбор места в списке прыгает через несколько шагов сразу', await place() === 'Рабочий стол' && await btn('Вперёд').isEnabled() && await btn('Назад').isEnabled());

    // ── Крошки и списки подпапок ─────────────────────────────────────────────
    await typePath('C:\\Users\\Анна');
    ok('Набранный путь открывает папку', await place() === 'C:\\Users\\Анна');
    ok('Крошки: звенья цепочки, у диска — его имя', JSON.stringify(await crumbs()) === JSON.stringify(['Этот компьютер', 'Локальный диск (C:)', 'Users', 'Анна']), await crumbs());
    ok('У каждого звена своя стрелка со списком подпапок', await page.getByRole('button', { name: /^Подпапки: / }).count() === 4);
    await page.locator('[data-crumb]', { hasText: 'Users' }).click();
    ok('Щелчок по звену открывает его', await place() === 'C:\\Users');
    await page.getByRole('button', { name: 'Подпапки: Локальный диск (C:)' }).click();
    const sub = page.getByRole('listbox', { name: 'Подпапки: Локальный диск (C:)' });
    await sub.waitFor(); await sub.getByRole('option').first().waitFor();
    ok('Стрелка звена — список его подпапок (из моста children), открытая отмечена', JSON.stringify(await sub.getByRole('option').allInnerTexts()) === JSON.stringify(['Users', 'Windows']) && await sub.getByRole('option', { name: 'Users' }).getAttribute('aria-selected') === 'true');
    await sub.getByRole('option', { name: 'Windows' }).click();
    ok('Выбор подпапки в списке открывает её', await place() === 'C:\\Windows');
    await page.getByRole('button', { name: 'Подпапки: Этот компьютер' }).click();
    const disks = page.getByRole('listbox', { name: 'Подпапки: Этот компьютер' });
    await disks.getByRole('option').first().waitFor();
    ok('Список у «Этого компьютера» — диски и подключённые папки', (await disks.getByRole('option').allInnerTexts()).slice(0, 3).join('|') === 'Локальный диск (C:)|Новый том (D:)|Новый том (E:)');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Верхние места' }).click();
    const top = page.getByRole('listbox', { name: 'Верхние места' });
    await top.getByRole('option', { name: 'Сеть' }).click();
    ok('Первая стрелка — верхние места; «Сеть» открывается', await place() === 'Сеть');

    // Длинный путь сворачивается слева в «…», последнее звено остаётся
    await typePath('Рабочий стол\\Проекты\\Чертежи\\Архив');
    ok('Путь с папками рабочего стола открывается', await place() === 'Рабочий стол\\Проекты\\Чертежи\\Архив');
    await page.locator('#frame').evaluate((el) => { el.style.width = '640px'; });
    await page.waitForTimeout(250);
    ok('В узком поле звенья сворачиваются слева в «…», последнее на месте', await page.locator('[data-address-field]').getByText('…', { exact: true }).count() === 1 && (await crumbs()).at(-1) === 'Архив' && (await crumbs()).length < 4, await crumbs());
    await page.locator('#frame').evaluate((el) => { el.style.width = '1251px'; });
    await page.waitForTimeout(250);
    ok('В широком поле все звенья снова видны', (await crumbs()).length === 4);

    // ── Текстовый путь ───────────────────────────────────────────────────────
    const field = page.locator('[data-address-field]');
    const box = (await field.boundingBox())!;
    await page.mouse.click(box.x + box.width - 20, box.y + box.height / 2);
    const input = page.getByRole('combobox', { name: 'Адрес' });
    ok('Щелчок по пустому месту поля — текстовый путь с полным адресом', await input.isVisible() && await input.inputValue() === 'Рабочий стол\\Проекты\\Чертежи\\Архив');
    await page.keyboard.press('Escape');
    ok('Esc возвращает крошки и ничего не открывает', await input.count() === 0 && await place() === 'Рабочий стол\\Проекты\\Чертежи\\Архив');
    await typePath('C:\\Us', false);
    await page.getByRole('option', { name: 'C:\\Users' }).waitFor();
    ok('Пока печатают, внизу подсказки — подпапки того, что набрано', JSON.stringify(await page.getByRole('option').allInnerTexts()) === JSON.stringify(['C:\\Users']));
    await page.keyboard.press('ArrowDown');
    ok('Стрелка вниз берёт подсказку в строку', await page.getByRole('combobox', { name: 'Адрес' }).inputValue() === 'C:\\Users');
    await page.keyboard.press('Enter');
    ok('Enter открывает выбранное', await place() === 'C:\\Users');
    await typePath('d:\\ДАННЫЕ');
    ok('Регистр букв не важен, имя берётся с диска', await place() === 'D:\\Данные');
    await typePath('Документы\\Черновик Flux\\Внутри');
    ok('Путь через папку-черновик открывается', await place() === 'Документы\\Черновик Flux\\Внутри');
    ok('«Вверх» из черновика ведёт к его предку', await (async () => { await btn('Вверх').click(); return await place() === 'Документы\\Черновик Flux'; })());
    await typePath('\\\\corp\\Проекты\\Проекты компании\\ВДР');
    ok('Сетевой путь по адресу открывается через сетевой том', await place() === 'Z:\\Проекты компании\\ВДР');
    const placeBefore = await place();
    await typePath('C:\\Нет такой');
    await page.getByRole('alert').waitFor();
    ok('Несуществующая папка: «Не удаётся найти…», место не меняется', (await page.getByRole('alert').textContent())!.includes('Не удаётся найти «Нет такой»') && await place() === placeBefore);
    await page.keyboard.press('Escape');
    await typePath('Q:\\Секрет');
    await page.getByRole('alert').waitFor();
    const alertText = await page.getByRole('alert').textContent();
    ok('Путь вне подключённых мест не открывается молча: слова и «Подключить папку…»', alertText!.includes('подключите') && await page.getByRole('button', { name: 'Подключить папку…' }).isVisible() && await place() === placeBefore, alertText);
    await page.getByRole('button', { name: 'Подключить папку…' }).click();
    ok('«Подключить папку…» зовёт окно выбора папки (addRoot), закрывает ввод и открывает подключённое', (await callsOf('addRoot')).length === 1 && await page.getByRole('combobox', { name: 'Адрес' }).count() === 0 && await place() === 'Рабочий стол');
    await typePath('%USERPROFILE%\\Desktop');
    ok('Переменные %…% не раскрываются, и об этом сказано', (await page.getByRole('alert').textContent())!.includes('Переменные'));
    await page.keyboard.press('Escape');

    // ── Поиск ────────────────────────────────────────────────────────────────
    await fresh();
    const searchBox = page.getByRole('searchbox');
    ok('Поиск: «Поиск в: Главная»', await searchBox.getAttribute('placeholder') === 'Поиск в: Главная');
    await nav('Рабочий стол').click();
    ok('Подпись поиска называет открытое место', await searchBox.getAttribute('placeholder') === 'Поиск в: Рабочий стол');
    await searchBox.fill('отчёт');
    await page.getByTestId('results-status').waitFor();
    ok('Запрос уходит сам, когда человек перестал печатать', (await callsOf('search')).length === 1);
    const first = await lastSearch();
    ok('В мост уходит запрос с местом поиска и номером запроса', first.query === 'отчёт' && first.ref.rootId === 'desktop' && first.requestId.startsWith('s-'), first);
    await page.getByTestId('results-status').filter({ hasText: 'done:complete' }).waitFor();
    ok('Результаты приходят потоком и складываются: 3 страницы по 8', (await results()).count === '24', await results());
    await page.getByRole('button', { name: 'Остановить поиск' }).waitFor({ state: 'detached' });
    ok('Поиск закончился: кнопки «Стоп» нет, есть «Очистить»', await page.getByRole('button', { name: 'Очистить поиск' }).isVisible());

    await page.evaluate(() => { (window as any).__searchDelay = 400; });
    await searchBox.fill('чертёж'); await searchBox.press('Enter');
    await page.getByTestId('results-status').filter({ hasText: 'running' }).waitFor();
    ok('Идущий поиск виден: есть кнопка «Остановить поиск»', await page.getByRole('button', { name: 'Остановить поиск' }).isVisible());
    await searchBox.press('Escape');
    await page.getByTestId('results-status').filter({ hasText: 'done:canceled' }).waitFor();
    ok('Esc останавливает идущий поиск: найденное остаётся, причина — «отменён»', Number((await results()).count) < 24 && (await callsOf('searchCancel')).length >= 1 && await searchBox.inputValue() === 'чертёж');
    await page.waitForTimeout(900);
    ok('После отмены поздние страницы старого запроса не доходят', (await results()).status === 'done:canceled' && Number((await results()).count) <= 8, await results());
    await searchBox.press('Escape');
    ok('Второе Esc очищает поле и закрывает результаты', await searchBox.inputValue() === '' && await page.getByTestId('results').count() === 0);
    await searchBox.fill('чертёж'); await searchBox.press('Enter');
    await page.getByRole('button', { name: 'Остановить поиск' }).click();
    await page.getByTestId('results-status').filter({ hasText: 'done:canceled' }).waitFor();
    ok('Кнопка «Остановить поиск» делает то же, что Esc', true);
    await page.evaluate(() => { (window as any).__searchDelay = 30; });

    await page.getByRole('button', { name: 'Фильтры поиска' }).click();
    const panel = page.locator('[data-popover]');
    ok('Фильтры: тип, дата, размер, а ниже Flux — тег, проект, «Только черновики»', await panel.getByLabel('Тип').isVisible() && await panel.getByLabel('Дата изменения').isVisible() && await panel.getByLabel('Размер').isVisible() && await panel.getByLabel('Тег').isVisible() && await panel.getByLabel('Проект').isVisible() && await panel.getByLabel('Только черновики').isVisible());
    await panel.getByLabel('Тип').selectOption('tables');
    await panel.getByLabel('Размер').selectOption('small');
    await panel.getByLabel('Дата изменения').selectOption('today');
    await panel.getByLabel('Тег').fill('AHU-01');
    await panel.getByLabel('Проект').getByRole('option', { name: 'Проект 1' }).waitFor({ state: 'attached' });
    await panel.getByLabel('Проект').selectOption('p1');
    await panel.getByLabel('Только черновики').check();
    await page.waitForTimeout(150);
    const filtered = await lastSearch();
    const f = filtered.filters;
    ok('Фильтры уходят в мост: тип, размер, дата', f.kind === 'file' && f.extensions.includes('xlsx') && f.sizeMin === 16384 && f.sizeMax === 1048576 && typeof f.modifiedFrom === 'string', f);
    ok('Фильтры Flux уходят в мост: тег, проект, только черновики', f.tag === 'AHU-01' && f.projectId === 'p1' && f.onlyDrafts === true, f);
    await page.keyboard.press('Escape');
    ok('Включённые фильтры видны на воронке', (await page.getByRole('button', { name: 'Фильтры поиска' }).getAttribute('title'))!.includes('Тег: AHU-01'));
    await nav('Документы').click();
    ok('Уход в другое место гасит поиск, результаты и фильтры', await page.getByTestId('results').count() === 0 && await searchBox.inputValue() === '' && (await page.getByRole('button', { name: 'Фильтры поиска' }).getAttribute('title')) === 'Фильтры поиска');
    await nav('Этот компьютер').click();
    await searchBox.fill('смета'); await searchBox.press('Enter');
    await page.getByTestId('results-status').filter({ hasText: 'done' }).waitFor();
    const scopes = (await page.evaluate(() => (window as any).__searches)).filter((s: any) => s.query === 'смета').map((s: any) => s.ref.rootId).sort();
    ok('Поиск в «Этом компьютере» идёт по каждому диску отдельным запросом (кроме сетевых)', JSON.stringify(scopes) === JSON.stringify(['disk-c', 'disk-d', 'disk-e']), scopes);
    ok('Результаты разных дисков складываются вместе', (await results()).count === '72', await results());

    // ── Панель навигации ─────────────────────────────────────────────────────
    await fresh();
    const titles = () => page.locator('[role="treeitem"]').evaluateAll((rows) => rows.map((row) => row.getAttribute('title')));
    ok('Порядок: Главная, закреплённое, облако, Этот компьютер с дисками, Сеть — без «Галереи»', JSON.stringify(await titles()) === JSON.stringify(['Главная', 'Рабочий стол', 'Загрузки', 'Документы', '2026', '1_PDF', 'Новая папка', 'Яндекс Диск', 'Этот компьютер', 'Локальный диск (C:)', 'Новый том (D:)', 'Новый том (E:)', 'Проект ВДР', 'Сеть']), await titles());
    ok('Булавка справа у закреплённых: четыре; у частых папок её нет', await page.locator('[role="treeitem"] svg[aria-label="Закреплено"]').count() === 4 && await nav('1_PDF').locator('svg[aria-label="Закреплено"]').count() === 0);
    ok('Подсвечена открытая «Главная», и только она', JSON.stringify(await page.locator('[role="treeitem"][aria-current="page"]').evaluateAll((rows) => rows.map((r) => r.getAttribute('title')))) === JSON.stringify(['Главная']));
    ok('Диски читаются лениво: до раскрытия мост о подпапках дисков не спрашивали', (await callsOf('children')).length === 0);
    ok('Значки облачной папки — тот, что отдала Windows', await nav('Яндекс Диск').locator('img[src^="data:image/png"]').count() === 1);

    await nav('1_PDF').click({ button: 'right' });
    await page.locator(MENU).getByRole('button', { name: 'Закрепить в Быстром доступе' }).click();
    await page.waitForFunction(() => document.querySelectorAll('[role="treeitem"] svg[aria-label="Закреплено"]').length === 5);
    const pin = (await callsOf('quickAccessPin')).at(-1);
    ok('Закрепление идёт в Windows (quickAccessPin) и булавка появляется', pin.pinned === true && pin.ref.relativePath === '1_PDF' && await nav('1_PDF').locator('svg[aria-label="Закреплено"]').count() === 1, pin);
    await nav('2026').click({ button: 'right' });
    await page.locator(MENU).getByRole('button', { name: 'Открепить из Быстрого доступа' }).click();
    await page.waitForFunction(() => document.querySelectorAll('[role="treeitem"] svg[aria-label="Закреплено"]').length === 4);
    ok('Открепление идёт в Windows и булавка исчезает', (await callsOf('quickAccessPin')).at(-1).pinned === false && await nav('2026').locator('svg[aria-label="Закреплено"]').count() === 0);
    await nav('Рабочий стол').click({ button: 'right' });
    await page.locator(MENU).getByRole('button', { name: 'Открыть в новой вкладке' }).click();
    ok('«Открыть в новой вкладке» заводит вкладку, не переключаясь на неё', await page.locator('[role="tab"]').count() === 2 && await place() === 'Главная');
    await nav('Главная').click({ button: 'right' });
    ok('У «Главной» в меню нет закрепления: это не папка', await page.locator(MENU).getByRole('button', { name: /Закрепить/ }).count() === 0);
    await page.keyboard.press('Escape');

    await nav('Локальный диск (C:)').locator('[data-nav-chevron]').click();
    await nav('Windows').waitFor();
    ok('Стрелка раскрывает диск: подпапки с диска, на уровень глубже', await nav('Users').getAttribute('aria-level') === '3' && JSON.stringify((await callsOf('children')).map((c: any) => `${c.ref.rootId}|${c.ref.relativePath}|${c.peek}`)) === JSON.stringify(['disk-c||true']));
    ok('Подпапки читаются только раскрытой ветви: «Windows» без запроса', !(await callsOf('children')).some((c: any) => c.ref.relativePath === 'Windows'));
    await nav('Локальный диск (C:)').locator('[data-nav-chevron]').click();
    await nav('Windows').waitFor({ state: 'detached' });
    await nav('Локальный диск (C:)').locator('[data-nav-chevron]').click();
    await nav('Windows').waitFor();
    ok('Свёрнутая и раскрытая ветвь заново на диск не ходит', (await callsOf('children')).length === 1);
    await nav('Новый том (D:)').locator('[data-nav-chevron]').click();
    await nav('Черновик диска').waitFor();
    ok('Папка-черновик — ветвь того же дерева с пометкой «Только в Flux»', await nav('Черновик диска').getByText('Только в Flux').isVisible() && await nav('Данные').getByText('Только в Flux').count() === 0);
    await nav('Яндекс Диск').locator('[data-nav-chevron]').click();
    await nav('Фото').waitFor();
    await nav('Сеть').locator('[data-nav-chevron]').click();
    await nav('Проекты (Z:)').waitFor();
    ok('Облачная папка и «Сеть» раскрываются своими ветвями', await nav('Общая').isVisible() && await nav('Проекты (Z:)').isVisible());
    await nav('Сеть').click();
    ok('Щелчок по подписи открывает место и дерево не переключает', await place() === 'Сеть' && await nav('Проекты (Z:)').isVisible());

    await fresh();
    await typePath('C:\\Users\\Анна');
    await nav('Анна').waitFor();
    ok('Дерево раскрылось до открытой папки и подсветило её', await nav('Анна').getAttribute('aria-current') === 'page' && await nav('Users').isVisible() && await nav('Анна').getAttribute('aria-level') === '4');
    ok('Раскрыто только на пути к папке: «Windows» не прочитан', !(await callsOf('children')).some((c: any) => c.ref.relativePath === 'Windows'));
    await nav('Рабочий стол').click();
    ok('Подсвечена одна строка: новое место', JSON.stringify(await page.locator('[role="treeitem"][aria-current="page"]').evaluateAll((rows) => rows.map((r) => r.getAttribute('title')))) === JSON.stringify(['Рабочий стол']));

    // Клавиатура дерева
    await fresh();
    await nav('Главная').focus();
    await page.keyboard.press('ArrowDown');
    ok('Стрелка вниз — к следующей строке', await page.evaluate(() => (document.activeElement as HTMLElement).title) === 'Рабочий стол');
    await page.keyboard.press('End');
    ok('End — к последней строке, Home — к первой', await page.evaluate(() => (document.activeElement as HTMLElement).title) === 'Сеть');
    await page.keyboard.press('Home');
    ok('Home — к первой', await page.evaluate(() => (document.activeElement as HTMLElement).title) === 'Главная');
    await nav('Этот компьютер').focus();
    await page.keyboard.press('ArrowLeft');
    ok('Стрелка влево сворачивает раскрытую ветвь', await nav('Этот компьютер').getAttribute('aria-expanded') === 'false' && await nav('Новый том (E:)').count() === 0);
    await page.keyboard.press('ArrowRight');
    ok('Стрелка вправо раскрывает', await nav('Этот компьютер').getAttribute('aria-expanded') === 'true' && await nav('Новый том (E:)').count() === 1);
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowLeft');
    ok('Стрелка влево на листе уходит к родителю', await page.evaluate(() => (document.activeElement as HTMLElement).title) === 'Этот компьютер');
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
    ok('Enter открывает строку', await place() === 'C:');

    // Ширина
    const width = () => page.locator('[data-nav-pane]').evaluate((el) => el.getBoundingClientRect().width);
    const resizer = page.locator('[data-nav-resizer]');
    const rb = (await resizer.boundingBox())!;
    ok('Ширина панели по умолчанию 287', await width() === 287);
    await page.mouse.move(rb.x + 3, rb.y + 200); await page.mouse.down(); await page.mouse.move(rb.x + 60, rb.y + 200, { steps: 5 }); await page.mouse.move(rb.x + 116, rb.y + 200, { steps: 5 }); await page.mouse.up();
    ok('Границу можно тянуть: панель стала 400', near(await width(), 400, 3), await width());
    await page.waitForTimeout(300);
    ok('Ширина записана в viewState', (await callsOf('viewStateSet')).some((c: any) => typeof c.entries['explorer.navWidth.v1'] === 'number'));
    await page.reload(); await page.locator('[data-nav-pane]').waitFor(); await page.waitForTimeout(300);
    ok('После перезапуска ширина та же', near(await width(), 400, 3), await width());
    const rb2 = (await page.locator('[data-nav-resizer]').boundingBox())!;
    await page.mouse.move(rb2.x + 3, rb2.y + 200); await page.mouse.down(); await page.mouse.move(40, rb2.y + 200, { steps: 8 }); await page.mouse.up();
    ok('Слишком узкой панель не бывает: минимум 180', await width() === 180, await width());
    await page.locator('[data-nav-resizer]').focus(); await page.keyboard.press('ArrowRight');
    ok('Стрелки на границе меняют ширину на 16', await width() === 196, await width());

    // Быстрый доступ недоступен
    await page.evaluate(() => localStorage.clear());
    await fresh('&quick=0');
    ok('Без Быстрого доступа Windows — известные папки, закреплённые', JSON.stringify((await titles()).slice(0, 5)) === JSON.stringify(['Главная', 'Рабочий стол', 'Документы', 'Загрузки', 'Яндекс Диск']) && await page.locator('[role="treeitem"] svg[aria-label="Закреплено"]').count() === 3, await titles());
    if (SHOTS) {
      await fresh();
      await typePath('C:\\Users\\Анна', true);
      await nav('Анна').waitFor();
      await page.getByRole('button', { name: 'Подпапки: Локальный диск (C:)' }).click();
      await page.getByRole('listbox').waitFor();
      await page.screenshot({ path: `${SHOTS}/shell-crumb-menu.png`, clip: { x: 0, y: 0, width: 700, height: 400 } });
      await page.keyboard.press('Escape');
    }
    allErrors.push(...pageErrors);
    ok('Консоль и страница молчат: ни ошибок, ни необработанных исключений', allErrors.length === 0, allErrors.slice(0, 3));
  } finally {
    await browser.close();
  }
  process.exit(done());
})().catch((error) => { console.error(error); process.exit(1); });
