/**
 * Рабочий стол против настоящей службы: файл, который успел изменить коллега, не затирается
 * (строка 4, часть E).
 *
 * Поднимается настоящий server.ts на свободном порту с одноразовой базой; маршруты и подтверждения не
 * подменяются. Двое людей: Инженер (за столом) и Иванов — его запросы идут прямо в службу. Пока стол
 * Инженера открыт, Иванов меняет тот же файл; событие «запись изменили» до стола не доходит — стол
 * держит старую версию.
 *   1. Переименование: служба отказывает по версии; окно с текстом службы и перечнем «имя: было → стало»
 *      (показанная ДО перечитывания запись против `current`); набранное имя остаётся в поле; стол
 *      перечитан; повтор уходит с новой версией и проходит.
 *   2. Переименование файла, который Иванов убрал в корзину: перечень «В корзине: нет → да». Уборка файла, уже лежащего
 *      в корзине, — не отказ: служба отвечает «уже убран», значок уходит со стола без окна.
 *   3. Уборка в корзину файла, который Иванов переименовал: перечень с именем, файл не в корзине; повтор проходит.
 *   4. Перенос на общий стол и обратно, файл успели изменить: окно с перечнем, файл на месте.
 *   5. Файл уже исчез: окно с текстом службы, значок пропал со стола.
 * Снимки отказов в обеих темах — в каталог FLUX_DESKTOP_SHOTS (по умолчанию /tmp/e-shots).
 *
 * Запуск: npx tsx scripts/test-desktop-version-ui.ts   (нужен браузер: FLUX_CHROME или /opt/pw-browsers)
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
const SHOTS = process.env.FLUX_DESKTOP_SHOTS || '/tmp/e-shots';
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

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-desktop-version-'));
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

    // ── Данные: два человека, проект ──
    const Database = require('better-sqlite3');
    sql = new Database(path.join(directory, 'database.sqlite'));
    const password = 'disposable-live-password';
    const salt = crypto.randomBytes(16);
    const hash = `scrypt$${salt.toString('hex')}$${crypto.scryptSync(password, salt, 64).toString('hex')}`;
    const addUser = sql.prepare('INSERT INTO "User" (id, symbol, name, password, role, permissions) VALUES (?, ?, ?, ?, ?, ?)');
    addUser.run('ds-admin', 'ds-admin', 'Инженер', hash, 'ADMIN', '{}');
    addUser.run('ds-ivanov', 'ds-ivanov', 'Иванов И. И.', hash, 'ADMIN', '{}');
    sql.prepare('INSERT INTO "Project" (id, name, code, customer, contractor, description, info, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('ds-project', 'Школа №5', 'SCH-5', 'Управление образования', 'СтройМонтаж', 'Новая школа', '', 'ACTIVE');

    const loginAs = async (symbol: string) => {
      const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol, password }) });
      assert.equal(login.status, 200, `вход ${symbol}`);
      const token = ((await login.json()) as any).token as string;
      return async (method: string, url: string, body?: unknown) => {
        const r = await fetch(`${base}${url}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
      };
    };
    const admin = await loginAs('ds-admin');
    const ivanov = await loginAs('ds-ivanov');
    const row = (id: string) => sql.prepare('SELECT * FROM "FileNode" WHERE id = ?').get(id) as any;

    // Общий стол и пять файлов Инженера на нём
    const desk = (await admin('GET', '/api/desktop?projectId=ds-project')).body;
    const sharedId = desk.sharedFolderId as string;
    check('служба завела общий стол', typeof sharedId === 'string' && sharedId.length > 0, desk);
    const make = async (name: string) => {
      const r = await admin('POST', '/api/files', { name, folderId: sharedId, type: 'TXT', content: 'x', size: 1, scope: 'SHARED' });
      assert.equal(r.status, 200, `создание ${name}: ${JSON.stringify(r.body)}`);
      return (r.body.file || r.body).id as string;
    };
    const idRename = await make('Ведомость.txt');
    const idTrashed = await make('Спецификация.txt');
    const idRenamedFirst = await make('Журнал.txt');
    const idAlready = await make('Акт.txt');
    const idShare = await make('Схема.txt');
    const idGone = await make('Черновик.txt');

    // ── Браузер: окно Инженера ──
    browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
    const pageErrors: string[] = [];
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', (e: Error) => pageErrors.push(e.message));
    // Событие «запись изменили» до стола не доходит — как при обрыве связи: стол держит старую версию
    await page.addInitScript(() => { window.addEventListener('socket:entity:changed', (e) => { e.stopImmediatePropagation(); }, true); });
    await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('input', { timeout: 90000 });
    const inputs = await page.$$('input');
    await inputs[0].fill('ds-admin'); await inputs[1].fill(password); await page.keyboard.press('Enter');
    await page.waitForSelector('[data-taskbar]', { timeout: 60000 });
    const icon = (id: string) => page.locator(`[data-desk-item="${id}"]`);
    await icon(idRename).waitFor({ timeout: 30000 });
    check('на столе Инженера лежат шесть файлов', await page.locator('[data-desk-item]').filter({ hasText: /\.txt/ }).count() === 6, await page.locator('[data-desk-item]').count());

    // Записи с версией: по ним видно, что ушло в службу
    const sent: Array<{ method: string; url: string; body: any }> = [];
    page.on('request', (r: any) => {
      if (/\/api\/(files\/[^/]+(\?.*)?$|desktop\/move)/.test(r.url()) && ['PATCH', 'DELETE', 'POST'].includes(r.method())) {
        sent.push({ method: r.method(), url: r.url(), body: r.postData() ? JSON.parse(r.postData()) : {} });
      }
    });

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
    const dialog = page.locator('[data-refusal-dialog]');
    const waitReread = (action: () => Promise<void>) => {
      const reread = page.waitForResponse((r: any) => /\/api\/desktop\?/.test(r.url()) && r.request().method() === 'GET', { timeout: 15000 });
      return action().then(() => reread).then(() => page.waitForTimeout(400));
    };
    const renameTo = async (id: string, name: string) => {
      await icon(id).click();
      await page.keyboard.press('F2');
      const field = icon(id).locator('input');
      await field.waitFor({ timeout: 5000 });
      await field.fill(name);
      return field;
    };
    const removeByKey = async (id: string) => {
      await icon(id).click();
      await page.keyboard.press('Delete');
      await page.getByRole('button', { name: 'Убрать', exact: true }).last().click();
    };
    const menuItem = async (id: string, label: string) => {
      await icon(id).click({ button: 'right' });
      await page.locator('body > [data-context-menu]').last().getByText(label, { exact: true }).click();
    };

    // ── 1. Переименование файла, который изменил Иванов ──
    console.log('1. Переименование: файл изменили, пока стол был открыт');
    check('служба отдаёт версию файла', row(idRename).version === 1, row(idRename).version);
    const colleague = await ivanov('PATCH', `/api/files/${idRename}`, { name: 'Ведомость-2.txt', expectedVersion: 1 });
    check('Иванов переименовал тот же файл', colleague.status === 200 && row(idRename).version === 2, colleague);
    const staleText = (await admin('PATCH', `/api/files/${idRename}`, { name: 'пробный.txt', expectedVersion: 1 })).body.error as string;
    check('для сверки: служба отказывает по версии и называет файл', typeof staleText === 'string' && staleText.length > 10, staleText);
    check('пробная правка ничего не записала', row(idRename).name === 'Ведомость-2.txt');
    const field = await renameTo(idRename, 'Моя ведомость.txt');
    await waitReread(async () => { await field.press('Enter'); });
    await dialog.waitFor({ timeout: 15000 });
    check('окно с текстом службы, а не выдуманным', (await dialog.locator('[data-conflict-message]').textContent()) === staleText, await dialog.textContent());
    same('перечень: имя, как оно было на столе и как стало', await changesOf(dialog), [{ label: 'Имя', was: 'Ведомость.txt', now: 'Ведомость-2.txt' }]);
    check('первая отправка ушла с версией 1', sent.at(-1)?.method === 'PATCH' && sent.at(-1)?.body.expectedVersion === 1, sent.at(-1));
    check('чужая правка цела, своя не записана', row(idRename).name === 'Ведомость-2.txt' && row(idRename).version === 2, row(idRename));
    await shot('rename-conflict');
    await page.getByRole('button', { name: 'Понятно' }).click();
    check('окно закрывается кнопкой', await dialog.count() === 0);
    check('набранное имя осталось в поле', (await icon(idRename).locator('input').inputValue()) === 'Моя ведомость.txt');
    await icon(idRename).locator('input').focus();
    await icon(idRename).locator('input').press('Enter');
    await page.waitForFunction((id) => !document.querySelector(`[data-desk-item="${id}"] input`), idRename, { timeout: 15000 });
    await page.waitForTimeout(500);
    check('повтор ушёл с новой версией 2 и прошёл', sent.at(-1)?.body.expectedVersion === 2 && row(idRename).name === 'Моя ведомость.txt' && row(idRename).version === 3, { sent: sent.at(-1), row: row(idRename) });
    check('на столе новое имя', (await icon(idRename).textContent())!.includes('Моя ведомость'));
    check('второго окна отказа нет', await dialog.count() === 0);

    // ── 2. Файл, который Иванов убрал в корзину ──
    console.log('2. Файл уже в корзине у коллеги');
    const trashedByIvanov = await ivanov('DELETE', `/api/files/${idTrashed}?expectedVersion=1`);
    check('Иванов убрал файл в корзину', trashedByIvanov.status === 200 && !!row(idTrashed).deletedAt, trashedByIvanov);
    const field2 = await renameTo(idTrashed, 'Спецификация новая.txt');
    await waitReread(async () => { await field2.press('Enter'); });
    await dialog.waitFor({ timeout: 15000 });
    same('перечень: «В корзине: нет → да»', await changesOf(dialog), [{ label: 'В корзине', was: 'нет', now: 'да' }]);
    check('имя не записано', row(idTrashed).name === 'Спецификация.txt');
    await shot('rename-conflict-in-bin');
    await page.getByRole('button', { name: 'Понятно' }).click();
    check('после перечитывания файла на столе нет', await icon(idTrashed).count() === 0);
    check('Иванов убрал другой файл в корзину', (await ivanov('DELETE', `/api/files/${idAlready}?expectedVersion=1`)).status === 200);
    await removeByKey(idAlready);
    await icon(idAlready).waitFor({ state: 'detached', timeout: 15000 });
    check('уборка файла, уже лежащего в корзине, — не отказ: окна нет, значок ушёл', await dialog.count() === 0 && !!row(idAlready).deletedAt);

    // ── 3. Уборка файла, который Иванов переименовал ──
    console.log('3. Уборка в корзину: файл переименовали');
    check('Иванов переименовал файл', (await ivanov('PATCH', `/api/files/${idRenamedFirst}`, { name: 'Журнал работ.txt', expectedVersion: 1 })).status === 200);
    await waitReread(async () => { await removeByKey(idRenamedFirst); });
    await dialog.waitFor({ timeout: 15000 });
    same('перечень: имя', await changesOf(dialog), [{ label: 'Имя', was: 'Журнал.txt', now: 'Журнал работ.txt' }]);
    check('файл не в корзине', row(idRenamedFirst).deletedAt === null);
    await shot('trash-conflict');
    await page.getByRole('button', { name: 'Понятно' }).click();
    check('на столе — имя Иванова', (await icon(idRenamedFirst).textContent())!.includes('Журнал работ'));
    await removeByKey(idRenamedFirst);
    await icon(idRenamedFirst).waitFor({ state: 'detached', timeout: 15000 });
    check('повтор с новой версией убирает файл в корзину', !!row(idRenamedFirst).deletedAt && /expectedVersion=2$/.test(sent.at(-1)!.url), sent.at(-1));

    // ── 4. Перенос на общий стол и обратно ──
    console.log('4. Перенос между столами: файл изменили');
    check('Иванов переименовал файл на общем столе', (await ivanov('PATCH', `/api/files/${idShare}`, { name: 'Схема общая.txt', expectedVersion: 1 })).status === 200);
    await waitReread(async () => { await menuItem(idShare, 'Убрать с общего стола'); });
    await dialog.waitFor({ timeout: 15000 });
    same('перечень: имя', await changesOf(dialog), [{ label: 'Имя', was: 'Схема.txt', now: 'Схема общая.txt' }]);
    check('перенос ушёл с версией 1 в теле', sent.at(-1)?.url.endsWith('/api/desktop/move') && sent.at(-1)?.body.expectedVersion === 1, sent.at(-1));
    check('файл остался на общем столе', row(idShare).folderId === sharedId && row(idShare).scope === 'SHARED');
    await shot('share-conflict');
    await page.getByRole('button', { name: 'Понятно' }).click();
    await menuItem(idShare, 'Убрать с общего стола');
    await page.waitForFunction((id) => !!id, idShare);
    await page.waitForTimeout(800);
    check('повтор с версией 2 переносит файл на личный стол', sent.at(-1)?.body.expectedVersion === 2 && row(idShare).scope === 'PERSONAL' && row(idShare).folderId !== sharedId, { sent: sent.at(-1), row: row(idShare) });

    // ── 5. Файл уже исчез ──
    console.log('5. Файл исчез, пока стол был открыт');
    sql.prepare('DELETE FROM "FileNode" WHERE id = ?').run(idGone);
    const field5 = await renameTo(idGone, 'Новый черновик.txt');
    await waitReread(async () => { await field5.press('Enter'); });
    await dialog.waitFor({ timeout: 15000 });
    const goneText = (await dialog.locator('[data-conflict-message]').textContent())!;
    const goneBody = (await admin('PATCH', `/api/files/${idGone}`, { name: 'пробный.txt', expectedVersion: 1 })).body;
    check('окно с текстом службы «уже удалили» (тот же ответ на тот же запрос)', goneBody.code === 'RECORD_GONE' && goneText === goneBody.error, { goneText, goneBody });
    check('перечня нет: запись не менялась, она исчезла', await dialog.locator('[data-conflict-change]').count() === 0);
    await shot('rename-gone');
    await page.getByRole('button', { name: 'Понятно' }).click();
    check('значок пропал со стола, поле имени закрыто', await icon(idGone).count() === 0);

    check('ошибок страницы нет', pageErrors.length === 0, pageErrors);
    console.log(`Снимки: ${SHOTS}`);
  } finally {
    await browser?.close().catch(() => {});
    try { sql?.close(); } catch { /* уже закрыта */ }
    if (child.exitCode === null && !child.signalCode) { const exited = once(child, 'exit'); child.kill(); const timer = setTimeout(() => child.kill('SIGKILL'), 3000); await exited; clearTimeout(timer); }
    fs.rmSync(directory, { recursive: true, force: true });
  }
  console.log(`desktop-version-ui: ${passed} проверок прошли`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
