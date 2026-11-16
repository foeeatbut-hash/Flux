/**
 * Экран «Проекты» против настоящей службы: запись по устаревшей версии отклоняется, чужая правка цела,
 * набранное человеком не пропадает, удаление открытого у коллеги проекта не проходит (строка 3, часть B1).
 *
 * Поднимается настоящий server.ts на свободном порту с одноразовой базой; маршруты и подтверждения не
 * подменяются. Двое людей: Инженер (за экраном) и Иванов — его запросы идут прямо в службу, а в одном
 * сценарии Иванов сидит за настоящим вторым окном программы. Пока Инженер правит карточку проекта,
 * Иванов меняет тот же проект; событие «запись изменили» до экрана не доходит — карточка держит старую версию.
 *   1. Правка: служба отказывает по версии; на месте строки ошибки формы — текст службы и перечень
 *      «поле: было → стало» (сравнивается показанная ДО перечитывания запись с `current`); набранное цело,
 *      нетронутые поля обновились до записи Иванова, список перечитан; повтор уходит с новой версией и проходит.
 *   2. Проект уже удалили: правка не записана, окно с текстом службы.
 *   3. Удаление проекта, который успели изменить: окно с перечнем, проект цел; повтор проходит.
 *   4. Удаление проекта, открытого во втором окне: служба называет Иванова по имени, ничего не удалено;
 *      пока карточка открыта, в базе есть строка OpenRecord, когда окно закрыто или выбор снят — нет её.
 * Снимки отказов в обеих темах — в каталог FLUX_PROJECT_SHOTS (по умолчанию /tmp/b1-shots).
 *
 * Запуск: npx tsx scripts/test-project-version-ui.ts   (нужен браузер: FLUX_CHROME или /opt/pw-browsers)
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { findChromeOrUndefined } from './chromePath';

const require = createRequire(import.meta.url);
const SHOTS = process.env.FLUX_PROJECT_SHOTS || '/tmp/b1-shots';
let passed = 0;
const check = (label: string, condition: unknown, detail?: unknown) => {
  assert.ok(condition, `${label}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
  passed++; console.log(`✓ ${label}`);
};
const same = (label: string, actual: unknown, expected: unknown) => {
  assert.deepEqual(actual, expected, label);
  passed++; console.log(`✓ ${label}`);
};

async function main() {
  const chrome = findChromeOrUndefined();
  if (!chrome) { console.log('FLUX_VERIFY_SKIP: браузер не найден (задайте FLUX_CHROME) — набор интерфейса не запускался'); return; }
  const { chromium } = require('playwright-core');
  fs.mkdirSync(SHOTS, { recursive: true });

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-project-version-'));
  const allocator = net.createServer();
  await new Promise<void>((resolve) => allocator.listen(Number(process.env.FLUX_TEST_PORT) || 0, '127.0.0.1', resolve));
  const port = (allocator.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => allocator.close(() => resolve()));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    env: { ...process.env, VENT_APP_DATA: directory, PORT: String(port), DATABASE_URL: '', FLUX_EMBEDDED: '1', FLUX_LISTEN_HOST: '127.0.0.1', DISABLE_HMR: 'true', FLUX_TEST_LICENSE: '1', FLUX_TEST_LICENSE_AUTO: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { if (output.length < 100000) output += d; });
  child.stderr.on('data', (d) => { if (output.length < 100000) output += d; });
  let browser: any;
  let sql: any;
  try {
    const deadline = Date.now() + 180000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`Сервер завершился (${child.exitCode}): ${output.slice(-1500)}`);
      try { if ((await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) })).ok) break; } catch { /* ещё поднимается */ }
      if (Date.now() > deadline) throw new Error(`Сервер не поднялся: ${output.slice(-1500)}`);
      await new Promise((r) => setTimeout(r, 300));
    }

    // ── Данные: два человека, четыре проекта ──
    const Database = require('better-sqlite3');
    sql = new Database(path.join(directory, 'database.sqlite'));
    const password = 'disposable-live-password';
    const salt = crypto.randomBytes(16);
    const hash = `scrypt$${salt.toString('hex')}$${crypto.scryptSync(password, salt, 64).toString('hex')}`;
    const addUser = sql.prepare('INSERT INTO "User" (id, symbol, name, password, role, permissions) VALUES (?, ?, ?, ?, ?, ?)');
    addUser.run('pr-admin', 'pr-admin', 'Инженер', hash, 'ADMIN', '{}');
    addUser.run('pr-ivanov', 'pr-ivanov', 'Иванов И. И.', hash, 'ADMIN', '{}');
    const addProject = sql.prepare('INSERT INTO "Project" (id, name, code, customer, contractor, description, info, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    addProject.run('pr-school', 'Школа №5', 'SCH-5', 'Управление образования', 'СтройМонтаж', 'Новая школа', 'Адрес площадки', 'ACTIVE');
    addProject.run('pr-depot', 'Депо', 'DEP-1', 'Транспортное управление', 'ТрансСтрой', 'Ремонтное депо', '', 'ACTIVE');
    addProject.run('pr-store', 'Склад Б', 'STR-2', 'Логистика', 'СкладСтрой', 'Склад готовой продукции', '', 'ACTIVE');
    addProject.run('pr-bridge', 'Мост', 'BRG-3', 'Дорожное управление', 'МостДор', 'Мост через реку', '', 'ACTIVE');

    // ── Люди: настоящие запросы в службу ──
    const loginAs = async (symbol: string) => {
      const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol, password }) });
      assert.equal(login.status, 200, `вход ${symbol}`);
      const token = ((await login.json()) as any).token as string;
      return async (method: string, url: string, body?: unknown) => {
        const r = await fetch(`${base}${url}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
      };
    };
    const admin = await loginAs('pr-admin');
    const ivanov = await loginAs('pr-ivanov');
    const rowsOf = (userId: string) => (sql.prepare('SELECT model, recordId FROM "OpenRecord" WHERE userId = ? ORDER BY model, recordId').all(userId) as any[]).map((r) => `${r.model}:${r.recordId}`);
    const waitRows = async (userId: string, expected: string[], what: string) => {
      const until = Date.now() + 12000; let got: string[] = [];
      while (Date.now() < until) { got = rowsOf(userId); if (JSON.stringify(got) === JSON.stringify(expected)) break; await new Promise((r) => setTimeout(r, 200)); }
      check(what, JSON.stringify(got) === JSON.stringify(expected), { expected, got });
    };
    const projectRow = (id: string) => sql.prepare('SELECT * FROM "Project" WHERE id = ?').get(id) as any;

    // ── Браузер: окно Инженера ──
    browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
    const signIn = async (symbol: string) => {
      const p = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      p.on('pageerror', (e: Error) => pageErrors.push(`${symbol}: ${e.message}`));
      // Событие «запись изменили» до экрана не доходит — как при обрыве связи: карточка держит старую версию
      await p.addInitScript(() => {
        window.addEventListener('socket:entity:changed', (e) => { e.stopImmediatePropagation(); }, true);
      });
      await p.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
      await p.waitForSelector('input', { timeout: 90000 });
      const inputs = await p.$$('input');
      await inputs[0].fill(symbol); await inputs[1].fill(password); await p.keyboard.press('Enter');
      await p.waitForSelector('[data-taskbar]', { timeout: 60000 });
      await p.goto(`${base}/#/projects`);
      await p.reload();
      await p.waitForSelector('[data-share-focus^="project:"]', { timeout: 30000 });
      return p;
    };
    const pageErrors: string[] = [];
    const page = await signIn('pr-admin');
    // Записи правки с их версией: по ним видно, что повтор ушёл с новой версией
    const putBodies: any[] = [];
    page.on('request', (r: any) => { if (r.method() === 'PUT' && /\/api\/projects\/[^/]+$/.test(r.url())) putBodies.push({ url: r.url(), body: JSON.parse(r.postData() || '{}') }); });
    const deleteUrls: string[] = [];
    page.on('request', (r: any) => { if (r.method() === 'DELETE' && /\/api\/projects\/[^/]+/.test(r.url())) deleteUrls.push(r.url()); });

    const shot = async (name: string) => {
      for (const dark of [false, true]) {
        await page.evaluate((v: boolean) => { document.documentElement.classList.toggle('dark', v); document.documentElement.classList.remove('flux-glass'); }, dark);
        await page.waitForTimeout(250);
        await page.screenshot({ path: path.join(SHOTS, `${name}-${dark ? 'dark' : 'light'}.png`), animations: 'disabled' });
      }
      await page.evaluate(() => document.documentElement.classList.remove('dark'));
    };
    const changesOf = (root: any) => root.locator('[data-conflict-change]').evaluateAll((els: Element[]) => els.map((el) => ({
      label: el.querySelector('.fx-conflict-field')!.textContent!.replace(/:$/, ''),
      was: el.querySelector('.fx-conflict-was')!.textContent,
      now: el.querySelector('.fx-conflict-now')!.textContent,
    })));
    const field = (p: any, label: string) => p.locator(`div:has(> label:text-is("${label}")) > :is(input,textarea,select)`);
    const listItem = (p: any, id: string) => p.locator(`[data-share-focus="project:${id}"]`);
    const openProject = async (p: any, id: string, title: string) => {
      await listItem(p, id).click();
      await p.locator('h2', { hasText: title }).first().waitFor({ timeout: 15000 });
    };
    /** Дождаться, пока экран перечитает список после отказа: повтор должен идти с новой версией */
    const rereadOf = async (action: () => Promise<void>) => {
      const reread = page.waitForResponse((r: any) => /\/api\/projects$/.test(r.url()) && r.request().method() === 'GET', { timeout: 15000 });
      await action(); await reread; await page.waitForTimeout(400);
    };
    const save = () => page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    const confirmDelete = async () => page.getByRole('button', { name: 'Удалить проект', exact: true }).last().click();
    const deleteSelected = async () => {
      await page.getByRole('button', { name: 'Удалить проект', exact: true }).first().click();
      await confirmDelete();
    };

    // ── 1. Правка проекта, который изменил Иванов ──
    console.log('1. Правка: проект изменили, пока карточка была открыта');
    await openProject(page, 'pr-school', 'Школа №5');
    await waitRows('pr-admin', ['Project:pr-school'], 'карточка проекта открыта — в базе строка OpenRecord этого человека');
    check('отметка свежая и одна', (sql.prepare('SELECT COUNT(*) AS n FROM "OpenRecord" WHERE userId = ? AND at >= ?').get('pr-admin', Date.now() - 30000) as any).n === 1);
    check('служба отдаёт версию проекта', projectRow('pr-school').version === 1, projectRow('pr-school').version);
    const colleague = await ivanov('PUT', '/api/projects/pr-school', { name: 'Школа №7', customer: 'Мэрия', status: 'ARCHIVED', expectedVersion: 1 });
    check('Иванов изменил название, заказчика и состояние того же проекта', colleague.status === 200 && colleague.body.project.version === 2, colleague);
    const staleText = (await admin('PUT', '/api/projects/pr-school', { name: 'пробный', expectedVersion: 1 })).body.error as string;
    check('для сверки: служба отказывает по версии и называет проект', typeof staleText === 'string' && staleText.length > 10, staleText);
    check('пробная правка ничего не записала', projectRow('pr-school').name === 'Школа №7' && projectRow('pr-school').version === 2);

    await field(page, 'Наименование').fill('Школа №5А');
    await field(page, 'Подрядчик').fill('СтройМонтаж-2');
    await rereadOf(() => save());
    const notice = page.locator('[data-conflict-notice]');
    await notice.waitFor({ timeout: 15000 });
    check('в карточке виден текст отказа службы', (await notice.locator('[data-conflict-message]').textContent()) === staleText, await notice.textContent());
    same('виден перечень: название, заказчик и состояние — как они были на экране и как стали',
      await changesOf(notice), [
        { label: 'Наименование', was: 'Школа №5', now: 'Школа №7' },
        { label: 'Заказчик', was: 'Управление образования', now: 'Мэрия' },
        { label: 'Статус проекта', was: 'В работе', now: 'Архив' },
      ]);
    check('перечень читается и без стилей: «было» и «стало» названы словами', (await notice.locator('[data-conflict-change]').first().textContent()) === 'Наименование: было Школа №5 → стало Школа №7', await notice.locator('[data-conflict-change]').first().textContent());
    check('отказ — role="alert", а не всплывающая строка', await notice.getAttribute('role') === 'alert' && await page.locator('[data-refusal-dialog]').count() === 0);
    check('набранное цело: название и подрядчик человека остались в полях', (await field(page, 'Наименование').inputValue()) === 'Школа №5А' && (await field(page, 'Подрядчик').inputValue()) === 'СтройМонтаж-2');
    check('нетронутые поля обновились до записи Иванова: повтор не вернёт прежнее', (await field(page, 'Заказчик').inputValue()) === 'Мэрия' && (await field(page, 'Статус проекта').inputValue()) === 'ARCHIVED');
    check('список перечитан: слева название Иванова', (await listItem(page, 'pr-school').textContent())!.includes('Школа №7'));
    check('чужая правка цела, своя не записана', projectRow('pr-school').name === 'Школа №7' && projectRow('pr-school').contractor === 'СтройМонтаж' && projectRow('pr-school').version === 2, projectRow('pr-school'));
    const box = await notice.locator('.fx-conflict-now').first().evaluate((el: HTMLElement) => { const r = el.getBoundingClientRect(); const c = getComputedStyle(el); const p = el.closest('[data-conflict-notice]')!.getBoundingClientRect(); return { fontSize: c.fontSize, inside: r.left >= p.left && r.right <= p.right && r.bottom <= p.bottom }; });
    check('отказ читается: кегль не мельче 12 px, помещается в рамке', parseFloat(box.fontSize) >= 12 && box.inside, box);
    await shot('save-conflict');
    check('первая отправка ушла с версией 1', putBodies.at(-1)?.body.expectedVersion === 1, putBodies.at(-1));
    await save();
    await notice.waitFor({ state: 'detached', timeout: 15000 });
    await page.getByText('Данные проекта успешно сохранены').first().waitFor({ timeout: 15000 });
    const retried = projectRow('pr-school');
    check('повтор ушёл с новой версией 2 и прошёл', putBodies.at(-1)?.body.expectedVersion === 2 && retried.version === 3, { sent: putBodies.at(-1)?.body.expectedVersion, version: retried.version });
    check('записано набранное человеком, а правка Иванова в других полях не затёрта', retried.name === 'Школа №5А' && retried.contractor === 'СтройМонтаж-2' && retried.customer === 'Мэрия' && retried.status === 'ARCHIVED', retried);
    check('без чужой правки сохранение проходит сразу, без отказа', await page.locator('[data-conflict-notice]').count() === 0);

    // ── 2. Проект уже удалили ──
    console.log('2. Правка: проект уже удалили');
    await openProject(page, 'pr-depot', 'Депо');
    // Через службу удалить не получится: карточка открыта у Инженера, и служба откажет Иванову. Проект исчезает «снизу»
    // (удалён с другого сервера общей базы), поэтому строка снимается из таблицы напрямую
    sql.prepare('DELETE FROM "Project" WHERE id = ?').run('pr-depot');
    check('проекта в базе нет', !projectRow('pr-depot'));
    const goneText = (await admin('PUT', '/api/projects/pr-depot', { name: 'пробный' })).body;
    check('для сверки: служба отвечает «уже удалили» с кодом', goneText.code === 'RECORD_GONE' && typeof goneText.error === 'string', goneText);
    await field(page, 'Наименование').fill('Депо-2');
    await rereadOf(() => save());
    const goneDialog = page.locator('[data-refusal-dialog]');
    await goneDialog.waitFor({ timeout: 15000 });
    check('окно с текстом службы, а не выдуманным', (await goneDialog.locator('[data-conflict-message]').textContent()) === goneText.error, await goneDialog.textContent());
    check('перечня нет: запись не менялась, она исчезла', await goneDialog.locator('[data-conflict-change]').count() === 0 && await goneDialog.locator('[data-conflict-empty]').count() === 0);
    await shot('save-gone');
    await page.getByRole('button', { name: 'Понятно' }).click();
    check('окно закрывается кнопкой', await page.locator('[data-refusal-dialog]').count() === 0);
    check('проект исчез из списка после перечитывания', await listItem(page, 'pr-depot').count() === 0);
    check('ничего не записано', !projectRow('pr-depot'));

    // ── 3. Удаление проекта, который успели изменить ──
    console.log('3. Удаление: проект изменили');
    await openProject(page, 'pr-store', 'Склад Б');
    const storeEdit = await ivanov('PUT', '/api/projects/pr-store', { description: 'Склад комплектующих', expectedVersion: 1 });
    check('Иванов поправил краткое описание проекта, который сейчас удалят', storeEdit.status === 200, storeEdit);
    const staleDelete = await admin('DELETE', '/api/projects/pr-store?expectedVersion=1');
    check('для сверки: служба отказывает по версии и ничего не удаляет', staleDelete.status === 409 && staleDelete.body.code === 'VERSION_CONFLICT' && !!projectRow('pr-store'), staleDelete.body);
    await rereadOf(() => deleteSelected());
    const deleteDialog = page.locator('[data-refusal-dialog]');
    await deleteDialog.waitFor({ timeout: 15000 });
    check('текст службы — окном, а не всплывающей строкой', (await deleteDialog.locator('[data-conflict-message]').textContent()) === staleDelete.body.error, await deleteDialog.textContent());
    same('виден перечень: краткое описание', await changesOf(deleteDialog), [{ label: 'Краткое описание', was: 'Склад готовой продукции', now: 'Склад комплектующих' }]);
    check('удаление ушло с версией 1 в строке запроса', deleteUrls.some((u) => u.endsWith('/api/projects/pr-store?expectedVersion=1')), deleteUrls);
    await shot('delete-conflict');
    await page.getByRole('button', { name: 'Понятно' }).click();
    check('проект цел, правка Иванова цела', !!projectRow('pr-store') && projectRow('pr-store').description === 'Склад комплектующих');
    check('проект остался в списке', await listItem(page, 'pr-store').count() === 1);
    check('карточка без набранного показывает запись Иванова: «Сохранить» её не затрёт', (await field(page, 'Краткое описание').inputValue()) === 'Склад комплектующих');
    await deleteSelected();
    await page.getByText('Проект "Склад Б" удален', { exact: false }).first().waitFor({ timeout: 15000 });
    check('повтор с новой версией удаляет проект', !projectRow('pr-store') && deleteUrls.at(-1)!.endsWith('/api/projects/pr-store?expectedVersion=2'), deleteUrls.at(-1));

    // ── 4. Проект открыт у Иванова за настоящим вторым окном ──
    console.log('4. Удаление: проект открыт у коллеги');
    const second = await signIn('pr-ivanov');
    await listItem(second, 'pr-bridge').click();
    await second.locator('h2', { hasText: 'Мост' }).first().waitFor({ timeout: 15000 });
    await waitRows('pr-ivanov', ['Project:pr-bridge'], 'во втором окне открыта карточка «Моста» — отметка Иванова в базе');
    await openProject(page, 'pr-bridge', 'Мост');
    await deleteSelected();
    const openDialog = page.locator('[data-refusal-dialog]');
    await openDialog.waitFor({ timeout: 15000 });
    const openText = (await openDialog.locator('[data-conflict-message]').textContent())!;
    check('служба назвала Иванова по имени и проект по названию', openText.includes('Иванов И. И.') && openText.includes('Мост'), openText);
    check('это текст службы: те же слова приходят на тот же запрос', openText === (await admin('DELETE', '/api/projects/pr-bridge')).body.error);
    check('перечня изменений нет: запись не менялась', await openDialog.locator('[data-conflict-change]').count() === 0 && await openDialog.locator('[data-conflict-empty]').count() === 0);
    check('проект не удалён', !!projectRow('pr-bridge'));
    await shot('delete-open-by-colleague');
    await page.getByRole('button', { name: 'Понятно' }).click();
    // Иванов уходит с карточки: выбирает другой проект — его отметка снимается
    await listItem(second, 'pr-school').click();
    await second.locator('h2', { hasText: 'Школа №5А' }).first().waitFor({ timeout: 15000 });
    await waitRows('pr-ivanov', ['Project:pr-school'], 'Иванов выбрал другой проект — отметка у «Моста» снята');
    await deleteSelected();
    await page.getByText('Проект "Мост" удален', { exact: false }).first().waitFor({ timeout: 15000 });
    check('Иванов отпустил проект — «Мост» удаляется; свои отметки Инженеру не мешали', !projectRow('pr-bridge'));
    await waitRows('pr-admin', ['Project:pr-school'], 'после удаления карточка снова у первого проекта — отметка у него, у удалённого её нет');

    // ── 5. Закрытие окна ──
    console.log('5. Закрытие окна');
    await page.goto('about:blank');
    await waitRows('pr-admin', [], 'окно закрыто — отметок нет (маяк при закрытии)');

    check('ошибок страницы нет', pageErrors.length === 0, pageErrors);
    console.log(`Снимки: ${SHOTS}`);
  } finally {
    await browser?.close().catch(() => {});
    try { sql?.close(); } catch { /* уже закрыта */ }
    if (child.exitCode === null && !child.signalCode) { const exited = once(child, 'exit'); child.kill(); const timer = setTimeout(() => child.kill('SIGKILL'), 3000); await exited; clearTimeout(timer); }
    fs.rmSync(directory, { recursive: true, force: true });
  }
  console.log(`project-version-ui: ${passed} проверок прошли`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
