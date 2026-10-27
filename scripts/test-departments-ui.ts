import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
/**
 * Экран «Сотрудники», подразделения (docs/departments.md, этап 1): вкладка
 * «Подразделения» с деревом и людьми, колонка и фильтр-дерево в списке, поиск по
 * подразделению, массовый перевод с предпросмотром и отменой.
 * Ответы сервера заданы сценарием (страница scripts/fixtures/users-screen-ui.html);
 * настоящие маршруты проверяет scripts/test-departments.ts.
 * SHOT=путь — снимки в обеих темах.
 */
const BASE = process.env.FLUX_UI_URL || 'http://127.0.0.1:5173';
let checks = 0;
const check = (label: string, condition: boolean, detail?: unknown) => { assert.ok(condition, `${label}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`); checks++; };
const dep = (id: string, name: string, kind: string, parentId: string | null, people: number, total: number, extra: any = {}) =>
  ({ id, name, kind, parentId, people, total, sortOrder: 0, archivedAt: null, ...extra });

async function run() {
  const browser = await chromium.launch({ executablePath: process.env.FLUX_CHROME || '/usr/bin/chromium', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.stack || e.message));
    const people: any[] = [['Раупов Хусрав', '4519', 'd-ovik'], ['Цыбуковский Антон', '2201', 'd-ovik'], ['Иванова Мария', '3310', 'd-auto'], ['Белов Дмитрий', '3313', null]]
      .map(([name, symbol, departmentId], i) => ({ id: `u${i}`, name, symbol, role: 'ENGINEER_VENT', isActive: true, hasSignature: false, departmentId, createdAt: new Date(2026, 0, 5 + i).toISOString() }));
    const departments = [
      dep('root', 'Компания', 'company', null, 0, 3),
      dep('d-nsk', 'Новосибирск', 'branch', 'root', 0, 3, { city: 'Новосибирск', timezone: 'Asia/Novosibirsk' }),
      dep('d-ovik', 'ОВиК', 'division', 'd-nsk', 2, 2), dep('d-auto', 'Автоматика', 'division', 'd-nsk', 1, 1),
      dep('d-msk', 'Москва', 'branch', 'root', 0, 0, { city: 'Москва', timezone: 'Europe/Moscow' }),
    ];
    const calls: Array<{ url: string; body: any }> = [];
    await page.route('**/api/**', async (route) => {
      const url = route.request().url();
      const method = route.request().method();
      if (url.includes('/api/departments')) {
        const body = route.request().postDataJSON?.() ?? null;
        if (method !== 'GET') calls.push({ url: url.replace(/^.*\/api\/departments/, ''), body });
        if (url.endsWith('/assign/preview')) return route.fulfill({ json: { department: departments[1], items: (body.userIds as string[]).map((id) => {
          const u = people.find((p) => p.id === id); return { userId: id, symbol: u.symbol, name: u.name, role: u.role, fromId: u.departmentId, toId: body.departmentId, status: u.departmentId === body.departmentId ? 'same' : 'move' };
        }) } });
        if (url.endsWith('/assign')) return route.fulfill({ json: { moved: 2, same: 0, skipped: [], undoToken: 'token-1' } });
        if (url.endsWith('/undo')) return route.fulfill({ json: { success: true, restored: 2, removed: 0 } });
        return route.fulfill({ json: { rootId: 'root', unassigned: 1, departments } });
      }
      if (url.endsWith('/updates/devices')) return route.fulfill({ json: { inst: 'company', devices: [], releases: [] } });
      if (url.endsWith('/users')) return route.fulfill({ json: people });
      if (url.endsWith('/roles')) return route.fulfill({ json: [] });
      return route.fulfill({ json: [] });
    });
    await page.goto(`${BASE}/scripts/fixtures/users-screen-ui.html`);
    await page.locator('.fx-table').getByText('Раупов Хусрав', { exact: true }).waitFor({ timeout: 10000 }).catch(async (error) => {
      console.error('Страница:', (await page.locator('body').innerText()).slice(0, 400), 'Ошибки:', errors.join('; '));
      throw error;
    });
    const shot = process.env.SHOT;
    const snap = async (name: string) => {
      if (!shot) return;
      for (const dark of [false, true]) {
        await page.evaluate((d) => document.documentElement.classList.toggle('dark', d), dark);
        await page.screenshot({ path: shot.replace(/\.png$/, `${name}${dark ? '-dark' : ''}.png`) });
      }
      await page.evaluate(() => document.documentElement.classList.remove('dark'));
    };

    // Список: колонка, фильтр-дерево, поиск по подразделению
    check('Колонка «Подразделение» в списке', await page.getByRole('columnheader', { name: 'Подразделение' }).count() === 1);
    check('В строке — путь «Город / Отдел»', await page.locator('.fx-table tbody tr', { hasText: 'Раупов Хусрав' }).getByText('Новосибирск / ОВиК').count() === 1);
    check('Фильтр-дерево показывает число людей', await page.locator('[role=tree] [role=treeitem]', { hasText: 'Новосибирск' }).first().locator('.fx-n').innerText() === '3');
    await page.locator('[role=treeitem]', { hasText: 'Автоматика' }).click();
    check('Выбор подразделения оставляет его людей', await page.locator('.fx-table tbody tr').count() === 1);
    await page.locator('[role=treeitem]', { hasText: 'Без подразделения' }).click();
    check('«Без подразделения» — те, у кого его нет', await page.locator('.fx-table tbody tr').count() === 1 && await page.getByText('Белов Дмитрий').count() >= 1);
    await page.locator('[role=treeitem]', { hasText: 'Все сотрудники' }).click();
    await page.getByRole('textbox', { name: 'Поиск сотрудника' }).fill('автомат');
    check('Поиск находит по подразделению', await page.locator('.fx-table tbody tr').count() === 1);
    await page.getByRole('textbox', { name: 'Поиск сотрудника' }).fill('');
    await page.getByRole('button', { name: 'Подразделения' }).first().click();
    check('Дерево сворачивается кнопкой', await page.locator('[role=tree]').count() === 0);
    await page.getByRole('button', { name: 'Подразделения' }).first().click();
    const rowHeights = await page.$$eval('.fx-table tbody tr', (rows) => rows.map((r) => Math.round(r.getBoundingClientRect().height)));
    check(`Строки одной высоты 28–40: ${rowHeights}`, new Set(rowHeights).size === 1 && rowHeights[0] >= 28 && rowHeights[0] <= 40);

    // Массовый перевод: отметить → предпросмотр → применить → отменить
    await page.getByRole('checkbox', { name: 'Отметить: Раупов Хусрав' }).check();
    await page.getByRole('checkbox', { name: 'Отметить: Иванова Мария' }).check();
    await page.getByRole('button', { name: 'Перевести в подразделение…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Перевести в подразделение' });
    await dialog.waitFor();
    await dialog.getByRole('button', { name: 'Подразделение для перевода' }).click();
    await page.getByRole('option', { name: 'Москва', exact: true }).click();
    await dialog.getByText('Будет переведено: 2').waitFor();
    const planText = await dialog.innerText();
    check('Предпросмотр показывает, кто откуда переводится', planText.includes('Новосибирск / ОВиК') && planText.includes('Новосибирск / Автоматика') && (planText.match(/переводится/g) || []).length === 2, planText);
    check('Предпросмотр ничего не записал', !calls.some((c) => c.url === '/assign'));
    await snap('-assign');
    await dialog.getByRole('button', { name: 'Перевести 2' }).click();
    await page.getByText('Переведено: 2 сотрудника → «Москва»').waitFor();
    const apply = calls.find((c) => c.url === '/assign');
    check('Применение отправило отмеченных и подразделение', !!apply && apply.body.departmentId === 'd-msk' && apply.body.userIds.length === 2, apply);
    await page.getByRole('button', { name: 'Отменить', exact: true }).click();
    await page.getByText('Переведено: 2 сотрудника → «Москва»').waitFor({ state: 'detached' });
    check('Отмена вызвала откат по токену', calls.some((c) => c.url === '/undo' && c.body.undoToken === 'token-1'));

    // Вкладка «Подразделения»
    await snap('-list');
    await page.getByRole('tab', { name: 'Подразделения' }).click();
    await page.locator('[role=treeitem]', { hasText: 'Новосибирск' }).first().click();
    await page.getByText('Asia/Novosibirsk').waitFor();
    check('Справа — город, часовой пояс и люди выбранного', await page.getByText('Раупов Хусрав').count() === 1 && await page.getByText('Иванова Мария').count() === 1);
    check('Отдел наследует пояс города и говорит об этом', await (async () => { await page.locator('[role=treeitem]', { hasText: 'ОВиК' }).click(); return await page.getByText('от «Новосибирск»').count() >= 1; })());
    check('Создать, изменить и архив доступны владельцу', await page.getByRole('button', { name: 'Создать' }).isEnabled() && await page.getByRole('button', { name: 'Изменить' }).isEnabled() && await page.getByRole('button', { name: 'В архив' }).isEnabled());
    await page.locator('[role=treeitem]', { hasText: 'Компания' }).click();
    check('Компанию в архив отправить нельзя', await page.getByRole('button', { name: 'В архив' }).isDisabled());
    await snap('-tab');
    // Создание внутри выбранного
    await page.locator('[role=treeitem]', { hasText: 'Москва' }).click();
    await page.getByRole('button', { name: 'Создать' }).click();
    await page.getByRole('dialog', { name: /Новое подразделение/ }).waitFor();
    await page.getByPlaceholder('Например, ОВиК').fill('Бухгалтерия');
    await page.getByRole('button', { name: 'Создать', exact: true }).last().click();
    await page.waitForTimeout(400);
    const created = calls.find((c) => c.url === '' && c.body?.name === 'Бухгалтерия');
    check('Создание шлёт название и родителя', !!created && created.body.parentId === 'd-msk', created);
    // Архив с переводом людей
    await page.locator('[role=treeitem]', { hasText: 'Новосибирск' }).first().click();
    await page.getByRole('button', { name: 'В архив' }).click();
    const archive = page.getByRole('dialog', { name: /В архив/ });
    await archive.waitFor();
    check('Архив города с людьми требует выбрать, куда их перевести', await archive.getByText(/Куда перевести людей \(3 сотрудника\)/).count() === 1);
    await archive.getByRole('button', { name: 'Отмена' }).click();
    check(`Нет ошибок: ${errors.join('; ')}`, errors.length === 0);
    console.log(`${checks} проверок подразделений на экране пройдено, 0 провалено`);
  } finally { await browser.close(); }
}
void run().catch((error) => { console.error(error); process.exitCode = 1; });
