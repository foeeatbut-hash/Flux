import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
/**
 * Экран «Сотрудники», должности и уровень доступа: вкладка «Должности»,
 * колонка «Должность» с отметкой администратора, карточка (основная и
 * дополнительные должности, уровень доступа), регистрация.
 * Ответы сервера заданы сценарием (страница scripts/fixtures/positions-ui.html,
 * вид смотрящего — ?as=owner|keeper|admin); настоящие маршруты и правила
 * проверяет scripts/test-positions.ts.
 * SHOT=путь — снимки в обеих темах.
 */
const BASE = process.env.FLUX_UI_URL || 'http://127.0.0.1:5173';
let checks = 0;
const check = (label: string, condition: boolean, detail?: unknown) => { assert.ok(condition, `${label}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`); checks++; };
const grant = (...ids: string[]) => JSON.stringify(Object.fromEntries(ids.map((id) => [id, { enabled: true, until: null }])));

const roles = [
  { id: 'r-vent', code: 'ENGINEER_VENT', name: 'Инженер ОВиК', description: 'Вентиляция и кондиционирование', color: 'sky', icon: 'airplay', level: 50, isSystem: true, permissions: grant('tags.manage', 'files.upload'), sortOrder: 30 },
  { id: 'r-auto', code: 'ENGINEER_AUTO', name: 'Инженер КИПиА', description: 'Автоматика и приборы', color: 'emerald', icon: 'cpu', level: 50, isSystem: true, permissions: grant('equipment.manage', 'e3.export'), sortOrder: 40 },
  { id: 'r-mgr', code: 'MANAGER', name: 'Менеджер проектов', description: 'Проекты, закупки', color: 'amber', icon: 'briefcase', level: 20, isSystem: true, permissions: grant('project.manage', 'procurement.manage'), sortOrder: 20 },
  { id: 'r-cad', code: 'CAD', name: 'Конструктор', description: '', color: 'violet', icon: 'ruler', level: 50, isSystem: false, permissions: '{}', sortOrder: 100 },
  // Строка уровня доступа в ответе сервера старой версии: интерфейс не должен считать её должностью
  { id: 'r-admin', code: 'ADMIN', name: 'Администратор', description: '', color: 'rose', icon: 'shield-check', level: 1, isSystem: true, permissions: '{}', sortOrder: 10 },
];
const person = (i: number, name: string, symbol: string, extra: any) => ({ id: `u${i}`, name, lastName: name.split(' ')[0], firstName: name.split(' ')[1], symbol, isActive: true, hasSignature: false, createdAt: new Date(2026, 0, 5 + i).toISOString(), ...extra });
const people = [
  person(0, 'Раупов Хусрав', '4519', { role: 'ENGINEER_VENT', positionCode: 'ENGINEER_VENT', extraPositions: JSON.stringify(['ENGINEER_AUTO']) }),
  person(1, 'Цыбуковский Антон', '2201', { role: 'MANAGER' }), // запись до разделения: должность из role
  person(2, 'Иванова Мария', '3310', { role: 'ADMIN', positionCode: 'MANAGER', permissions: grant('admin.users.manage') }),
  person(3, 'Белов Дмитрий', '3313', { role: 'ENGINEER_AUTO', positionCode: 'ENGINEER_AUTO', extraPositions: JSON.stringify(['MANAGER', 'ENGINEER_VENT']) }),
];

async function run() {
  const browser = await chromium.launch({ executablePath: process.env.FLUX_CHROME || '/usr/bin/chromium', args: ['--no-sandbox'] });
  try {
    const shot = process.env.SHOT;
    const errors: string[] = [];
    const open = async (as: string) => {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      page.on('pageerror', (e) => errors.push(e.stack || e.message));
      const writes: Array<{ method: string; url: string; body: any }> = [];
      await page.route('**/api/**', async (route) => {
        const url = route.request().url();
        const method = route.request().method();
        if (method !== 'GET') writes.push({ method, url: url.replace(/^.*\/api/, ''), body: route.request().postDataJSON?.() ?? null });
        if (url.includes('/api/departments')) return route.fulfill({ json: { rootId: 'root', unassigned: 4, departments: [{ id: 'root', name: 'Компания', kind: 'company', parentId: null, people: 0, total: 0, sortOrder: 0, archivedAt: null }] } });
        if (url.endsWith('/updates/devices')) return route.fulfill({ json: { inst: 'company', devices: [], releases: [] } });
        if (url.endsWith('/users') && method === 'GET') return route.fulfill({ json: people });
        if (url.endsWith('/users') && method === 'POST') return route.fulfill({ json: { id: 'new', symbol: 'x' } });
        if (/\/users\/[^/]+$/.test(url) && method === 'PUT') return route.fulfill({ json: { success: true } });
        if (url.endsWith('/roles') && method === 'GET') return route.fulfill({ json: { roles } });
        return route.fulfill({ json: [] });
      });
      await page.goto(`${BASE}/scripts/fixtures/positions-ui.html?as=${as}`);
      await page.locator('.fx-table').getByText('Раупов Хусрав', { exact: true }).waitFor({ timeout: 10000 }).catch(async (error) => {
        console.error('Страница:', (await page.locator('body').innerText()).slice(0, 400), 'Ошибки:', errors.join('; '));
        throw error;
      });
      return { page, writes };
    };
    const snap = async (page: import('playwright-core').Page, name: string) => {
      if (!shot) return;
      for (const dark of [false, true]) {
        await page.evaluate((d) => document.documentElement.classList.toggle('dark', d), dark);
        await page.waitForTimeout(400); // переход темы идёт долями секунды: без ожидания кадр получается блёклым
        await page.screenshot({ path: shot.replace(/\.png$/, `${name}${dark ? '-dark' : ''}.png`) });
      }
      await page.evaluate(() => document.documentElement.classList.remove('dark'));
    };

    // ── Владелец ──────────────────────────────────────────────────────────
    {
      const { page, writes } = await open('owner');
      check('Вкладки: Список, Подразделения, Должности, Обновления', (await page.getByRole('tab').allInnerTexts()).join('|') === 'Список|Подразделения|Должности|Обновления', await page.getByRole('tab').allInnerTexts());
      check('Колонка называется «Должность», слова «Роль» нет', await page.getByRole('columnheader', { name: 'Должность' }).count() === 1 && await page.getByRole('columnheader', { name: 'Роль', exact: true }).count() === 0);
      const rowOf = (name: string) => page.locator('.fx-table tbody tr', { hasText: name });
      check('У сотрудника с дополнительными — «+1» и основная должность', (await rowOf('Раупов').innerText()).includes('Инженер ОВиК') && (await rowOf('Раупов').innerText()).includes('+1'));
      check('Запись до разделения показывает должность из role', (await rowOf('Цыбуковский').innerText()).includes('Менеджер проектов'));
      check('Администратор: отметка уровня и его должность отдельно', (await rowOf('Иванова').innerText()).includes('Администратор') && (await rowOf('Иванова').innerText()).includes('Менеджер проектов'));
      check('Отметки «Администратор» нет у сотрудников', !(await rowOf('Раупов').innerText()).includes('Администратор'));
      await page.getByPlaceholder(/должность/).fill('КИПиА');
      check('Поиск находит и по дополнительной должности', await page.locator('.fx-table tbody tr').count() === 2, await page.locator('.fx-table tbody tr').count());
      await page.getByPlaceholder(/должность/).fill('');
      await page.getByRole('button', { name: 'По должности', exact: true }).click();
      const order = await page.locator('.fx-table tbody tr td:nth-child(2) .truncate').allInnerTexts();
      check('Порядок «По должности»: менеджеры выше инженеров', order.indexOf('Цыбуковский Антон') < order.indexOf('Раупов Хусрав') && order.indexOf('Иванова Мария') < order.indexOf('Белов Дмитрий'), order);
      await snap(page, '-list');

      // Вкладка «Должности»
      await page.getByRole('tab', { name: 'Должности' }).click();
      await page.getByRole('button', { name: 'Добавить должность' }).first().waitFor();
      const posRows = page.locator('.fx-table tbody tr');
      check('В справочнике четыре должности, строки уровня ADMIN нет', await posRows.count() === 4 && await page.getByText('Администратор', { exact: true }).count() === 0, await posRows.count());
      const vent = posRows.filter({ hasText: 'Инженер ОВиК' });
      const cells = await vent.locator('td').allInnerTexts();
      check('Инженер ОВиК: основная у 1 (а у записи с role — тоже), дополнительная у 1', cells[3].trim() === '1' && cells[4].trim() === '1', cells);
      check('Менеджер: основная у 2 (запись до разделения и администратор), дополнительная у 1', (await posRows.filter({ hasText: 'Менеджер проектов' }).locator('td').allInnerTexts())[3].trim() === '2');
      const cad = posRows.filter({ hasText: 'Конструктор' });
      await cad.hover();
      check('Свободную можно удалить', await cad.getByRole('button', { name: 'Удалить должность' }).isEnabled());
      await vent.hover();
      check('Назначенную нельзя — даже как дополнительную', await vent.getByRole('button', { name: /сначала переведите|Встроенную/ }).isDisabled());
      const maxRow = Math.max(...await posRows.evaluateAll((rows) => rows.map((r) => Math.round(r.getBoundingClientRect().height))));
      check(`Строки справочника не выше 40 px: ${maxRow}`, maxRow <= 40);
      check('Горизонтальной прокрутки нет', await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth && !Array.from(document.querySelectorAll('.fx-page-body')).some((el) => el.scrollWidth > el.clientWidth + 1)));
      await snap(page, '-positions');
      await cad.hover();
      await page.getByRole('button', { name: 'Изменить должность: Конструктор' }).click();
      await page.getByText('Что разрешено этой должности').waitFor();
      check('Права должности — строки с переключателем, административных нет', await page.locator('.fx-dialog .fx-set-row').count() > 10 && await page.getByText('Добавление сотрудников').count() === 0);
      await snap(page, '-position-card');
      await page.getByRole('button', { name: 'Отмена' }).click();

      // Карточка сотрудника
      await page.getByRole('tab', { name: 'Список' }).click();
      await page.locator('.fx-table tbody tr', { hasText: 'Раупов' }).dblclick();
      await page.getByText('Управление доступом').waitFor();
      check('Карточка: основная должность выбрана', await page.getByLabel('Основная должность').inputValue() === 'ENGINEER_VENT');
      const extras = page.getByRole('group', { name: 'Дополнительные должности' });
      check('Дополнительные: КИПиА включена, основная исключена из выбора', await extras.getByRole('button', { name: /Инженер КИПиА/ }).getAttribute('aria-pressed') === 'true' && await extras.getByRole('button', { name: /Инженер ОВиК/ }).count() === 0);
      check('Строки ADMIN в выборе должностей нет', await page.getByLabel('Основная должность').locator('option', { hasText: 'Администратор' }).count() === 0);
      check('Владелец видит уровень доступа; полномочий администратора пока нет', await page.getByRole('group', { name: 'Уровень доступа' }).isVisible() && await page.getByText('Добавление сотрудников').count() === 0);
      check('Право от дополнительной должности подсказано', await page.getByText('Выгрузка в E3.series').count() === 1);
      await snap(page, '-card');
      await page.getByRole('group', { name: 'Уровень доступа' }).getByRole('button', { name: 'Администратор' }).click();
      check('При «Администратор» появляются полномочия администратора', await page.getByText('Добавление сотрудников').count() === 1);
      await page.getByRole('group', { name: 'Уровень доступа' }).getByRole('button', { name: 'Сотрудник' }).click();
      await extras.getByRole('button', { name: /Менеджер/ }).click();
      await extras.getByRole('button', { name: /Инженер КИПиА/ }).click();
      await page.getByRole('button', { name: 'Сохранить' }).click();
      await page.getByText('Управление доступом').waitFor({ state: 'detached' });
      const put = writes.find((w) => w.method === 'PUT' && w.url === '/users/u0');
      check('Сохранение: основная, дополнительные и уровень уходят отдельными полями', !!put && put.body.positionCode === 'ENGINEER_VENT' && JSON.stringify(put.body.extraPositions) === JSON.stringify(['MANAGER']) && put.body.accessLevel === 'EMPLOYEE' && !('role' in put.body), put?.body);

      // Регистрация
      await page.getByRole('button', { name: 'Добавить сотрудника' }).click();
      await page.getByText('Регистрация сотрудника').waitFor();
      await page.getByPlaceholder('Раупов', { exact: true }).fill('Новиков'); await page.getByPlaceholder('Хусрав', { exact: true }).fill('Олег');
      await page.getByPlaceholder('Например, 4519').fill('7001'); await page.getByPlaceholder('Задайте надёжный пароль').fill('qwerty12');
      await page.getByRole('button', { name: 'Зарегистрировать' }).click();
      check('Без основной должности регистрация не уходит', await page.getByText('Выберите основную должность').count() === 1 && !writes.some((w) => w.method === 'POST' && w.url === '/users'));
      await snap(page, '-register');
      await page.getByLabel('Основная должность').selectOption('CAD');
      check('Основная исключается из дополнительных при выборе', await page.getByRole('group', { name: 'Дополнительные должности' }).getByRole('button', { name: /Конструктор/ }).count() === 0);
      await page.getByRole('group', { name: 'Дополнительные должности' }).getByRole('button', { name: /Менеджер/ }).click();
      await page.getByRole('button', { name: 'Зарегистрировать' }).click();
      await page.getByText('Регистрация сотрудника').waitFor({ state: 'detached' });
      const post = writes.find((w) => w.method === 'POST' && w.url === '/users');
      check('Регистрация: должности отдельными полями, без role', !!post && post.body.positionCode === 'CAD' && JSON.stringify(post.body.extraPositions) === JSON.stringify(['MANAGER']) && !('role' in post.body) && !('accessLevel' in post.body), post?.body);
      await page.close();
    }

    // ── Администратор с правом на справочник ──────────────────────────────
    {
      const { page } = await open('keeper');
      check('Вкладка «Должности» есть', await page.getByRole('tab', { name: 'Должности' }).count() === 1);
      await page.locator('.fx-table tbody tr', { hasText: 'Раупов' }).dblclick();
      await page.getByText('Управление доступом').waitFor();
      check('Уровня доступа в карточке нет — его видит только владелец', await page.getByRole('group', { name: 'Уровень доступа' }).count() === 0);
      check('Должности выбираются и ему', await page.getByLabel('Основная должность').isEnabled());
      await page.close();
    }

    // ── Администратор без права на справочник ─────────────────────────────
    {
      const { page } = await open('admin');
      check('Вкладки «Должности» нет', await page.getByRole('tab', { name: 'Должности' }).count() === 0);
      check('Администратора (Иванову) этот администратор открыть не может', await page.locator('.fx-table tbody tr', { hasText: 'Иванова' }).getByRole('button', { name: /Карточка сотрудника/ }).count() === 0);
      await page.close();
    }

    check(`Нет ошибок страницы: ${errors.join('; ')}`, errors.length === 0);
    console.log(`${checks} проверок должностей на экране пройдено, 0 провалено`);
  } finally { await browser.close(); }
}
void run().catch((error) => { console.error(error); process.exitCode = 1; });
