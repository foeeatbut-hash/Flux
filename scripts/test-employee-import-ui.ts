/** Проверяет диалог импорта в Chromium с ответами сервера, заданными сценарием. */
const BASE = process.env.FLUX_UI_URL || 'http://127.0.0.1:5173';
const CHROME = process.env.FLUX_CHROME || '/usr/bin/chromium';
let passed = 0; let failed = 0;
const ok = (name: string, value: boolean) => { if (value) { passed++; console.log(`✓ ${name}`); } else { failed++; console.error(`✗ ${name}`); } };
const field = (page: import('playwright-core').Page, label: string) => page.locator(`//label[contains(@class,"fx-field")][.//span[contains(@class,"fx-label") and normalize-space(.)="${label}"]]//select`);

(async () => {
  const [{ chromium }, XLSX] = await Promise.all([import('playwright-core'), import('xlsx')]);
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 }, acceptDownloads: false });
    const errors: string[] = [];
    const requests: any[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/api/users/import/**', async (route) => {
      const url = route.request().url();
      const requestBody = route.request().postDataJSON();
      requests.push({ url, body: requestBody });
      if (url.endsWith('/preview')) return route.fulfill({ json: { rows: [{ row: 2, values: { symbol: '001', name: 'Иван Иванов', lastName: 'Иванов', firstName: 'Иван', middleName: '', role: 'ENGINEER_VENT', position: 'Инженер', department: '', email: 'ivan@example.ru', password: '' }, action: 'create' }] } });
      if (url.endsWith('/apply')) return route.fulfill({ json: { credentials: [{ symbol: '001', password: 'Start-Password-42' }], undoToken: 'opaque-undo-token', imported: 1 } });
      if (url.endsWith('/undo')) return route.fulfill({ json: { undone: 1 } });
      return route.fulfill({ status: 404, json: { message: 'Unknown import endpoint' } });
    });
    await page.goto(`${BASE}/scripts/fixtures/employee-import-ui.html`);
    await page.getByRole('dialog', { name: 'Импорт сотрудников' }).waitFor();
    await page.evaluate(() => {
      const click = HTMLAnchorElement.prototype.click;
      const createObjectURL = URL.createObjectURL;
      HTMLAnchorElement.prototype.click = function () { (window as any).__download = { href: this.href, name: this.download }; };
      URL.createObjectURL = (blob: Blob) => { (window as any).__downloadBlob = blob; return createObjectURL.call(URL, blob); };
    });
    await page.getByRole('button', { name: 'Скачать шаблон XLSX' }).click();
    const templateBytes = await page.evaluate(async () => Array.from(new Uint8Array(await (window as any).__downloadBlob.arrayBuffer())));
    const template = XLSX.read(Uint8Array.from(templateBytes), { type: 'array' });
    const templateHeader = XLSX.utils.sheet_to_json<string[]>(template.Sheets[template.SheetNames[0]], { header: 1 })[0] || [];
    ok('Шаблон XLSX содержит заголовок «Электронная почта»', templateHeader.includes('Электронная почта'));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Табельный номер', 'Фамилия', 'Имя', 'Электронная почта'], ['001', 'Иванов', 'Иван', 'ivan@example.ru']]), 'Сотрудники');
    const file = { name: 'employees.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) };

    await page.setViewportSize({ width: 420, height: 850 });
    ok('Диалог не создаёт горизонтальную прокрутку на узком экране', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.locator('input[type=file]').setInputFiles(file);
    await field(page, 'Электронная почта').waitFor();
    ok('Заголовок «Электронная почта» автоматически связан с полем почты', await field(page, 'Электронная почта').inputValue() === '3');
    ok('ADMIN не предлагается пользователю с ролью ADMIN', await field(page, 'Роль по умолчанию для новых строк').locator('option').allTextContents().then((items) => items.every((item) => !item.includes('Администратор') && !item.includes('Владелец'))));

    await page.getByRole('button', { name: 'Показать предпросмотр' }).click();
    await page.getByRole('row', { name: /Иван Иванов/ }).waitFor();
    await page.screenshot({ path: '/tmp/employee-import-light.png' });
    ok('Предпросмотр получает файл и сопоставления', requests.some((r) => r.url.endsWith('/preview') && r.body.mapping.email === 3));
    await page.getByRole('button', { name: /Импортировать 1/ }).click();
    await page.getByText(/Создано сотрудников: 1/).waitFor();
    ok('Успешный импорт сохраняет только непрозрачный undo token и время', await page.evaluate(() => {
      const saved = JSON.parse(localStorage.getItem('flux_employee_import_undo_employee-ui-actor') || 'null');
      return saved?.token === 'opaque-undo-token' && Number.isFinite(saved.savedAt) && !JSON.stringify(localStorage).includes('Start-Password-42');
    }));
    ok('После импорта нельзя изменить сопоставления или повторить импорт', await field(page, 'Электронная почта').isDisabled() && await page.getByRole('button', { name: /Импортировать/ }).count() === 0);

    await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
    await page.getByRole('dialog', { name: 'Не скачаны начальные пароли' }).waitFor();
    await page.getByRole('button', { name: 'Отмена' }).click();
    ok('Закрытие с ещё не выгруженными паролями требует подтверждения', await page.getByRole('dialog', { name: 'Импорт сотрудников' }).isVisible());
    await page.locator('label.fx-btn').click();
    await page.locator('input[type=file]').setInputFiles(file);
    await page.getByRole('dialog', { name: 'Не скачаны начальные пароли' }).waitFor();
    await page.getByRole('button', { name: 'Отмена' }).click();
    ok('Замена файла также требует подтверждения и сохраняет пароли при отмене', await page.getByText(/Создано сотрудников: 1/).isVisible());

    await page.getByRole('button', { name: 'Скачать пароли CSV' }).click();
    const csv = await page.evaluate(async () => await (window as any).__downloadBlob.text());
    ok('CSV выгружает пароль без записи в localStorage', csv.includes('Start-Password-42') && await page.evaluate(() => !JSON.stringify(localStorage).includes('Start-Password-42')));

    await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
    await page.getByRole('dialog', { name: 'Импорт сотрудников' }).waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Открыть импорт' }).click();
    await page.getByRole('dialog', { name: 'Импорт сотрудников' }).waitFor();
    const undoButton = page.getByRole('button', { name: 'Отменить импорт' });
    const restoredUndo = await undoButton.waitFor({ timeout: 2000 }).then(() => true).catch(() => false);
    ok(`При повторном открытии восстанавливается кнопка отмены импорта (есть token: ${await page.evaluate(() => !!localStorage.getItem('flux_employee_import_undo_employee-ui-actor'))})`, restoredUndo);
    await page.getByRole('button', { name: 'Отменить импорт' }).click();
    await page.getByRole('button', { name: 'Отменить импорт' }).waitFor({ state: 'detached' });
    ok('Восстановленный токен принимается серверным undo endpoint', requests.some((r) => r.url.endsWith('/undo') && r.body.undoToken === 'opaque-undo-token') && await page.evaluate(() => localStorage.getItem('flux_employee_import_undo_employee-ui-actor') === null));

    await page.locator('input[type=file]').setInputFiles(file);
    await field(page, 'Роль по умолчанию для новых строк').waitFor();
    await page.getByRole('button', { name: 'Показать предпросмотр' }).click();
    await page.getByRole('row', { name: /Иван Иванов/ }).waitFor();
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key: string, value: string) { if (key.startsWith('flux_employee_import_undo_')) throw new Error('Quota exceeded'); return original.call(this, key, value); };
      (window as any).__restoreStorage = () => { Storage.prototype.setItem = original; };
    });
    await page.getByRole('button', { name: /Импортировать 1/ }).click();
    await page.getByText(/Создано сотрудников: 1/).waitFor();
    ok('Сбой localStorage не превращает успешный серверный импорт в ошибку', await page.getByText(/Создано сотрудников: 1/).isVisible() && await page.getByRole('alert').count() === 0);
    await page.evaluate(() => (window as any).__restoreStorage());

    await page.setViewportSize({ width: 1280, height: 820 });
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    ok('Диалог остаётся в пределах широкого viewport в тёмной теме', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.documentElement.classList.contains('dark')));
    await page.screenshot({ path: '/tmp/employee-import-dark.png' });
    ok('Нет ошибок React или браузера', errors.length === 0);
  } finally { await browser.close(); }
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})().catch((error) => { console.error(error); process.exitCode = 1; });
