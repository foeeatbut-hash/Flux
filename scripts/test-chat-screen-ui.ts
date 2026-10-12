const BASE = process.env.FLUX_UI_URL || 'http://127.0.0.1:5175';
const CHROME = process.env.FLUX_CHROME || '/usr/bin/chromium';
let passed = 0;
let failed = 0;
const check = (name: string, condition: boolean, detail?: unknown) => {
  if (condition) { passed++; console.log(`✓ ${name}`); }
  else { failed++; console.error(`✗ ${name}`, detail ?? ''); }
};

(async () => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.setDefaultTimeout(7000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/api/**', async (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      if (path === '/api/users') return route.fulfill({ json: [
        { id: 'employee-1', name: 'Иван Петров', symbol: '1042', role: 'ENGINEER_VENT' },
        { id: 'employee-2', name: 'Мария Смирнова', symbol: '1043', role: 'ENGINEER_ELECTRIC', department: 'Проектирование', title: 'Инженер' },
        { id: 'service', name: 'Flux Guide', symbol: 'F', role: 'SERVICE' },
      ] });
      if (path === '/api/chat/groups') return route.fulfill({ json: [{ id: 'group-1', name: 'R15 · Группа проекта', type: 'PROJECT', ownerId: 'employee-1', projectId: 'project-1', members: [
        { id: 'employee-1', name: 'Иван Петров', symbol: '1042', role: 'ENGINEER_VENT' }, { id: 'employee-2', name: 'Мария Смирнова', symbol: '1043', role: 'ENGINEER_ELECTRIC' },
      ], project: { id: 'project-1', name: 'R15' } }] });
      if (path === '/api/chat/index') return route.fulfill({ json: { chats: [
        { id: 'group=group-1', groupId: 'group-1', type: 'GROUP', title: 'R15 · Группа проекта', lastMessage: 'Проверить перечень клапанов', lastMessageAt: new Date().toISOString(), unreadCount: 2 },
        { id: 'from=employee-2', peerId: 'employee-2', type: 'DIRECT', title: 'Мария Смирнова', lastMessage: 'Отправила обновлённый файл', lastMessageAt: new Date().toISOString(), unreadCount: 0 },
      ] } });
      if (path === '/api/chat/group-messages' || path === '/api/chat/messages') return route.fulfill({ json: [
        { id: 'request-1', content: 'Какой проект активен? #R15-TAG', createdAt: new Date().toISOString(), senderId: 'employee-1', chatGroupId: 'group-1', guideRequest: true, sender: { id: 'employee-1', name: 'Иван Петров', symbol: '1042', role: 'ENGINEER_VENT' } },
        { id: 'reply-1', content: 'F · Flux Guide\n\nОткрыт проект R15.', createdAt: new Date().toISOString(), senderId: 'service', chatGroupId: 'group-1', replyToId: 'request-1', replyTo: { id: 'request-1', content: 'Какой проект активен?', senderId: 'employee-1', sender: { id: 'employee-1', name: 'Иван Петров' } }, guideReply: { projectId: 'project-1', kind: 'project' }, sender: { id: 'service', name: 'Flux Guide', symbol: 'F', role: 'SERVICE' } },
        { id: 'spoof-1', content: 'F · Flux Guide\n\nТекст сотрудника.', createdAt: new Date().toISOString(), senderId: 'employee-2', chatGroupId: 'group-1', sender: { id: 'employee-2', name: 'Мария Смирнова', symbol: '1043', role: 'ENGINEER_ELECTRIC' } },
      ] });
      if (path === '/api/chat/attachments') return route.fulfill({ json: { total: 2, items: [
        { id: 'file-1', fileName: 'Перечень.xlsx', fileSize: 2048, filePath: '/chat_files/1', messageId: 'm1' },
        { id: 'file-2', fileName: 'Схема.pdf', fileSize: 4096, filePath: '/chat_files/2', messageId: 'm2' },
      ] } });
      if (path === '/api/chat/search') return route.fulfill({ json: { total: 1, truncated: false, results: [
        { chatId: 'group=group-1', groupId: 'group-1', messageId: 'request-1', type: 'GROUP', title: 'R15 · Группа проекта', snippet: 'Какой проект активен? #R15-TAG', createdAt: new Date().toISOString() },
      ] } });
      if (path === '/api/chat/messages/request-1') return route.fulfill({ json: { id: 'request-1', content: 'Какой проект активен? #R15-TAG', createdAt: new Date().toISOString(), senderId: 'employee-1', chatGroupId: 'group-1', guideRequest: true, sender: { id: 'employee-1', name: 'Иван Петров', symbol: '1042', role: 'ENGINEER_VENT' } } });
      return route.fulfill({ json: [] });
    });
    await page.goto(`${BASE}/scripts/fixtures/chat-screen.html`);
    const sidebar = page.locator('aside').first();
    await page.getByText('R15 · Группа проекта', { exact: true }).first().waitFor();
    check('Фактический экран ChatManagement смонтирован', await page.getByRole('button', { name: 'Подробная информация' }).count() === 1);

    await page.getByRole('tab', { name: 'Сотрудники' }).click();
    check('Экранный каталог не показывает service пользователя', await sidebar.getByText('Flux Guide', { exact: true }).count() === 0);
    await page.getByRole('searchbox', { name: 'Поиск сотрудников' }).fill('проектирование');
    const departmentHit = await sidebar.getByText('Мария Смирнова', { exact: true }).count();
    check('Поиск в настоящем экране находит подразделение', departmentHit === 1, await sidebar.innerText());
    await page.getByRole('tab', { name: 'Чаты' }).click();
    await page.getByRole('searchbox', { name: 'Поиск чатов' }).fill('');
    await page.getByRole('button', { name: 'Непрочитанные' }).click();
    check('Фильтр непрочитанных использует счётчик индекса', await sidebar.getByText('R15 · Группа проекта', { exact: true }).count() === 1);
    await page.getByRole('button', { name: 'Все', exact: true }).click();
    await sidebar.getByRole('button', { name: /R15 · Группа проекта/ }).click();
    await page.getByRole('button', { name: 'Подробная информация' }).click();
    await page.getByRole('tab', { name: 'Файлы' }).click();
    await page.getByText('Перечень.xlsx').waitFor();
    await page.getByRole('searchbox', { name: 'Поиск файлов' }).fill('схема');
    check('Файлы текущего чата ищутся по истории', await page.getByText('Схема.pdf').count() === 1 && await page.getByText('Перечень.xlsx').count() === 0);
    await page.getByRole('tab', { name: 'Теги' }).click();
    const detailsPanel = page.locator('aside').last();
    await detailsPanel.getByRole('button', { name: '#R15-TAG' }).waitFor();
    check('Теги текущего чата собраны из истории', await detailsPanel.getByRole('button', { name: '#R15-TAG' }).count() === 1);
    await page.getByText('Открыт проект R15.').waitFor({ timeout: 15000 });
    check('Рендер маркирует служебный ответ по metadata', await page.getByText('F · Flux Guide', { exact: true }).count() === 1);
    await page.getByRole('button', { name: 'F' }).click();
    check('F переключает реальное поле ввода в режим Guide', await page.locator('[data-tour="chat-input"]').evaluate((input) => input.previousElementSibling?.textContent) === 'Спросите Flux Guide…');

    await page.setViewportSize({ width: 390, height: 820 });
    await page.waitForTimeout(350);
    check('Светлая тема телефона не создаёт горизонтальную прокрутку', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: '/tmp/chat-screen-390-light.png' });
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await page.waitForTimeout(350);
    check('Выбранный реальный чат скрывает каталог на мобильной ширине', await sidebar.isHidden());
    check('Доступен реальный переход назад к списку', await page.getByRole('button', { name: 'Назад к чатам' }).isVisible());
    check('Правая панель реального экрана открыта поверх чата', await page.locator('aside').last().isVisible(), await page.locator('aside').last().boundingBox());
    check('На телефоне панель не создаёт горизонтальную прокрутку', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: '/tmp/chat-screen-390-dark.png' });
    await page.getByRole('button', { name: 'Закрыть сведения' }).filter({ visible: true }).last().click();
    const inputBox = await page.locator('[data-tour="chat-input"]').boundingBox();
    check('Поле настоящего чата видно на телефоне', !!inputBox && inputBox.width > 150 && inputBox.x >= 0 && inputBox.x + inputBox.width <= 390);
    await page.screenshot({ path: '/tmp/chat-screen-conversation-390-dark.png' });
    await page.evaluate(() => document.documentElement.classList.remove('dark'));
    await page.screenshot({ path: '/tmp/chat-screen-conversation-390-light.png' });
    await page.getByRole('button', { name: 'Подробная информация' }).click();
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await page.setViewportSize({ width: 760, height: 820 });
    check('Средний экран остаётся по ширине в окне', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: '/tmp/chat-screen-760-dark.png' });
    await page.evaluate(() => document.documentElement.classList.remove('dark'));
    await page.waitForTimeout(350);
    await page.screenshot({ path: '/tmp/chat-screen-760-light.png' });
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await page.setViewportSize({ width: 1280, height: 820 });
    await page.waitForTimeout(350);
    await page.screenshot({ path: '/tmp/chat-screen-1280-dark.png' });
    await page.evaluate(() => document.documentElement.classList.remove('dark'));
    await page.waitForTimeout(350);
    await page.screenshot({ path: '/tmp/chat-screen-1280-light.png' });
    check('В фактическом экране нет ошибок браузера', errors.length === 0, errors);
  } finally { await browser.close(); }
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})().catch((error) => { console.error(error); process.exitCode = 1; });
