const BASE = process.env.FLUX_UI_URL || 'http://127.0.0.1:5173';
const CHROME = process.env.FLUX_CHROME || '/usr/bin/chromium';
let passed = 0;
let failed = 0;
const check = (name: string, condition: boolean, details?: unknown) => {
  if (condition) { passed++; console.log(`✓ ${name}`); }
  else { failed++; console.error(`✗ ${name}`, details ?? ''); }
};

(async () => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/api/chat/attachments**', (route) => route.fulfill({ json: { total: 2, items: [
      { id: 'file-1', fileName: 'Перечень.xlsx', fileSize: 2048, filePath: '/chat_files/1', messageId: 'm1' },
      { id: 'file-2', fileName: 'Схема.pdf', fileSize: 4096, filePath: '/chat_files/2', messageId: 'm2' },
    ] } }));
    await page.route('**/api/chat/search**', (route) => route.fulfill({ json: { total: 1, truncated: false, results: [
      { chatId: 'group=group-1', messageId: 'request-1', snippet: 'Какой проект активен? #R15-TAG', createdAt: new Date().toISOString() },
    ] } }));
    await page.goto(`${BASE}/scripts/fixtures/chat-ui.html`);
    await page.getByRole('tab', { name: 'Чаты' }).waitFor();
    const sidebar = page.locator('aside').first();

    await page.getByRole('tab', { name: 'Сотрудники' }).click();
    check('Каталог сотрудников не показывает сервисный Flux Guide', await sidebar.getByText('Flux Guide', { exact: true }).count() === 0);
    await page.getByRole('searchbox', { name: 'Поиск сотрудников' }).fill('проектирование');
    check('Поиск каталога находит сотрудника по подразделению', await sidebar.getByText('Иван Петров', { exact: true }).count() === 1);
    check('Поиск по подразделению скрывает несовпадающих сотрудников', await sidebar.getByText('Мария Смирнова', { exact: true }).count() === 0);

    await page.getByRole('tab', { name: 'Чаты' }).click();
    await page.getByRole('searchbox', { name: 'Поиск чатов' }).fill('');
    await page.getByRole('button', { name: 'Непрочитанные' }).click();
    check('Фильтр непрочитанных оставляет только разговоры с реальным счётчиком', await sidebar.getByText('R15 · Группа проекта', { exact: true }).count() === 1, await sidebar.getByText('R15 · Группа проекта', { exact: true }).count());
    await page.getByRole('button', { name: 'Личные', exact: true }).click();
    check('Фильтр личных убирает группы', await sidebar.getByText('R15 · Группа проекта', { exact: true }).count() === 0);
    await page.getByRole('button', { name: 'Все', exact: true }).click();
    await page.getByRole('button', { name: 'Искать по всей переписке' }).click();
    await page.getByRole('searchbox', { name: 'Искать по всей переписке' }).fill('проект');
    await sidebar.getByText('Какой проект активен?').waitFor();
    check('Отдельный поиск показывает серверные результаты истории', await sidebar.getByText('Какой проект активен?').count() > 0);

    check('Правая панель закрыта по умолчанию', await page.getByRole('tab', { name: 'Обзор' }).count() === 0);
    const center = page.getByRole('main');
    const wideBefore = await center.boundingBox();
    await page.getByRole('button', { name: 'Подробная информация' }).click();
    await page.getByRole('tab', { name: 'Обзор' }).waitFor();
    const wideAfter = await center.boundingBox();
    check('На широком окне панель занимает отдельную ширину', !!wideBefore && !!wideAfter && wideAfter.width < wideBefore.width - 200);
    await page.getByRole('tab', { name: 'Файлы' }).click();
    await page.getByText('Перечень.xlsx').waitFor();
    await page.getByRole('searchbox', { name: 'Поиск файлов' }).fill('схема');
    check('Файлы ищутся по истории разговора', await page.getByText('Схема.pdf').count() === 1 && await page.getByText('Перечень.xlsx').count() === 0);
    await page.getByRole('tab', { name: 'Теги' }).click();
    await page.getByRole('button', { name: '#R15-TAG' }).waitFor();
    check('Вкладка тегов показывает уникальные ссылки переписки', await page.getByRole('button', { name: '#R15-TAG' }).count() === 1);
    await page.screenshot({ path: '/tmp/chat-wide-light.png' });

    await page.setViewportSize({ width: 390, height: 820 });
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    check('В узком окне выбранный чат занимает экран, список скрыт', await sidebar.isHidden());
    check('На узком окне доступна кнопка возврата к списку', await page.getByRole('button', { name: 'Назад к чатам' }).isVisible());
    await page.locator('aside').last().getByRole('button', { name: 'Закрыть сведения' }).click();
    await page.getByRole('button', { name: 'Назад к чатам' }).click();
    check('Возврат из чата открывает список', await sidebar.isVisible());
    await sidebar.getByRole('button', { name: /R15 · Группа проекта/ }).click();
    await page.getByRole('button', { name: 'Подробная информация' }).click();
    await page.getByRole('tab', { name: 'Теги' }).waitFor();
    const narrowBefore = await center.boundingBox();
    const panel = page.locator('aside').filter({ has: page.getByRole('tab', { name: 'Теги' }) });
    const panelBox = await panel.boundingBox();
    const narrowAfter = await center.boundingBox();
    check('На узком окне панель перекрывает ленту, не сжимая её', !!narrowBefore && !!narrowAfter && !!panelBox && Math.abs(narrowAfter.width - narrowBefore.width) < 1 && panelBox.x >= 390 - panelBox.width);
    check('Нет горизонтальной прокрутки в узком окне', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.screenshot({ path: '/tmp/chat-narrow-dark.png' });
    await page.setViewportSize({ width: 760, height: 820 });
    check('Средняя ширина остаётся в пределах окна', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.screenshot({ path: '/tmp/chat-medium-dark.png' });
    await page.setViewportSize({ width: 1280, height: 820 });
    check('Широкая тёмная тема остаётся в пределах окна', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.screenshot({ path: '/tmp/chat-wide-dark.png' });

    await page.getByRole('button', { name: 'F' }).click();
    check('F включает отдельное поле Flux Guide', await page.getByRole('textbox', { name: 'Сообщение' }).getAttribute('placeholder') === 'Спросить Flux Guide…');
    check('F помечает запрос и отдельный ответ сервисного Guide', await page.getByText('Запрос Flux Guide', { exact: true }).count() === 1 && await page.getByText('F · Flux Guide', { exact: true }).count() === 1);
    check('Текст сотрудника с префиксом не получает метку ответа Guide', await page.getByText('F · Flux Guide', { exact: true }).count() === 1);
    check('В браузере нет ошибок React', errors.length === 0, errors);
  } finally { await browser.close(); }
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})().catch((error) => { console.error(error); process.exitCode = 1; });
