/**
 * Экран «Справочник» против настоящей службы: запись по устаревшей версии пункта отклоняется,
 * чужая правка цела, набранное человеком не пропадает (проекты и справочники, B2).
 *
 * Поднимается настоящий server.ts на свободном порту с одноразовой базой; маршруты не подменяются.
 * Экран открыт; пока человек правит, «коллега» (второй вход) пишет тот же пункт вторым запросом;
 * экран об этом не знает (справочник сам не слушает события) — держит старую версию. Проверяется:
 *   1. Таблица справочника: правка пункта по устаревшей версии — отказ над таблицей с перечнем
 *      «было → стало», строка правки открыта и набранное в ней цело, чужая правка в базе цела,
 *      версия ушла в запросе; повтор после отказа проходит; у экрана в базе есть строка OpenRecord,
 *      пока пункт правят, и нет её после.
 *   2. Удаление: пункт открыт у коллеги — окно называет его по имени; пункт изменён — окно с
 *      перечнем; пункт уже удалён — отказ «уже удалили» и список перечитан; везде версия
 *      в запросе (`expectedVersion`), пункт в базе цел.
 *   3. Создание в справочнике, которого уже нет: окно с текстом сервера, список перечитан.
 *   4. «Дополнительные параметры»: переименование категории, перестановка двух категорий (второй
 *      запрос отказан — отказ показан, справочник перечитан), удаление категории, у которой открыт
 *      вариант у коллеги.
 *   5. «Маркировка» и «Пресеты подбора»: переименование по устаревшей версии.
 * Снимки отказов в обеих темах — в каталог FLUX_DICT_SHOTS (по умолчанию /tmp/b2-shots).
 *
 * Запуск: npx tsx scripts/test-dict-version-ui.ts   (нужен браузер: FLUX_CHROME или /opt/pw-browsers)
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { findChromeOrUndefined } from './chromePath';

const require = createRequire(import.meta.url);
const SHOTS = process.env.FLUX_DICT_SHOTS || '/tmp/b2-shots';
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

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-dict-version-'));
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

    // ── Данные: один проект, два человека ──
    const Database = require('better-sqlite3');
    sql = new Database(path.join(directory, 'database.sqlite'));
    const password = 'disposable-live-password';
    const salt = crypto.randomBytes(16);
    const hash = `scrypt$${salt.toString('hex')}$${crypto.scryptSync(password, salt, 64).toString('hex')}`;
    const user = sql.prepare('INSERT INTO "User" (id, symbol, name, password, role, permissions) VALUES (?, ?, ?, ?, ?, ?)');
    user.run('dv-admin', 'dv-admin', 'Инженер', hash, 'ADMIN', '{}');
    user.run('dv-ivanov', 'dv-ivanov', 'Иванов И. И.', hash, 'ADMIN', '{}');
    sql.prepare('INSERT INTO "Project" (id, name) VALUES (?, ?)').run('dv-p', 'Проект справочников');
    sql.prepare('INSERT INTO "ProjectMember" (id, projectId, userId) VALUES (?, ?, ?)').run('dv-m1', 'dv-p', 'dv-admin');
    sql.prepare('INSERT INTO "ProjectMember" (id, projectId, userId) VALUES (?, ?, ?)').run('dv-m2', 'dv-p', 'dv-ivanov');

    const loginAs = async (symbol: string) => {
      const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol, password }) });
      assert.equal(login.status, 200, `вход ${symbol}`);
      const token = ((await login.json()) as any).token as string;
      return async (method: string, url: string, body?: unknown) => {
        const r = await fetch(`${base}${url}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
      };
    };
    const colleague = await loginAs('dv-admin');
    const ivanov = await loginAs('dv-ivanov');
    const holdOpen = (records: Array<{ model: string; id: string }>) => ivanov('PUT', '/api/open-records', { holderKey: 'ivanov-window-1', records });

    const make = async (name: string, items: Array<{ code: string; nameRu: string }>) => {
      const r = await colleague('POST', '/api/projects/dv-p/dictionaries', { name, items });
      assert.equal(r.status, 200, `справочник ${name}: ${JSON.stringify(r.body)}`);
      return r.body.dictionary as { id: string; items: any[] };
    };
    const addItem = async (dictId: string, code: string, nameRu: string, parentId: string | null) => {
      const r = await colleague('POST', `/api/projects/dv-p/dictionaries/${dictId}/items`, { code, nameRu, parentId });
      assert.equal(r.status, 200, `пункт ${nameRu}: ${JSON.stringify(r.body)}`);
      return r.body.item;
    };
    const tagCfg = await make('__tag_creation_config__', [{ code: '001_k', nameRu: 'Класс' }, { code: '002_s', nameRu: 'Среда' }]);
    const catClass = tagCfg.items.find((i) => i.nameRu === 'Класс');
    const catEnv = tagCfg.items.find((i) => i.nameRu === 'Среда');
    const optKip = await addItem(tagCfg.id, 'КИП', 'КИП', catClass.id);
    const markCfg = await make('__tag_marking_config__', [{ code: '001_m1', nameRu: 'Тип оборудования' }, { code: '002_m2', nameRu: 'Блок' }]);
    const markBlock = markCfg.items.find((i) => i.nameRu === 'Блок');
    const presetCfg = await make('__tag_presets_config__', [{ code: '3700', nameRu: 'Проект 3700' }]);
    const preset = presetCfg.items[0];
    const materials = await make('Материалы', [{ code: 'M1', nameRu: 'Сталь' }, { code: 'M2', nameRu: 'Медь' }, { code: 'M3', nameRu: 'Алюминий' }, { code: 'M4', nameRu: 'Латунь' }]);
    const mat = (code: string) => materials.items.find((i) => i.code === code);
    const temp = await make('Временный', [{ code: 'T1', nameRu: 'Первый' }]);

    const dictNow = async () => (await colleague('GET', '/api/projects/dv-p/dictionaries')).body.dictionaries as any[];
    const itemNow = async (id: string) => { for (const d of await dictNow()) { const i = d.items.find((x: any) => x.id === id); if (i) return i; } return undefined; };
    const openRows = (userId = 'dv-admin') => (sql.prepare('SELECT model, recordId FROM "OpenRecord" WHERE userId = ? ORDER BY model, recordId').all(userId) as any[]).map((r) => `${r.model}:${r.recordId}`);
    const waitRows = async (expected: string[], what: string) => {
      const until = Date.now() + 12000; let got: string[] = [];
      while (Date.now() < until) { got = openRows(); if (JSON.stringify(got) === JSON.stringify([...expected].sort())) break; await new Promise((r) => setTimeout(r, 200)); }
      check(what, JSON.stringify(got) === JSON.stringify([...expected].sort()), { expected, got });
    };
    /** Коллега правит пункт целой записью: версия у него свежая */
    const colleagueEdits = async (id: string, patch: Record<string, unknown>) => {
      const cur = await itemNow(id);
      const r = await colleague('PUT', `/api/dictionaries/items/${id}`, { code: cur.code, nameRu: cur.nameRu, parentId: cur.parentId, ...patch, expectedVersion: cur.version });
      assert.equal(r.status, 200, `правка коллеги: ${JSON.stringify(r.body)}`);
    };

    // ── Браузер и экран ──
    browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const pageErrors: string[] = [];
    page.on('pageerror', (e: Error) => pageErrors.push(e.message));
    const requests: Array<{ method: string; url: string; body: string }> = [];
    page.on('request', (r: any) => { if (/\/api\/(dictionaries\/items|projects\/[^/]+\/dictionaries\/[^/]+\/items)/.test(r.url()) && r.method() !== 'GET') requests.push({ method: r.method(), url: r.url().replace(base, ''), body: r.postData() || '' }); });
    await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('input', { timeout: 90000 });
    const inputs = await page.$$('input');
    await inputs[0].fill('dv-admin'); await inputs[1].fill(password); await page.keyboard.press('Enter');
    await page.waitForSelector('[data-taskbar]', { timeout: 60000 });
    await page.evaluate(() => localStorage.setItem('max_active_project_dv-admin', JSON.stringify({ id: 'dv-p', name: 'Проект справочников' })));
    await page.goto(`${base}/#/directory`);
    await page.reload();
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
    /** Отказ читается: кегль не мельче 12 px, помещается в окно браузера (светлая и тёмная тема) */
    const readable = async (root: any, what: string) => {
      for (const dark of [false, true]) {
        await page.evaluate((v: boolean) => document.documentElement.classList.toggle('dark', v), dark);
        const m = await root.locator('.fx-conflict-message').evaluate((n: HTMLElement) => { const r = n.getBoundingClientRect(); return { fontSize: parseFloat(getComputedStyle(n).fontSize), inside: r.left >= 0 && r.right <= window.innerWidth && r.width > 80 }; });
        check(`${what}: кегль не мельче 12 px и помещается (${dark ? 'тёмная' : 'светлая'} тема)`, m.fontSize >= 12 && m.inside, m);
      }
      await page.evaluate(() => document.documentElement.classList.remove('dark'));
    };
    const banner = page.locator('[data-dict-refusal]');
    const windowed = page.locator('[data-refusal-dialog]');
    const confirmDelete = (label = 'Удалить') => page.getByRole('dialog').getByRole('button', { name: label, exact: true }).click();
    const goTo = async (label: string) => { await page.locator('nav[aria-label="Справочники"]').getByRole('button', { name: label }).click(); };
    const lastRequest = (method: string) => [...requests].reverse().find((r) => r.method === method);

    // ── 1. Таблица справочника ──
    console.log('1. Таблица справочника');
    await goTo('Материалы');
    const row = (code: string) => page.locator('tbody tr', { hasText: code });
    await row('M1').waitFor({ timeout: 60000 });
    await row('M1').hover();
    await row('M1').locator('td:last-child button').nth(0).click();
    const editing = page.locator('tbody tr:has(input)');
    await editing.waitFor();
    await waitRows([`DictionaryItem:${mat('M1').id}`], 'пункт правят — в базе строка OpenRecord этого человека');
    await colleagueEdits(mat('M1').id, { nameRu: 'Нержавейка' });
    const nameInput = editing.locator('input').nth(1);
    await nameInput.fill('Моя сталь');
    requests.length = 0;
    await editing.locator('td:last-child button').nth(0).click();
    await banner.waitFor({ timeout: 15000 });
    const noticeText = (await banner.locator('[data-conflict-message]').textContent())!;
    check('отказ — role="alert", над таблицей, не окном', await banner.locator('[data-conflict-notice]').getAttribute('role') === 'alert' && await windowed.count() === 0);
    check('текст сервера: пункт изменили, правка не записана', /изменили/.test(noticeText) && /не записана/.test(noticeText), noticeText);
    same('перечень: название было «Сталь», стало «Нержавейка»', await changesOf(banner), [{ label: 'Название', was: 'Сталь', now: 'Нержавейка' }]);
    const put = lastRequest('PUT');
    check('экран отправил PUT с версией, которую видел', put?.url === `/api/dictionaries/items/${mat('M1').id}` && JSON.parse(put!.body).expectedVersion === mat('M1').version, put);
    await page.waitForTimeout(800); // сброс набранного шёл бы уже после показа отказа
    check('строка правки открыта, набранное в поле цело', await editing.count() === 1 && await nameInput.inputValue() === 'Моя сталь');
    check('чужая правка цела, своя не записана', (await itemNow(mat('M1').id)).nameRu === 'Нержавейка');
    await readable(banner, 'отказ правки');
    await shot('table-refusal');
    await editing.locator('td:last-child button').nth(0).click(); // повтор: версия уже свежая
    const retryUntil = Date.now() + 15000;
    while (Date.now() < retryUntil && (await itemNow(mat('M1').id)).nameRu !== 'Моя сталь') await page.waitForTimeout(250);
    check('повтор тем же набранным проходит: имя человека записано', (await itemNow(mat('M1').id)).nameRu === 'Моя сталь');
    check('отказ снят, строка правки закрыта', await banner.count() === 0 && await page.locator('tbody tr:has(input)').count() === 0);
    await waitRows([], 'правка закончена — строки OpenRecord этого человека нет');

    // ── 2. Удаление ──
    console.log('2. Удаление');
    // 2а. Пункт открыт у коллеги
    check('Иванов держит «Медь» открытой', (await holdOpen([{ model: 'DictionaryItem', id: mat('M2').id }])).status === 200);
    await row('M2').hover();
    await row('M2').locator('td:last-child button').nth(1).click();
    requests.length = 0;
    await confirmDelete();
    await windowed.waitFor({ timeout: 15000 });
    const openText = (await windowed.textContent())!;
    check('окно называет коллегу по имени и говорит, что удалить нельзя', openText.includes('Иванов И. И.') && /открыт/.test(openText) && /нельзя/.test(openText), openText);
    const del = lastRequest('DELETE');
    check('экран отправил DELETE с целой версией записи', del?.url === `/api/dictionaries/items/${mat('M2').id}?expectedVersion=${(await itemNow(mat('M2').id)).version}`, del);
    check('пункт цел в базе и на экране', !!(await itemNow(mat('M2').id)) && await row('M2').count() === 1);
    await shot('delete-open-refusal');
    await page.getByRole('button', { name: 'Понятно' }).click();
    await holdOpen([]);

    // 2б. Пункт изменили, пока экран держал старую копию
    await colleagueEdits(mat('M3').id, { nameRu: 'Дюраль' });
    await row('M3').hover();
    await row('M3').locator('td:last-child button').nth(1).click();
    await confirmDelete();
    await windowed.waitFor({ timeout: 15000 });
    same('окно показывает перечень: «Алюминий» → «Дюраль»', await changesOf(windowed), [{ label: 'Название', was: 'Алюминий', now: 'Дюраль' }]);
    check('пункт не удалён', !!(await itemNow(mat('M3').id)));
    await readable(windowed, 'отказ удаления');
    await shot('delete-changed-refusal');
    await page.getByRole('button', { name: 'Понятно' }).click();
    await page.getByText('Дюраль').first().waitFor({ timeout: 15000 });
    check('справочник перечитан: на экране название коллеги', await row('M3').count() === 1);
    // повтор по свежей версии — удаляет
    await row('M3').hover();
    await row('M3').locator('td:last-child button').nth(1).click();
    await confirmDelete();
    const goneUntil = Date.now() + 15000;
    while (Date.now() < goneUntil && await itemNow(mat('M3').id)) await page.waitForTimeout(250);
    check('повтор по свежей версии удаляет пункт', !(await itemNow(mat('M3').id)) && await windowed.count() === 0);

    // 2в. Пункт уже удалили, пока правили
    await row('M4').hover();
    await row('M4').locator('td:last-child button').nth(0).click();
    await editing.waitFor();
    const m4 = await itemNow(mat('M4').id);
    check('коллега удалил «Латунь»', (await colleague('DELETE', `/api/dictionaries/items/${m4.id}?expectedVersion=${m4.version}`)).status === 200);
    await editing.locator('input').nth(1).fill('Бронза');
    await editing.locator('td:last-child button').nth(0).click();
    await banner.waitFor({ timeout: 15000 });
    check('отказ говорит, что пункт уже удалили', /удалили/.test((await banner.locator('[data-conflict-message]').textContent())!));
    const reread = Date.now() + 15000;
    while (Date.now() < reread && await row('M4').count() + await page.locator('tbody tr:has(input)').count() > 0) await page.waitForTimeout(250);
    check('справочник перечитан: «Латуни» на экране нет', await page.getByText('Латунь').count() === 0);
    await page.getByRole('button', { name: 'Понятно' }).click();

    // ── 3. Создание в справочнике, которого уже нет ──
    console.log('3. Создание в исчезнувшем справочнике');
    await page.reload();
    await goTo('Временный');
    await page.getByRole('button', { name: 'Добавить запись' }).click();
    sql.prepare('DELETE FROM "DictionaryItem" WHERE dictionaryId = ?').run(temp.id);
    sql.prepare('DELETE FROM "Dictionary" WHERE id = ?').run(temp.id);
    await page.getByPlaceholder('Код...').fill('T9');
    await page.getByTitle('Сохранить значение').click();
    await windowed.waitFor({ timeout: 15000 });
    check('окно с текстом сервера: справочник уже удалили, запись не создана', /уже удалили/.test((await windowed.textContent())!) && /не создана/.test((await windowed.textContent())!), await windowed.textContent());
    await page.getByRole('button', { name: 'Понятно' }).click();
    await page.locator('nav[aria-label="Справочники"]').getByRole('button', { name: 'Временный' }).waitFor({ state: 'detached', timeout: 15000 });
    check('справочник перечитан: «Временный» в списке нет', true);

    // ── 4. «Дополнительные параметры» ──
    console.log('4. Дополнительные параметры');
    await goTo('Доп. параметры');
    const card = (name: string) => page.locator('div.cursor-pointer', { hasText: name }).first();
    const renaming = page.locator('div.cursor-pointer:has(input[type=text])');
    await card('Класс').waitFor({ timeout: 30000 });
    await card('Класс').getByTitle('Переименовать').click();
    await waitRows([`DictionaryItem:${catClass.id}`], 'категорию переименовывают — в базе строка OpenRecord');
    await colleagueEdits(catClass.id, { nameRu: 'Класс надёжности' });
    const renameInput = renaming.locator('input[type=text]');
    await renameInput.fill('Мой класс');
    requests.length = 0;
    await renaming.locator('button').nth(0).click();
    await banner.waitFor({ timeout: 15000 });
    same('перечень: «Класс» → «Класс надёжности» (служебный код не показан)', await changesOf(banner), [{ label: 'Название', was: 'Класс', now: 'Класс надёжности' }]);
    check('PUT категории ушёл с версией', JSON.parse(lastRequest('PUT')!.body).expectedVersion === catClass.version);
    await page.waitForTimeout(800);
    check('строка переименования открыта, набранное цело', await renameInput.count() === 1 && await renameInput.inputValue() === 'Мой класс');
    check('чужое название цело', (await itemNow(catClass.id)).nameRu === 'Класс надёжности');
    await readable(banner, 'отказ переименования');
    await shot('tag-rename-refusal');
    await renaming.locator('button').nth(1).click();
    await waitRows([], 'переименование отменено — строки OpenRecord нет');
    await page.getByRole('button', { name: 'Понятно' }).click();

    // 4б. Перестановка: первый запрос принят, второй отказан
    await colleagueEdits(catEnv.id, { nameRu: 'Среда обитания' });
    requests.length = 0;
    await card('Класс').getByTitle('Вниз').click();
    await banner.waitFor({ timeout: 15000 });
    check('отказ второго запроса показан: порядок не изменён, название категории — перечнем', /изменили/.test((await banner.locator('[data-conflict-message]').textContent())!) && (await changesOf(banner)).some((c: any) => c.label === 'Название' && c.was === 'Среда' && c.now === 'Среда обитания'), await banner.textContent());
    check('ушло два запроса PUT, оба с версией', requests.filter((r) => r.method === 'PUT').length === 2 && requests.filter((r) => r.method === 'PUT').every((r) => typeof JSON.parse(r.body).expectedVersion === 'number'), requests);
    await page.getByText('Среда обитания').first().waitFor({ timeout: 15000 });
    check('справочник перечитан: на экране название коллеги', true);
    await page.getByRole('button', { name: 'Понятно' }).click();

    // 4в. Удаление категории, у которой открыт вариант у коллеги
    check('Иванов держит вариант «КИП» открытым', (await holdOpen([{ model: 'DictionaryItem', id: optKip.id }])).status === 200);
    await card('Класс надёжности').getByTitle('Удалить').click();
    await confirmDelete('Удалить категорию');
    await windowed.waitFor({ timeout: 15000 });
    const nestedText = (await windowed.textContent())!;
    check('окно называет вариант и коллегу, удалить нельзя', nestedText.includes('Иванов И. И.') && nestedText.includes('КИП') && /нельзя/.test(nestedText), nestedText);
    check('категория и вариант целы', !!(await itemNow(catClass.id)) && !!(await itemNow(optKip.id)));
    await shot('tag-delete-open-refusal');
    await page.getByRole('button', { name: 'Понятно' }).click();
    await holdOpen([]);

    // ── 5. «Маркировка» и «Пресеты подбора» ──
    console.log('5. Маркировка и пресеты');
    await goTo('Маркировка');
    const markCard = page.locator('div.p-3.rounded-lg', { hasText: 'Блок' }).first();
    await markCard.waitFor({ timeout: 30000 });
    await markCard.locator('button').nth(2).click();
    await waitRows([`DictionaryItem:${markBlock.id}`], 'категорию маркировки правят — в базе строка OpenRecord');
    await colleagueEdits(markBlock.id, { nameRu: 'Блок/Сегмент' });
    const markEditing = page.locator('div.p-3.rounded-lg:has(input[type=text])');
    await markEditing.locator('input[type=text]').fill('Мой блок');
    await markEditing.locator('button').nth(0).click();
    await banner.waitFor({ timeout: 15000 });
    same('маркировка: перечень «Блок» → «Блок/Сегмент»', await changesOf(banner), [{ label: 'Название', was: 'Блок', now: 'Блок/Сегмент' }]);
    await page.waitForTimeout(500);
    check('маркировка: набранное цело', await markEditing.locator('input[type=text]').inputValue() === 'Мой блок');
    await markEditing.locator('button').nth(1).click();
    await waitRows([], 'маркировка: правка закончена — строки OpenRecord нет');
    await page.getByRole('button', { name: 'Понятно' }).click();

    await goTo('Пресеты подбора');
    const presetCard = page.locator('div.cursor-pointer', { hasText: 'Проект 3700' }).first();
    await presetCard.waitFor({ timeout: 30000 });
    await presetCard.locator('button').nth(0).click();
    await waitRows([`DictionaryItem:${preset.id}`], 'предустановку правят — в базе строка OpenRecord');
    await colleagueEdits(preset.id, { nameRu: 'Проект 3800' });
    const presetEditing = page.locator('div.cursor-pointer:has(input[type=text])');
    await presetEditing.locator('input[type=text]').nth(0).fill('Мой проект');
    await presetEditing.locator('button').nth(0).click();
    await banner.waitFor({ timeout: 15000 });
    same('пресеты: перечень «Проект 3700» → «Проект 3800»', await changesOf(banner), [{ label: 'Название', was: 'Проект 3700', now: 'Проект 3800' }]);
    await page.waitForTimeout(500);
    check('пресеты: набранное цело', await presetEditing.locator('input[type=text]').nth(0).inputValue() === 'Мой проект');
    await presetEditing.locator('button').nth(1).click();
    await waitRows([], 'пресеты: правка закончена — строки OpenRecord нет');

    check('на экране не было ошибок страницы', pageErrors.length === 0, pageErrors);
    console.log(`\nПройдено проверок: ${passed}`);
  } finally {
    try { await browser?.close(); } catch { /* закрыт */ }
    try { sql?.close(); } catch { /* закрыта */ }
    child.kill();
    await new Promise((r) => setTimeout(r, 500));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
