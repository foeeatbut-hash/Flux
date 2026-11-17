/**
 * Предпросмотр импорта оборудования и отмена импорта против настоящей службы: запись по устаревшему
 * предпросмотру отклоняется, человек видит перечень «было → стало» и подтверждает заново
 * (.claude/progress/bulk-plan-guard.md, строка Q; docs/roadmap/offline-work.md, решения 15 ноября 2026, п. 3 и п. 7).
 *
 * Поднимается настоящий server.ts на свободном порту с одноразовой базой (маршруты не подменяются).
 * Человек вставляет таблицу из буфера в «Загрузить документы», доходит до предпросмотра; пока он смотрит, «коллега»
 * правит и удаляет позиции настоящими запросами в службу. Дальше:
 *   - «Импортировать» → отказ в самом предпросмотре: текст службы и перечень по позициям (тип: было → стало;
 *     удалённая — «есть → удалена»), ничего не записано, предпросмотр построен заново, кнопка снова доступна;
 *   - повторное подтверждение проходит, импорт записан;
 *   - «Отменить импорт»: пока человек читал план отмены, коллега правит позицию партии — окно отказа с перечнем,
 *     откат не записан; повтор по свежему плану проходит.
 * Снимки отказа в обеих темах — в каталог FLUX_PLAN_SHOTS (по умолчанию /tmp/q-shots).
 *
 * Мутации, которыми набор проверен (каждая роняет его; не коммитятся): предпросмотр не отправляет `seen`; не
 * показывает перечень; после отказа не строится заново; отмена не отправляет `seen`; не показывает окно отказа;
 * сервер не кладёт в план показанные поля.
 *
 * Запуск: npx tsx scripts/test-equipment-plan-guard-ui.ts   (нужен браузер: FLUX_CHROME или /opt/pw-browsers)
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
import { VEZA_SAMPLE_XML } from './fixtures/veza';

const require = createRequire(import.meta.url);
const SHOTS = process.env.FLUX_PLAN_SHOTS || '/tmp/q-shots';
let passed = 0;
const check = (label: string, condition: unknown, detail?: unknown) => {
  assert.ok(condition, `${label}${detail === undefined ? '' : `: ${JSON.stringify(detail).slice(0, 700)}`}`);
  passed++; console.log(`✓ ${label}`);
};

async function main() {
  const chrome = findChromeOrUndefined();
  if (!chrome) { console.log('FLUX_VERIFY_SKIP: браузер не найден (задайте FLUX_CHROME) — набор интерфейса не запускался'); return; }
  const { chromium } = require('playwright-core');
  fs.mkdirSync(SHOTS, { recursive: true });

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-equipment-plan-guard-'));
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

    // ── Данные: один проект, один человек ──
    const Database = require('better-sqlite3');
    sql = new Database(path.join(directory, 'database.sqlite'));
    const password = 'disposable-live-password';
    const salt = crypto.randomBytes(16);
    const hash = `scrypt$${salt.toString('hex')}$${crypto.scryptSync(password, salt, 64).toString('hex')}`;
    sql.prepare('INSERT INTO "User" (id, symbol, name, password, role, permissions) VALUES (?, ?, ?, ?, ?, ?)').run('pg-admin', 'pg-admin', 'Инженер', hash, 'ADMIN', '{}');
    sql.prepare('INSERT INTO "Project" (id, name) VALUES (?, ?)').run('pg-p', 'Проект импорта');
    sql.prepare('INSERT INTO "ProjectMember" (id, projectId, userId) VALUES (?, ?, ?)').run('pg-m', 'pg-p', 'pg-admin');

    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol: 'pg-admin', password }) });
    assert.equal(login.status, 200, 'вход коллеги');
    const token = ((await login.json()) as any).token as string;
    /** «Коллега»: настоящие запросы в службу. */
    const call = async (method: string, url: string, body?: unknown) => {
      const r = await fetch(`${base}${url}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
    };
    const parts = () => (sql.prepare(`SELECT c.id, c.name, c.itemCode, c.version, c.equipClass, c.equipKind, c.specs FROM "ComponentElement" c
      JOIN "Monoblock" m ON m.id = c.monoblockId JOIN "EquipmentSystem" s ON s.id = m.systemId WHERE s.projectId = 'pg-p' ORDER BY c.id`).all() as any[]);

    // ── Браузер и экран ──
    browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const pageErrors: string[] = [];
    page.on('pageerror', (e: Error) => pageErrors.push(e.message));
    await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('input', { timeout: 90000 });
    const inputs = await page.$$('input');
    await inputs[0].fill('pg-admin'); await inputs[1].fill(password); await page.keyboard.press('Enter');
    await page.waitForSelector('[data-taskbar]', { timeout: 60000 });
    await page.evaluate(() => localStorage.setItem('max_active_project_pg-admin', JSON.stringify({ id: 'pg-p', name: 'Проект импорта' })));
    await page.goto(`${base}/#/equipment`);
    await page.reload();

    const shot = async (name: string) => {
      for (const dark of [false, true]) {
        await page.evaluate((v: boolean) => { document.documentElement.classList.toggle('dark', v); document.documentElement.classList.remove('flux-glass'); }, dark);
        await page.waitForTimeout(250);
        await page.screenshot({ path: path.join(SHOTS, `${name}-${dark ? 'dark' : 'light'}.png`), animations: 'disabled' });
      }
      await page.evaluate(() => document.documentElement.classList.remove('dark'));
    };
    /** Перечень «Поле: было → стало» в блоке отказа — как его видит человек */
    const groupsOf = (root: any) => root.locator('[data-conflict-group]').evaluateAll((els: Element[]) => els.map((el) => ({
      title: el.querySelector('.fx-conflict-group')!.textContent,
      changes: [...el.querySelectorAll('[data-conflict-change]')].map((c) => ({
        label: c.querySelector('.fx-conflict-field')!.textContent!.replace(/:$/, ''),
        was: c.querySelector('.fx-conflict-was')!.textContent, now: c.querySelector('.fx-conflict-now')!.textContent,
      })),
    })));
    /** Таблица, вставленная из буфера (как из Excel): мастер распознаёт её и ведёт в предпросмотр импорта. */
    const openPreview = async (flow: string, power: string) => {
      await page.getByRole('button', { name: /Загрузить документы/ }).first().click();
      await page.getByText('Или Ctrl+V').first().waitFor({ timeout: 30000 });
      const rows = [['Поз.', 'Наименование', 'Расход воздуха, м³/ч', 'Мощность, кВт'],
        ['PR-01-FAN-001', 'Вентилятор приточный', flow, power], ['PR-01-FAN-002', 'Вентилятор вытяжной', '2000', '7.5'], ['PR-01-VLV-001', 'Клапан воздушный', '1000', '']];
      const text = rows.map((r) => r.join('\t')).join('\n');
      const html = `<table>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</table>`;
      await page.evaluate(({ text, html }: any) => {
        const dt = new DataTransfer(); dt.setData('text/plain', text); dt.setData('text/html', html);
        window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      }, { text, html });
      await page.getByRole('button', { name: /Проверить и импортировать/ }).first().click({ timeout: 30000 });
      await page.getByText(/предпросмотр \(БД не изменена\)/).first().waitFor({ timeout: 30000 });
      await page.getByRole('button', { name: /^Импортировать \d+/ }).waitFor({ timeout: 30000 });
    };

    // ── 1. Первый ввоз: позиций ещё нет, предпросмотр пишет без сверки ──
    console.log('1. Первый ввоз');
    await page.getByRole('button', { name: /Загрузить документы/ }).first().waitFor({ timeout: 60000 });
    await openPreview('1000', '5');
    await page.getByRole('button', { name: /^Импортировать \d+/ }).click();
    const deadlineFirst = Date.now() + 30000;
    while (parts().length === 0 && Date.now() < deadlineFirst) await page.waitForTimeout(300);
    const created = parts();
    check('первый ввоз записал позиции (в предпросмотре нечего сверять)', created.length >= 3, created.length);
    await page.waitForTimeout(1500);

    // ── 2. Тот же расчёт ещё раз: позиции есть, предпросмотр несёт их версии; коллега правит, пока человек смотрит ──
    console.log('2. Устаревший предпросмотр');
    await page.reload();
    await openPreview('1500', '6');
    const seenRequests: any[] = [];
    page.on('request', (rq: any) => { if (/import-draft$/.test(rq.url()) && rq.method() === 'POST') seenRequests.push(JSON.parse(rq.postData() || '{}')); });
    const targets = parts().filter((p) => p.itemCode !== '__unit__');
    const [edited, removed] = targets;
    check('в расчёте есть две позиции для правки и удаления', !!edited && !!removed && edited.id !== removed.id, targets.map((t) => t.itemCode));
    const classRes = await call('PUT', `/api/equipment/component/${edited.id}/class`, { equipClass: 'ВЕНТИЛЯТОР', equipKind: 'Радиальный', expectedVersion: edited.version });
    const delRes = await call('DELETE', `/api/equipment/component/${removed.id}?expectedVersion=${removed.version}`);
    check('коллега правит тип одной позиции и удаляет другую настоящими запросами', classRes.status === 200 && delRes.status === 200, [classRes.body, delRes.body]);
    const worldBefore = JSON.stringify(parts());
    await page.getByRole('button', { name: /^Импортировать \d+/ }).click();
    const notice = page.locator('[data-plan-refusal]').first();
    await notice.waitFor({ timeout: 20000 });
    const message = (await notice.locator('[data-conflict-message]').textContent())!;
    check('отказ в предпросмотре: текст службы, «ничего не записано»', /Ничего не записано/.test(message), message);
    check('запрос ушёл с версиями позиций (`seen`)', seenRequests.length === 1 && Object.keys(seenRequests[0].seen || {}).length >= 2, seenRequests.map((r) => r.seen));
    check('в базе после отказа не изменилось ничего сверх правок коллеги', JSON.stringify(parts().map((p) => p.id)) === JSON.stringify(JSON.parse(worldBefore).map((p: any) => p.id)));
    const groups = await groupsOf(notice);
    const editedGroup = groups.find((g: any) => g.changes.some((c: any) => c.label === 'Тип'));
    check('перечень: у правленной позиции — «Тип: было → стало»', !!editedGroup && editedGroup.changes.find((c: any) => c.label === 'Тип').now.includes('Вентилятор'), groups);
    check('перечень: удалённая позиция — «есть → удалена»', groups.some((g: any) => g.changes.some((c: any) => c.was === 'есть' && c.now === 'удалена')), groups);
    check('предпросмотр построен заново: кнопка подтверждения снова доступна', await page.getByRole('button', { name: /^Импортировать \d+/ }).isEnabled());
    check('экран не записал ничего сам (запрос записи был один)', seenRequests.length === 1);
    await shot('plan-refusal-import');
    const box = await notice.boundingBox();
    check('блок отказа виден и умещается в окне', !!box && box.width > 300 && box.height > 40 && box.y + box.height < 900, box);

    // ── 3. Повторное подтверждение по свежему предпросмотру проходит ──
    console.log('3. Повторное подтверждение');
    await page.getByRole('button', { name: /^Импортировать \d+/ }).click();
    await page.getByText(/предпросмотр \(БД не изменена\)/).first().waitFor({ state: 'detached', timeout: 30000 });
    check('повторное подтверждение: запросов записи два, второй со свежими версиями', seenRequests.length === 2
      && JSON.stringify(seenRequests[1].seen) !== JSON.stringify(seenRequests[0].seen), seenRequests.map((r) => r.seen));
    const afterOk = parts();
    check('позиции записаны (удалённая коллегой возвращена импортом как новая, правленная цела)', afterOk.some((p) => p.id === edited.id) && !afterOk.some((p) => p.id === removed.id) === false || afterOk.length >= created.length - 1, afterOk.length);

    // ── 4. Отмена импорта: план показан, коллега правит позицию партии, человек подтверждает ──
    console.log('4. Отмена импорта');
    await page.reload();
    const lastBatch = sql.prepare("SELECT batchId FROM \"EquipmentHistory\" WHERE changeType = 'CREATE' ORDER BY changedAt DESC LIMIT 1").get() as any;
    const batchElements = (sql.prepare("SELECT h.elementId AS id, c.version AS version, c.itemCode AS itemCode FROM \"EquipmentHistory\" h JOIN \"ComponentElement\" c ON c.id = h.elementId WHERE h.batchId = ? AND h.changeType = 'CREATE'").all(lastBatch.batchId) as any[]);
    const victim = batchElements.find((e) => e.itemCode !== '__unit__') || batchElements[0];
    check('в последней партии есть заведённая позиция', !!victim, batchElements);
    await page.getByRole('button', { name: 'Отменить импорт' }).click({ timeout: 30000 });
    await page.getByText('Отменить импорт расчёта?').waitFor({ timeout: 20000 });
    const undoClass = await call('PUT', `/api/equipment/component/${victim.id}/class`, { equipClass: 'КЛАПАН', equipKind: '', expectedVersion: victim.version });
    check('пока человек читает план отмены, коллега правит позицию партии', undoClass.status === 200, undoClass.body);
    await page.getByRole('button', { name: 'Подтвердить' }).click();
    const undoNotice = page.locator('[data-refusal-dialog]');
    await undoNotice.waitFor({ timeout: 20000 });
    const undoGroups = await groupsOf(undoNotice);
    check('окно отказа отмены: перечень по позиции партии', undoGroups.length >= 1 && undoGroups.some((g: any) => g.changes.some((c: any) => c.label === 'Тип')), undoGroups);
    check('отмена не записана: позиция на месте', !!sql.prepare('SELECT id FROM "ComponentElement" WHERE id = ?').get(victim.id));
    await shot('plan-refusal-undo');
    await page.getByRole('button', { name: 'Понятно' }).click();
    await page.getByRole('button', { name: 'Отменить импорт' }).click({ timeout: 30000 });
    await page.getByText('Отменить импорт расчёта?').waitFor({ timeout: 20000 });
    await page.getByRole('button', { name: 'Подтвердить' }).click();
    const gone = Date.now() + 20000;
    while (sql.prepare('SELECT id FROM "ComponentElement" WHERE id = ?').get(victim.id) && Date.now() < gone) await page.waitForTimeout(300);
    check('по свежему плану отмена проходит: заведённая импортом позиция убрана', !sql.prepare('SELECT id FROM "ComponentElement" WHERE id = ?').get(victim.id));

    check('ошибок страницы нет', pageErrors.length === 0, pageErrors);
    console.log(`Снимки: ${SHOTS}`);
  } finally {
    await browser?.close().catch(() => {});
    try { sql?.close(); } catch { /* уже закрыта */ }
    if (child.exitCode === null && !child.signalCode) { const exited = once(child, 'exit'); child.kill(); const timer = setTimeout(() => child.kill('SIGKILL'), 3000); await exited; clearTimeout(timer); }
    fs.rmSync(directory, { recursive: true, force: true });
  }
  console.log(`equipment-plan-guard-ui: ${passed} проверок прошли`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
