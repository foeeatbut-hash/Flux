/**
 * Экран «Оборудование» против настоящей службы: запись по устаревшей версии отклоняется,
 * чужая правка цела, набранное человеком не пропадает (этап 0, 0.5, часть 1).
 *
 * Поднимается настоящий server.ts на свободном порту с одноразовой базой (маршруты не подменяются;
 * заглушки нет вовсе: подтверждения идут через настоящее окно программы). Экран открыт; пока человек
 * правит, «коллега» пишет ту же запись вторым запросом прямо в службу; событие «запись изменили»
 * до экрана не доходит (так бывает при обрыве связи) — экран держит старую версию. Дальше человек
 * правит тип, значение, удаляет позицию и установку:
 *   - виден отказ сервера (его текст), данные перечитаны (версия в карточке выросла);
 *   - чужая правка цела в базе, ввод человека — в поле (тип, значение) или назван в сообщении;
 *   - повтор после перечитывания проходит; без чужой правки действие проходит сразу.
 * Снимки отказа в обеих темах — в каталог FLUX_EQUIPMENT_SHOTS (по умолчанию /tmp/flux-equipment-version).
 *
 * Установка не имеет своего маршрута правки, поэтому «коллега» поднимает её версию записью в таблицу
 * (так её двигает, например, импорт); у позиции и значения — настоящие маршруты службы.
 *
 * Запуск: npx tsx scripts/test-equipment-version-ui.ts   (нужен браузер: FLUX_CHROME или /opt/pw-browsers)
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
const SHOTS = process.env.FLUX_EQUIPMENT_SHOTS || '/tmp/flux-equipment-version';
let passed = 0;
const check = (label: string, condition: unknown, detail?: unknown) => {
  assert.ok(condition, `${label}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
  passed++; console.log(`✓ ${label}`);
};

async function main() {
  const chrome = findChromeOrUndefined();
  if (!chrome) { console.log('FLUX_VERIFY_SKIP: браузер не найден (задайте FLUX_CHROME) — набор интерфейса не запускался'); return; }
  const { chromium } = require('playwright-core');
  fs.mkdirSync(SHOTS, { recursive: true });

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-equipment-version-'));
  const allocator = net.createServer();
  await new Promise<void>((resolve) => allocator.listen(0, '127.0.0.1', resolve));
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

    // ── Данные: один проект, две установки, четыре позиции ──
    const Database = require('better-sqlite3');
    sql = new Database(path.join(directory, 'database.sqlite'));
    const password = 'disposable-live-password';
    const salt = crypto.randomBytes(16);
    const hash = `scrypt$${salt.toString('hex')}$${crypto.scryptSync(password, salt, 64).toString('hex')}`;
    sql.prepare('INSERT INTO "User" (id, symbol, name, password, role, permissions) VALUES (?, ?, ?, ?, ?, ?)').run('eq-admin', 'eq-admin', 'Инженер', hash, 'ADMIN', '{}');
    sql.prepare('INSERT INTO "Project" (id, name) VALUES (?, ?)').run('eq-p', 'Проект оборудования');
    sql.prepare('INSERT INTO "ProjectMember" (id, projectId, userId) VALUES (?, ?, ?)').run('eq-m', 'eq-p', 'eq-admin');
    const system = sql.prepare('INSERT INTO "EquipmentSystem" (id, name, projectId, category) VALUES (?, ?, ?, ?)');
    const mono = sql.prepare('INSERT INTO "Monoblock" (id, name, systemId) VALUES (?, ?, ?)');
    const part = sql.prepare('INSERT INTO "ComponentElement" (id, name, itemCode, monoblockId, specs, equipType) VALUES (?, ?, ?, ?, ?, ?)');
    const specs = JSON.stringify({ groups: [{ title: 'Основные', params: [{ key: 'Мощность', value: '5', unit: 'кВт' }, { key: 'Расход', value: '1000', unit: 'м3/ч' }] }] });
    system.run('eq-s1', 'УВ-1', 'eq-p', 'AHU'); system.run('eq-s2', 'УВ-2', 'eq-p', 'AHU');
    mono.run('eq-m1', 'Моноблок-1', 'eq-s1'); mono.run('eq-m2', 'Моноблок-2', 'eq-s2');
    part.run('eq-fan', 'Вентилятор А', 'FAN-A', 'eq-m1', specs, 'ВЕНТИЛЯТОР');
    part.run('eq-valve', 'Клапан Б', 'VLV-B', 'eq-m1', specs, 'КЛАПАН');
    part.run('eq-filter', 'Фильтр В', 'FLT-C', 'eq-m1', specs, 'ФИЛЬТР');
    part.run('eq-section', 'Секция Д', 'SEC-D', 'eq-m2', specs, 'ПРОЧЕЕ');

    // ── «Коллега»: настоящие запросы в службу ──
    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol: 'eq-admin', password }) });
    assert.equal(login.status, 200, 'вход коллеги');
    const token = ((await login.json()) as any).token as string;
    const call = async (method: string, url: string, body?: unknown) => {
      const r = await fetch(`${base}${url}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
    };
    const tree = async () => (await call('GET', '/api/projects/eq-p/systems?removed=1')).body.systems as any[];
    const parts = async () => Object.fromEntries((await tree()).flatMap((s) => s.monoblocks.flatMap((m: any) => m.components)).map((c: any) => [c.id, c]));
    const systems = async () => Object.fromEntries((await tree()).map((s) => [s.id, s]));
    const specValue = (c: any, key: string) => {
      const group = JSON.parse(c.specs).groups.flatMap((g: any) => g.params).find((p: any) => p.key === key);
      const over = c.overrides ? JSON.parse(c.overrides) : {};
      return over[`Основные||${key}`] ?? group?.value;
    };
    /** Тот же запрос, что отправил бы экран со старой версией: берём точный текст отказа сервера. */
    const staleText = async (id: string, version: number) => (await call('PUT', `/api/equipment/component/${id}/class`, { equipClass: 'ПРИВОД', equipKind: '', expectedVersion: version })).body.error as string;

    // ── Браузер и экран ──
    browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const pageErrors: string[] = [];
    page.on('pageerror', (e: Error) => pageErrors.push(e.message));
    // Событие «запись изменили» до экрана не доходит — как при обрыве связи: экран держит старую версию
    await page.addInitScript(() => {
      window.addEventListener('socket:entity:changed', (e) => { if ((window as any).__muteEntityEvents) e.stopImmediatePropagation(); }, true);
    });
    await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('input', { timeout: 90000 });
    const inputs = await page.$$('input');
    await inputs[0].fill('eq-admin'); await inputs[1].fill(password); await page.keyboard.press('Enter');
    await page.waitForSelector('[data-taskbar]', { timeout: 60000 });
    await page.evaluate(() => localStorage.setItem('max_active_project_eq-admin', JSON.stringify({ id: 'eq-p', name: 'Проект оборудования' })));
    await page.goto(`${base}/#/equipment`);
    await page.reload();
    const mute = (on: boolean) => page.evaluate((v: boolean) => { (window as any).__muteEntityEvents = v; }, on);
    const shot = async (name: string) => {
      for (const dark of [false, true]) {
        await page.evaluate((v: boolean) => { document.documentElement.classList.toggle('dark', v); document.documentElement.classList.remove('flux-glass'); }, dark);
        await page.waitForTimeout(250);
        await page.screenshot({ path: path.join(SHOTS, `${name}-${dark ? 'dark' : 'light'}.png`), animations: 'disabled' });
      }
      await page.evaluate(() => document.documentElement.classList.remove('dark'));
    };
    /** Дождаться, пока экран перечитает дерево после отказа: повтор действия должен идти с новой версией */
    const rereadOf = async (action: () => Promise<void>) => {
      const reread = page.waitForResponse((r: any) => /\/systems\?removed=1/.test(r.url()), { timeout: 15000 });
      await action(); await reread; await page.waitForTimeout(400);
    };
    const openTree = async () => {
      await page.getByText('УВ-1', { exact: true }).first().waitFor({ timeout: 30000 });
      for (const unit of ['УВ-1', 'УВ-2']) {
        const row = page.locator('div.group', { has: page.locator(`span[title="${unit}"]`) }).first();
        await row.getByRole('button', { name: unit, exact: true }).click();
      }
      // Позиции лежат в свёрнутых блоках дерева
      for (const block of ['Моноблок-1', 'Моноблок-2']) await page.locator('div.ml-4 div.group > button').filter({ hasText: block }).first().click();
    };
    const treeRow = (name: string) => page.locator('button').filter({ hasText: new RegExp(`^${name}`) }).first();
    const openBlock = (name: string) => treeRow(name).click();
    const versionShown = async (unit: string) => Number((await page.getByText(new RegExp(`${unit} · v\\d+`)).first().textContent())!.match(/v(\d+)/)![1]);
    await openTree();
    await mute(true);

    // ── 1. Тип позиции ──
    console.log('1. Тип позиции');
    await openBlock('Вентилятор А');
    check('карточка показывает версию 1', (await versionShown('УВ-1')) === 1);
    const fanSeen = (await parts())['eq-fan'];
    check('служба отдаёт экрану версию позиции', fanSeen.version === 1, fanSeen.version);
    const colleagueClass = await call('PUT', '/api/equipment/component/eq-fan/class', { equipClass: 'ФИЛЬТР', equipKind: 'Карманный', expectedVersion: 1 });
    check('коллега поправил тип той же позиции', colleagueClass.status === 200 && colleagueClass.body.version === 2, colleagueClass);
    await page.locator('[data-type-chip]').click();
    const typeDialog = page.getByRole('dialog', { name: 'Тип позиции' });
    await typeDialog.locator('select').selectOption('КЛАПАН');
    await typeDialog.locator('input').fill('Воздушный');
    await typeDialog.getByRole('button', { name: 'Записать' }).click();
    const refusal = typeDialog.locator('[data-type-refusal]');
    await refusal.waitFor({ timeout: 15000 });
    const refusalText = (await refusal.textContent())!;
    check('виден текст отказа сервера', refusalText === await staleText('eq-fan', 1), refusalText);
    check('окно типа не закрылось, выбор человека остался в полях', await typeDialog.locator('select').inputValue() === 'КЛАПАН' && await typeDialog.locator('input').inputValue() === 'Воздушный');
    await page.getByText('УВ-1 · v2').first().waitFor({ timeout: 15000 });
    check('данные перечитаны: в карточке версия 2', (await versionShown('УВ-1')) === 2);
    const afterType = (await parts())['eq-fan'];
    check('чужая правка цела: тип коллеги в базе, версия 2', afterType.equipClass === 'ФИЛЬТР' && afterType.equipKind === 'Карманный' && afterType.version === 2, afterType);
    const box = await refusal.evaluate((el: HTMLElement) => { const r = el.getBoundingClientRect(); const c = getComputedStyle(el); const p = el.closest('[role=dialog]')!.getBoundingClientRect(); return { fontSize: c.fontSize, inside: r.left >= p.left && r.right <= p.right && r.bottom <= p.bottom, color: c.color }; });
    check('отказ читается: кегль не мельче 12 px, помещается в окне', parseFloat(box.fontSize) >= 12 && box.inside, box);
    await shot('type-refusal');
    await typeDialog.getByRole('button', { name: 'Записать' }).click();
    await page.getByText('Тип позиции поправлен').first().waitFor({ timeout: 15000 });
    const afterRetry = (await parts())['eq-fan'];
    check('повтор после перечитывания проходит: записан тип человека, версия 3', afterRetry.equipClass === 'КЛАПАН' && afterRetry.equipKind === 'Воздушный' && afterRetry.version === 3, afterRetry);

    // ── 2. Значение ──
    console.log('2. Значение');
    await page.reload(); await mute(true); await openTree(); await openBlock('Вентилятор А');
    check('экран открыт заново: версия 3', (await versionShown('УВ-1')) === 3);
    const colleagueValue = await call('POST', '/api/equipment/component/eq-fan/override', { group: 'Основные', key: 'Расход', value: '2000', expectedVersion: 3 });
    check('коллега поправил другое значение той же позиции', colleagueValue.status === 200, colleagueValue);
    await page.getByTitle('Изменить вручную').first().click();
    const field = page.locator('input:focus');
    await field.fill('7');
    await field.press('Enter');
    const editError = page.locator('[data-edit-error]');
    await editError.waitFor({ timeout: 15000 });
    check('виден текст отказа сервера', (await editError.textContent()) === await staleText('eq-fan', 3), await editError.textContent());
    check('значение человека осталось в поле', await page.locator('input:focus').inputValue() === '7');
    await page.getByText('УВ-1 · v4').first().waitFor({ timeout: 15000 });
    check('данные перечитаны: чужое значение уже на экране', await page.getByText('2000', { exact: false }).first().isVisible());
    const afterValue = (await parts())['eq-fan'];
    check('чужая правка цела, своя не записана', specValue(afterValue, 'Расход') === '2000' && specValue(afterValue, 'Мощность') === '5', { rate: specValue(afterValue, 'Расход'), power: specValue(afterValue, 'Мощность') });
    await shot('value-refusal');
    await page.locator('input:focus').press('Enter');
    await page.getByText('Параметр изменён').first().waitFor({ timeout: 15000 });
    const valueRetry = (await parts())['eq-fan'];
    check('повтор проходит: значение человека записано, чужое не затёрто', specValue(valueRetry, 'Мощность') === '7' && specValue(valueRetry, 'Расход') === '2000', valueRetry.overrides);
    check('поле закрылось после успеха', await page.locator('[data-edit-error]').count() === 0 && await page.locator('input:focus').count() === 0);

    // ── 3. Удаление позиции ──
    console.log('3. Удаление позиции');
    await page.reload(); await mute(true); await openTree();
    const valveBefore = (await parts())['eq-valve'];
    const colleagueValve = await call('PUT', '/api/equipment/component/eq-valve/class', { equipClass: 'ПРИВОД', equipKind: '', expectedVersion: valveBefore.version });
    check('коллега поправил позицию, которую сейчас удалят', colleagueValve.status === 200);
    const confirmDelete = async () => page.getByRole('button', { name: 'Удалить', exact: true }).last().click();
    await rereadOf(async () => {
      await page.getByRole('button', { name: 'Удалить Клапан Б' }).click({ force: true });
      await confirmDelete();
    });
    const toast = page.getByText(await staleText('eq-valve', valveBefore.version)).first();
    await toast.waitFor({ timeout: 15000 });
    check('виден текст отказа сервера', await toast.isVisible());
    const valveAfter = (await parts())['eq-valve'];
    check('позиция не удалена, правка коллеги цела', !!valveAfter && valveAfter.equipClass === 'ПРИВОД' && valveAfter.version === valveBefore.version + 1, valveAfter);
    await treeRow('Клапан Б').waitFor({ timeout: 15000 });
    check('позиция осталась в дереве после перечитывания', true);
    await page.getByRole('button', { name: 'Удалить Клапан Б' }).click({ force: true });
    await confirmDelete();
    await page.getByText('Удалено', { exact: false }).first().waitFor({ timeout: 15000 });
    check('повтор с новой версией удаляет позицию', !(await parts())['eq-valve']);
    await page.getByRole('button', { name: 'Удалить Фильтр В' }).click({ force: true });
    await confirmDelete();
    await page.waitForFunction(() => !document.body.innerText.includes('Фильтр В'), null, { timeout: 15000 });
    check('без чужой правки удаление проходит сразу', !(await parts())['eq-filter']);

    // ── 4. Удаление установки ──
    console.log('4. Удаление установки');
    await page.reload(); await mute(true); await openTree();
    const sysBefore = (await systems())['eq-s2'];
    sql.prepare('UPDATE "EquipmentSystem" SET version = version + 1 WHERE id = ?').run('eq-s2');
    const deleteSystem = async () => {
      await page.locator('div.group', { has: page.locator('span[title="УВ-2"]') }).first().getByTitle('Удалить установку').click({ force: true });
      await confirmDelete();
    };
    await rereadOf(deleteSystem);
    const unitToast = page.getByText('Не удалось удалить установку: Установку', { exact: false }).first();
    await unitToast.waitFor({ timeout: 15000 });
    const stale = (await call('DELETE', `/api/systems/eq-s2?expectedVersion=${sysBefore.version}`));
    check('виден текст отказа сервера', stale.status === 409 && stale.body.code === 'VERSION_CONFLICT' && (await unitToast.textContent())!.includes(stale.body.error), stale.body);
    check('установка и её позиции целы', !!(await systems())['eq-s2'] && !!(await parts())['eq-section']);
    await page.waitForFunction(() => document.body.innerText.includes('УВ-2'), null, { timeout: 15000 });
    await deleteSystem();
    await page.getByText('Удалено', { exact: false }).first().waitFor({ timeout: 15000 });
    check('повтор с новой версией удаляет установку', !(await systems())['eq-s2'] && !(await parts())['eq-section']);

    check('ошибок страницы нет', pageErrors.length === 0, pageErrors);
    console.log(`Снимки: ${SHOTS}`);
  } finally {
    await browser?.close().catch(() => {});
    try { sql?.close(); } catch { /* уже закрыта */ }
    if (child.exitCode === null && !child.signalCode) { const exited = once(child, 'exit'); child.kill(); const timer = setTimeout(() => child.kill('SIGKILL'), 3000); await exited; clearTimeout(timer); }
    fs.rmSync(directory, { recursive: true, force: true });
  }
  console.log(`equipment-version-ui: ${passed} проверок прошли`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
