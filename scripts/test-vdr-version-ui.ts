/**
 * Экран ВДР против настоящей службы: запись по устаревшей версии отклоняется с перечнем
 * «было → стало», набранное человеком цело, массовые действия называют, что записано, а что нет,
 * открытая запись не удаляется (строка 2 очерёдности, .claude/progress/tags-vdr-version.md).
 *
 * Поднимается настоящий server.ts на свободном порту с одноразовой базой. «Коллега» пишет те же
 * записи вторым человеком — настоящими запросами; событие «запись изменили» до экрана не доходит
 * (как при обрыве связи) — экран держит старую версию. Дальше:
 *   1. Карточка строки: человек набрал «название (англ)», коллега поправил «название (рус)» и замечания.
 *      «Сохранить» → отказ на месте формы, перечень «было → стало», набранное в поле, нетронутые поля
 *      взяли текущие значения; чужая правка цела; повтор проходит. Свою же правку того же поля человек
 *      тоже не теряет: в поле остаётся его значение, а значение коллеги названо в перечне.
 *   2. Реквизиты реестра: то же — окно НЕ закрывается, набранное цело, перечень под формой.
 *   3. Открытая запись: пока карточка (или реквизиты) на экране, в базе есть строка `OpenRecord` этого
 *      человека, и коллега не удалит ни строку, ни реестр (текст называет человека); закрыли — строки нет,
 *      удаление проходит; удаление уже удалённого — «уже удалена», а не сбой.
 *   4. Массовые действия: «назначить исполнителя» и «англ. названия» шлют версию каждой строки; одну
 *      строку коллега изменил, другую удалил — записаны остальные, окно называет каждую по причине.
 * Снимки отказов в обеих темах — в каталог FLUX_VDR_SHOTS (по умолчанию /tmp/i2-vdr/shots).
 *
 * Запуск: npx tsx scripts/test-vdr-version-ui.ts   (нужен браузер: FLUX_CHROME или /opt/pw-browsers)
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
import { editChangedText, editGoneText, bulkPartialText, deleteOpenText, deleteOpenNestedText } from '../src/lib/refusalTexts';

const require = createRequire(import.meta.url);
const SHOTS = process.env.FLUX_VDR_SHOTS || '/tmp/i2-vdr/shots';
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

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-vdr-version-'));
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

    // ── Люди и проект: двое, оба в проекте ──
    const Database = require('better-sqlite3');
    sql = new Database(path.join(directory, 'database.sqlite'));
    const password = 'disposable-live-password';
    const salt = crypto.randomBytes(16);
    const hash = `scrypt$${salt.toString('hex')}$${crypto.scryptSync(password, salt, 64).toString('hex')}`;
    const user = sql.prepare('INSERT INTO "User" (id, symbol, name, password, role, permissions) VALUES (?, ?, ?, ?, ?, ?)');
    user.run('vdr-admin', 'vdr-admin', 'Инженер', hash, 'ADMIN', '{}');
    user.run('vdr-petrova', 'vdr-petrova', 'Петрова А. А.', hash, 'ADMIN', '{}');
    sql.prepare('INSERT INTO "Project" (id, name) VALUES (?, ?)').run('vdr-p', 'Проект ВДР');
    sql.prepare('INSERT INTO "ProjectMember" (id, projectId, userId) VALUES (?, ?, ?)').run('vdr-m1', 'vdr-p', 'vdr-admin');
    sql.prepare('INSERT INTO "ProjectMember" (id, projectId, userId) VALUES (?, ?, ?)').run('vdr-m2', 'vdr-p', 'vdr-petrova');

    const loginAs = async (symbol: string) => {
      const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol, password }) });
      assert.equal(login.status, 200, `вход ${symbol}`);
      const token = ((await login.json()) as any).token as string;
      return async (method: string, url: string, body?: unknown) => {
        const r = await fetch(`${base}${url}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
      };
    };
    // «Коллега» — Петрова: правит те же записи, что и человек за экраном (Инженер)
    const colleague = await loginAs('vdr-petrova');

    const registerRes = await colleague('POST', '/api/vdr/registers', { projectId: 'vdr-p', name: 'ВДР котельной' });
    const REG = registerRes.body.register.id as string;
    const mk = async (no: string, titleRu: string) => (await colleague('POST', '/api/vdr/items', { registerId: REG, contractorNo: no, titleRu })).body.item.id as string;
    const I1 = await mk('ДОК-1', 'Общий вид'); const I2 = await mk('ДОК-2', 'Схема узла'); const I3 = await mk('ДОК-3', 'Спецификация');
    const I4 = await mk('ДОК-4', 'Ведомость'); const I5 = await mk('ДОК-5', 'Чертёж'); const I6 = await mk('ДОК-6', 'Разрез');
    check('служба завела реестр и шесть строк', !!REG && [I1, I2, I3, I4, I5, I6].every(Boolean));
    // Память переводов проекта: «Заполнить англ. названия» берёт перевод из неё
    const memory = await colleague('POST', '/api/translate/memory', { projectId: 'vdr-p', units: [
      { src: 'Чертёж', dst: 'Drawing', from: 'ru', to: 'en' }, { src: 'Разрез', dst: 'Section', from: 'ru', to: 'en' },
    ] });
    check('память переводов принята', memory.status === 200, memory);

    const row = (id: string) => sql.prepare('SELECT * FROM "DocRegisterItem" WHERE id = ?').get(id) as any;
    const reg = () => sql.prepare('SELECT * FROM "DocRegister" WHERE id = ?').get(REG) as any;
    const itemStamp = async (id: string): Promise<string> => (await colleague('GET', `/api/vdr/items?registerId=${REG}`)).body.items.find((i: any) => i.id === id).updatedAt;
    /** Правка коллеги: настоящий запрос со свежей версией (он видит всё, что есть) */
    const colleagueEdit = async (id: string, body: Record<string, unknown>) => colleague('PUT', `/api/vdr/items/${id}`, { ...body, expectedUpdatedAt: await itemStamp(id) });
    const registerStamp = async (): Promise<string> => (await colleague('GET', '/api/vdr/registers?projectId=vdr-p')).body.registers.find((r: any) => r.id === REG).updatedAt;
    const openRows = (userId = 'vdr-admin') => (sql.prepare('SELECT model, recordId FROM "OpenRecord" WHERE userId = ? ORDER BY model, recordId').all(userId) as any[]).map((r) => `${r.model}:${r.recordId}`);
    const openReplies: string[] = [];
    const waitRows = async (expected: string[], what: string) => {
      const until = Date.now() + 12000; let got: string[] = [];
      while (Date.now() < until) { got = openRows(); if (JSON.stringify(got) === JSON.stringify(expected)) break; await new Promise((r) => setTimeout(r, 200)); }
      check(what, JSON.stringify(got) === JSON.stringify(expected), { expected, got, replies: openReplies.slice(-3) });
    };

    // ── Браузер и экран ──
    browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const pageErrors: string[] = [];
    page.on('pageerror', (e: Error) => pageErrors.push(e.message));
    page.on('response', async (r: any) => { if (r.url().includes('/api/open-records')) openReplies.push(`${r.request().method()} ${r.status()} ${(await r.text().catch(() => '')).slice(0, 160)}`); });
    // Событие «запись изменили» до экрана не доходит — как при обрыве связи: экран держит старую версию
    await page.addInitScript(() => {
      // Стрелки без имени: сборка набора подкладывает в именованные вспомогательную функцию, которой в странице нет
      window.addEventListener('socket:vdr:changed', (e) => { if ((window as any).__muteVdrEvents) e.stopImmediatePropagation(); }, true);
      window.addEventListener('socket:entity:changed', (e) => { if ((window as any).__muteVdrEvents) e.stopImmediatePropagation(); }, true);
    });
    await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('input', { timeout: 90000 });
    const inputs = await page.$$('input');
    await inputs[0].fill('vdr-admin'); await inputs[1].fill(password); await page.keyboard.press('Enter');
    await page.waitForSelector('[data-taskbar]', { timeout: 60000 });
    await page.evaluate(() => localStorage.setItem('max_active_project_vdr-admin', JSON.stringify({ id: 'vdr-p', name: 'Проект ВДР' })));
    const openScreen = async () => {
      await page.goto(`${base}/#/docflow?tab=registry&vdr=${REG}`);
      await page.reload();
      await page.evaluate(() => { (window as any).__muteVdrEvents = true; });
      await page.locator('tr', { hasText: 'ДОК-1' }).first().waitFor({ timeout: 30000 });
    };
    const shot = async (name: string) => {
      for (const dark of [false, true]) {
        await page.evaluate((v: boolean) => { document.documentElement.classList.toggle('dark', v); document.documentElement.classList.remove('flux-glass'); }, dark);
        await page.waitForTimeout(250);
        await page.screenshot({ path: path.join(SHOTS, `${name}-${dark ? 'dark' : 'light'}.png`), animations: 'disabled' });
      }
      await page.evaluate(() => document.documentElement.classList.remove('dark'));
    };
    /** Перечень «Поле: было → стало» внутри блока отказа — как его видит человек */
    const changesOf = (root: any) => root.locator('[data-conflict-change]').evaluateAll((els: Element[]) => els.map((el) => ({
      label: el.querySelector('.fx-conflict-field')!.textContent!.replace(/:$/, ''),
      was: el.querySelector('.fx-conflict-was')!.textContent,
      now: el.querySelector('.fx-conflict-now')!.textContent,
    })));
    const rowOf = (no: string) => page.locator('tr', { hasText: no }).first();
    const openCard = async (no: string) => { await rowOf(no).locator('td').nth(1).click(); await page.locator('[aria-label="Карточка строки реестра"], [data-dialog-drag]').first().waitFor({ timeout: 15000 }); };
    const cardInput = (label: string) => page.locator(`label:text-is("${label}") + input`).first();
    const closeCard = () => page.getByTitle('Закрыть карточку').click();
    const fits = (root: any) => root.evaluate((el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      const note = el.querySelector('.fx-conflict-now, .fx-conflict-message') as HTMLElement | null;
      return { inside: r.left >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight, fontSize: note ? parseFloat(getComputedStyle(note).fontSize) : 0 };
    });

    await openScreen();

    // ── 1. Карточка строки: перечень при отказе, набранное цело ──
    console.log('1. Карточка строки');
    await openCard('ДОК-1');
    await waitRows([`DocRegisterItem:${I1}`], 'карточка строки открыта — в базе строка OpenRecord этого человека');
    check('отметка свежая и принадлежит человеку за экраном', (sql.prepare('SELECT COUNT(*) AS n FROM "OpenRecord" WHERE userId = ? AND at >= ?').get('vdr-admin', Date.now() - 30000) as any).n === 1);
    const colleagueEdit1 = await colleagueEdit(I1, { titleRu: 'Общий вид установки', remarks: 'проверить узлы' });
    check('коллега поправил название и замечания той же строки', colleagueEdit1.status === 200, colleagueEdit1);
    await cardInput('Наименование (англ)').fill('General view');
    await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    const cardRefusal = page.locator('[data-card-refusal]');
    await cardRefusal.waitFor({ timeout: 15000 });
    check('виден текст отказа службы без кода', (await cardRefusal.locator('[data-conflict-message]').textContent()) === editChangedText('registerItem', 'ДОК-1'), await cardRefusal.textContent());
    same('виден перечень: название и замечания коллеги', await changesOf(cardRefusal), [
      { label: 'Наименование (рус)', was: 'Общий вид', now: 'Общий вид установки' },
      { label: 'Замечания', was: '—', now: 'проверить узлы' },
    ]);
    check('перечень читается и без стилей: «было» и «стало» названы словами', (await cardRefusal.locator('[data-conflict-change]').first().textContent()) === 'Наименование (рус): было Общий вид → стало Общий вид установки', await cardRefusal.locator('[data-conflict-change]').first().textContent());
    check('набранное человеком цело: «англ. название» в поле', await cardInput('Наименование (англ)').inputValue() === 'General view');
    check('нетронутые поля взяли текущие значения коллеги', await cardInput('Наименование (рус)').inputValue() === 'Общий вид установки');
    check('карточка не закрылась', await page.getByRole('button', { name: 'Сохранить', exact: true }).isVisible());
    const afterRefusal = row(I1);
    check('чужая правка цела, своя не записана', afterRefusal.titleRu === 'Общий вид установки' && afterRefusal.remarks === 'проверить узлы' && afterRefusal.titleEn === '', afterRefusal);
    const box = await fits(cardRefusal);
    check('отказ читается: кегль не мельче 12 px, помещается в экран', box.fontSize >= 12 && box.inside, box);
    await shot('card-refusal');
    // Открытая запись: коллега не удалит ни строку, ни реестр
    const del1 = await colleague('DELETE', `/api/vdr/items/${I1}?expectedVersion=${row(I1).version}`);
    check('строка открыта у человека — коллега её не удалит, служба называет человека', del1.status === 409 && del1.body.code === 'RECORD_OPEN' && del1.body.error === deleteOpenText('registerItem', 'ДОК-1', [{ userId: 'vdr-admin', name: 'Инженер' }]), del1.body);
    const delReg = await colleague('DELETE', `/api/vdr/registers/${REG}?expectedVersion=${reg().version}`);
    check('в реестре открыта строка — реестр не удаляется, названа именно строка',
      delReg.status === 409 && delReg.body.code === 'RECORD_OPEN' && delReg.body.error === deleteOpenNestedText({ noun: 'register', name: 'ВДР котельной' }, { noun: 'registerItem', name: 'ДОК-1' }, [{ userId: 'vdr-admin', name: 'Инженер' }]), delReg.body);
    check('после отказов удаления строка и реестр на месте', !!row(I1) && !!reg());
    // Повтор: человек прочитал перечень и сохраняет
    await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await page.getByText('Сохранено', { exact: true }).first().waitFor({ timeout: 15000 });
    const retried = row(I1);
    check('повтор проходит: записано название человека, правка коллеги не затёрта', retried.titleEn === 'General view' && retried.titleRu === 'Общий вид установки' && retried.remarks === 'проверить узлы', retried);
    check('после успеха отказа на карточке нет', await page.locator('[data-card-refusal]').count() === 0);
    await closeCard();
    await waitRows([], 'карточка закрыта — строки OpenRecord нет');
    const del1b = await colleague('DELETE', `/api/vdr/items/${I4}?expectedVersion=${row(I4).version}`);
    check('закрытая строка удаляется', del1b.status === 200 && !row(I4), del1b);
    const del1c = await colleague('DELETE', `/api/vdr/items/${I4}?expectedVersion=1`);
    check('удаление уже удалённой — 200 «alreadyGone», а не сбой', del1c.status === 200 && del1c.body.alreadyGone === true, del1c);

    // Человек и коллега правят одно и то же поле: у человека остаётся его значение, значение коллеги — в перечне
    await openCard('ДОК-2');
    await colleagueEdit(I2, { titleEn: 'Theirs' });
    await cardInput('Наименование (англ)').fill('Mine');
    await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await cardRefusal.waitFor({ timeout: 15000 });
    same('одно поле у обоих: в перечне значение коллеги', await changesOf(cardRefusal), [{ label: 'Наименование (англ)', was: '—', now: 'Theirs' }]);
    check('одно поле у обоих: в поле остаётся значение человека', await cardInput('Наименование (англ)').inputValue() === 'Mine' && row(I2).titleEn === 'Theirs', { shown: await cardInput('Наименование (англ)').inputValue(), db: row(I2).titleEn, notice: await cardRefusal.textContent(), inputs: await page.locator('label:text-is("Наименование (англ)")').count() });
    await closeCard();

    // ── 2. Реквизиты реестра ──
    console.log('2. Реквизиты реестра');
    await page.getByRole('button', { name: 'Реквизиты реестра, стандарт, свои колонки' }).click();
    await page.getByText('Реквизиты реестра (титульный лист)').waitFor({ timeout: 15000 });
    await waitRows([`DocRegister:${REG}`], 'реквизиты открыты — в базе строка OpenRecord реестра');
    const colleagueReg = await colleague('PUT', `/api/vdr/registers/${REG}`, { contractor: 'ООО Подряд', vendor: 'ООО Поставщик', expectedUpdatedAt: await registerStamp() });
    check('коллега поправил подрядчика и поставщика', colleagueReg.status === 200, colleagueReg);
    await page.locator('label:text-is("Заказ (PO)") + input').fill('PO-77');
    await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    const regRefusal = page.locator('[data-register-refusal]');
    await regRefusal.waitFor({ timeout: 15000 });
    check('виден текст отказа службы', (await regRefusal.locator('[data-conflict-message]').textContent()) === editChangedText('register', 'ВДР котельной'), await regRefusal.textContent());
    same('виден перечень: подрядчик и поставщик', await changesOf(regRefusal), [
      { label: 'Подрядчик', was: '—', now: 'ООО Подряд' },
      { label: 'Поставщик', was: '—', now: 'ООО Поставщик' },
    ]);
    check('окно реквизитов не закрылось, набранное в поле', await page.locator('label:text-is("Заказ (PO)") + input').inputValue() === 'PO-77');
    check('нетронутые поля взяли значения коллеги', await page.locator('label:text-is("Поставщик") + input').inputValue() === 'ООО Поставщик');
    check('чужая правка цела, своя не записана', reg().vendor === 'ООО Поставщик' && reg().contractor === 'ООО Подряд' && reg().poNumber === '', reg());
    const regBox = await fits(regRefusal);
    check('отказ реквизитов читается: кегль не мельче 12 px, помещается в экран', regBox.fontSize >= 12 && regBox.inside, regBox);
    await shot('register-refusal');
    const delOpenReg = await colleague('DELETE', `/api/vdr/registers/${REG}?expectedVersion=${reg().version}`);
    check('реквизиты открыты — реестр не удаляется, служба называет человека', delOpenReg.status === 409 && delOpenReg.body.error === deleteOpenText('register', 'ВДР котельной', [{ userId: 'vdr-admin', name: 'Инженер' }]), delOpenReg.body);
    await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await page.getByText('Реквизиты сохранены').first().waitFor({ timeout: 15000 });
    check('повтор проходит: PO человека записан, чужое цело', reg().poNumber === 'PO-77' && reg().vendor === 'ООО Поставщик' && reg().contractor === 'ООО Подряд', reg());
    await waitRows([], 'реквизиты закрыты — строки OpenRecord нет');

    // ── 3. Массовое «назначить исполнителя» ──
    console.log('3. Массовое назначение');
    await openScreen();
    for (const no of ['ДОК-1', 'ДОК-2', 'ДОК-3']) await rowOf(no).locator('input[type=checkbox]').check();
    check('выбрано три строки', await page.getByText('Назначить 3 строки…').count() === 1);
    const remarksEdit = await colleagueEdit(I2, { remarks: 'правка коллеги' });
    const gone3 = await colleague('DELETE', `/api/vdr/items/${I3}?expectedVersion=${row(I3).version}`);
    check('коллега изменил одну выбранную строку и удалил другую', remarksEdit.status === 200 && gone3.status === 200 && !row(I3), { remarksEdit, gone3 });
    await page.locator('select', { has: page.locator('option', { hasText: 'Назначить' }) }).selectOption({ label: 'Инженер' });
    const bulk = page.locator('[data-refusal-dialog]');
    await bulk.waitFor({ timeout: 15000 });
    check('сказано, сколько записано из скольких', (await bulk.locator('[data-conflict-message]').textContent()) === bulkPartialText(1, 3), await bulk.locator('[data-conflict-message]').textContent());
    same('перечень по строке: ДОК-2 — замечания коллеги', await bulk.locator('[data-conflict-group]').evaluateAll((els: Element[]) => els.map((el) => ({
      title: el.querySelector('h4')!.textContent,
      changes: Array.from(el.querySelectorAll('[data-conflict-change]')).map((c) => c.textContent),
    }))), [{ title: 'ДОК-2', changes: ['Замечания: было — → стало правка коллеги'] }]);
    same('удалённая строка названа отдельно', await bulk.locator('[data-conflict-note]').allTextContents(), [`ДОК-3: ${editGoneText('registerItem', 'ДОК-3')}`]);
    const bulkBox = await fits(bulk.locator('[data-vdr-refusal]'));
    check('окно читается: кегль не мельче 12 px', bulkBox.fontSize >= 12 && bulkBox.inside, bulkBox);
    check('в базе: первой строке исполнитель назначен, остальным нет, чужая правка цела', row(I1).assigneeId === 'vdr-admin' && !row(I2).assigneeId && row(I2).remarks === 'правка коллеги', { i1: row(I1).assigneeId, i2: row(I2) });
    await shot('bulk-assign-refusal');
    await page.getByRole('button', { name: 'Понятно' }).click();
    check('выбор остался на строке, которой не записано; удалённой в выборе нет', await page.getByText('Назначить 1 строка…').count() === 1);
    // Экран перечитал строки: повтор для оставшейся идёт с новой версией и проходит
    await page.locator('select', { has: page.locator('option', { hasText: 'Назначить' }) }).selectOption({ label: 'Инженер' });
    // Тост «назначен: 1 строка» уже был после первой попытки, поэтому ждём саму запись в базе
    await page.waitForFunction(() => true);
    for (let i = 0; i < 50 && !row(I2).assigneeId; i++) await new Promise((r) => setTimeout(r, 200));
    check('повтор записал исполнителя, чужое замечание цело', row(I2).assigneeId === 'vdr-admin' && row(I2).remarks === 'правка коллеги', row(I2));

    // ── 4. Массовые английские названия ──
    console.log('4. Английские названия');
    await openScreen();
    const fresh = await colleagueEdit(I6, { remarks: 'правка коллеги по разрезу' });
    check('коллега изменил строку «Разрез», которую экран ещё не перечитал', fresh.status === 200, fresh);
    await page.getByRole('button', { name: 'Англ. названия' }).click();
    const fill = page.locator('[data-refusal-dialog]');
    await fill.waitFor({ timeout: 20000 });
    check('сказано, сколько записано из скольких', (await fill.locator('[data-conflict-message]').textContent()) === bulkPartialText(1, 2), await fill.locator('[data-conflict-message]').textContent());
    same('перечень по строке: «Разрез» — замечания коллеги', await fill.locator('[data-conflict-group] h4').allTextContents(), ['ДОК-6']);
    check('в базе: «Чертёж» переведён, «Разрез» не тронут, замечание коллеги цело', row(I5).titleEn === 'Drawing' && row(I6).titleEn === '' && row(I6).remarks === 'правка коллеги по разрезу', { i5: row(I5).titleEn, i6: row(I6) });
    await shot('fill-english-refusal');
    await page.getByRole('button', { name: 'Понятно' }).click();

    check('ошибок страницы нет', pageErrors.length === 0, pageErrors);
    console.log(`Снимки: ${SHOTS}`);
  } finally {
    await browser?.close().catch(() => {});
    try { sql?.close(); } catch { /* уже закрыта */ }
    if (child.exitCode === null && !child.signalCode) { const exited = once(child, 'exit'); child.kill(); const timer = setTimeout(() => child.kill('SIGKILL'), 3000); await exited; clearTimeout(timer); }
    fs.rmSync(directory, { recursive: true, force: true });
  }
  console.log(`vdr-version-ui: ${passed} проверок прошли`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
