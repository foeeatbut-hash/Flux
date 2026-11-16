/**
 * Экраны «Реестр» и «Закупки» против настоящей службы: запись по устаревшей версии тега
 * отклоняется, чужая правка цела, набранное человеком не пропадает (строка 2 очерёдности).
 *
 * Поднимается настоящий server.ts на свободном порту с одноразовой базой; маршруты не подменяются.
 * Экран открыт; пока человек правит, «коллега» пишет ту же запись вторым запросом (с токеном
 * другого входа); событие «запись изменили» до экрана не доходит (как при обрыве связи) —
 * экран держит старую версию. Проверяется:
 *   1. Карточка тега: при отказе в ней на месте — перечень «было → стало», набранное в поле цело,
 *      чужая правка в базе цела, а у экрана в базе есть строка `OpenRecord`, пока карточка открыта,
 *      и нет её после закрытия.
 *   2. Удаление тега: версия уходит в запросе (`expectedVersion`); тег, открытый у коллеги, не
 *      удаляется, окно называет коллегу по имени; тег, изменённый коллегой, не удаляется, окно
 *      показывает перечень; нетронутый тег удаляется.
 *   3. «Закупки»: массовый этап по устаревшим данным не пишет ничего (ни один тег не получил
 *      этап) и показывает перечень по записям; после перечитывания повтор проходит.
 * Снимки отказов в обеих темах — в каталог FLUX_TAGS_SHOTS (по умолчанию /tmp/i3-tags-ui/shots).
 *
 * Запуск: npx tsx scripts/test-tag-version-ui.ts   (нужен браузер: FLUX_CHROME или /opt/pw-browsers)
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
const SHOTS = process.env.FLUX_TAGS_SHOTS || '/tmp/i3-tags-ui/shots';
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

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-tag-version-'));
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
    user.run('tg-admin', 'tg-admin', 'Инженер', hash, 'ADMIN', '{}');
    user.run('tg-ivanov', 'tg-ivanov', 'Иванов И. И.', hash, 'ADMIN', '{}');
    sql.prepare('INSERT INTO "Project" (id, name) VALUES (?, ?)').run('tg-p', 'Проект тегов');
    sql.prepare('INSERT INTO "ProjectMember" (id, projectId, userId) VALUES (?, ?, ?)').run('tg-m1', 'tg-p', 'tg-admin');
    sql.prepare('INSERT INTO "ProjectMember" (id, projectId, userId) VALUES (?, ?, ?)').run('tg-m2', 'tg-p', 'tg-ivanov');

    const loginAs = async (symbol: string) => {
      const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol, password }) });
      assert.equal(login.status, 200, `вход ${symbol}`);
      const token = ((await login.json()) as any).token as string;
      return async (method: string, url: string, body?: unknown) => {
        const r = await fetch(`${base}${url}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
      };
    };
    const colleague = await loginAs('tg-admin');
    const ivanov = await loginAs('tg-ivanov');
    const holdOpen = (records: Array<{ model: string; id: string }>) => ivanov('PUT', '/api/open-records', { holderKey: 'ivanov-window-1', records });

    // Теги заводим настоящим маршрутом; координаты нужны, чтобы карточка стояла на доске
    const made: Record<string, any> = {};
    let slot = 0;
    for (const [key, code, brand] of [['ahu', 'AHU-1', 'Acme'], ['fan', 'FAN-2', 'Acme'], ['valve', 'VLV-3', 'Acme'], ['pump', 'PMP-4', 'Acme'], ['damper', 'DMP-5', 'Acme'], ['filter', 'FLT-6', 'Acme']] as const) {
      const r = await colleague('POST', '/api/projects/tg-p/tags', { identifier: code, brand, department: 'ОВ', metadata: { x: 80 + (slot % 3) * 340, y: 80 + Math.floor(slot / 3) * 330, mainName: `Имя ${code}`, connections: [], descriptions: [] } });
      assert.equal(r.status, 200, `тег ${code}: ${JSON.stringify(r.body)}`);
      made[key] = r.body.tag; slot++;
    }
    const tagNow = async (id: string) => ((await colleague('GET', '/api/projects/tg-p/tags')).body.tags as any[]).find((t) => t.id === id);
    const metaNow = async (id: string) => JSON.parse((await tagNow(id))?.metadata || '{}');
    const openRows = (userId = 'tg-admin') => (sql.prepare('SELECT model, recordId FROM "OpenRecord" WHERE userId = ? ORDER BY model, recordId').all(userId) as any[]).map((r) => `${r.model}:${r.recordId}`);
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
    const bulkReplies: string[] = [];
    page.on('response', async (r: any) => { if (r.url().includes('/api/tags/bulk-metadata')) bulkReplies.push(`${r.status()} ${(await r.text().catch(() => '')).slice(0, 400)}`); });
    const requests: Array<{ method: string; url: string; body: string }> = [];
    page.on('request', (r: any) => { if (/\/api\/tags\b/.test(r.url()) && r.method() !== 'GET') requests.push({ method: r.method(), url: r.url().replace(base, ''), body: r.postData() || '' }); });
    // Событие «запись изменили» до экрана не доходит — как при обрыве связи: экран держит старую версию
    await page.addInitScript(() => {
      window.addEventListener('socket:entity:changed', (e) => { if ((window as any).__muteEntityEvents) e.stopImmediatePropagation(); }, true);
    });
    await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('input', { timeout: 90000 });
    const inputs = await page.$$('input');
    await inputs[0].fill('tg-admin'); await inputs[1].fill(password); await page.keyboard.press('Enter');
    await page.waitForSelector('[data-taskbar]', { timeout: 60000 });
    await page.evaluate(() => localStorage.setItem('max_active_project_tg-admin', JSON.stringify({ id: 'tg-p', name: 'Проект тегов' })));
    await page.goto(`${base}/#/registry`);
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
    const changesOf = (root: any) => root.locator('[data-conflict-change]').evaluateAll((els: Element[]) => els.map((el) => ({
      label: el.querySelector('.fx-conflict-field')!.textContent!.replace(/:$/, ''),
      was: el.querySelector('.fx-conflict-was')!.textContent,
      now: el.querySelector('.fx-conflict-now')!.textContent,
    })));
    const cardOf = (id: string) => page.locator(`#tag-card-${id}`);
    /** Действия карточки (настройка, удаление) видны только у развёрнутой */
    const expandCard = async (id: string) => {
      await cardOf(id).waitFor({ timeout: 60000 });
      await cardOf(id).getByTitle('Открыть комментарии тега').click();
    };
    const openCard = async (id: string) => {
      await expandCard(id);
      await cardOf(id).getByTitle('Настроить связи / свойства в модали').click();
      await page.getByRole('dialog').first().waitFor({ timeout: 15000 });
    };
    const box = (el: any) => el.evaluate((n: HTMLElement) => { const r = n.getBoundingClientRect(); const c = getComputedStyle(n); const p = (n.closest('[role=dialog]') || document.body).getBoundingClientRect(); return { fontSize: c.fontSize, inside: r.left >= p.left - 1 && r.right <= p.right + 1 && r.bottom <= p.bottom + 1 }; });
    await mute(true);

    // ── 1. Карточка тега ──
    console.log('1. Карточка тега');
    await openCard(made.ahu.id);
    await waitRows([`Tag:${made.ahu.id}`], 'карточка открыта — в базе строка OpenRecord этого человека');
    check('отметка свежая и принадлежит человеку за экраном', (sql.prepare('SELECT COUNT(*) AS n FROM "OpenRecord" WHERE userId = ? AND model = ? AND at >= ?').get('tg-admin', 'Tag', Date.now() - 30000) as any).n === 1);
    const seen = await tagNow(made.ahu.id);
    const theirs = await colleague('PUT', `/api/tags/${made.ahu.id}`, { brand: 'Beta', version: seen.updatedAt });
    check('коллега поправил марку того же тега', theirs.status === 200, theirs);
    const dialog = page.getByRole('dialog').first();
    const nameField = page.getByPlaceholder(/Напр\., Приточная/);
    await nameField.fill('Моё новое имя');
    await nameField.blur();
    const refusal = page.locator('[data-conflict-notice]');
    await refusal.waitFor({ timeout: 15000 });
    check('отказ — role="alert", в карточке, не в окне поверх', await refusal.getAttribute('role') === 'alert' && await page.locator('[data-refusal-dialog]').count() === 0);
    check('виден текст отказа сервера: тег изменили, правка не записана', /изменили/.test((await refusal.locator('[data-conflict-message]').textContent())!) && /не записана/.test((await refusal.locator('[data-conflict-message]').textContent())!), await refusal.textContent());
    same('виден перечень: марка была Acme, стала Beta', await changesOf(refusal), [{ label: 'Марка', was: 'Acme', now: 'Beta' }]);
    check('набранное в поле цело', await nameField.inputValue() === 'Моё новое имя');
    check('чужая правка цела, своя не записана', (await tagNow(made.ahu.id)).brand === 'Beta' && (await metaNow(made.ahu.id)).mainName === 'Имя AHU-1', await metaNow(made.ahu.id));
    const sizes = await box(refusal.locator('.fx-conflict-now'));
    check('отказ читается: кегль не мельче 12 px, помещается в окне', parseFloat(sizes.fontSize) >= 12 && sizes.inside, sizes);
    check('после отказа «Сохранено» не горит', await page.getByText('Сохранено', { exact: true }).evaluate((el: HTMLElement) => getComputedStyle(el).opacity === '0'));
    await shot('card-refusal');
    // Повтор после отказа: версия уже свежая, набранное записывается и чужая марка остаётся
    await nameField.focus(); await nameField.blur();
    const until = Date.now() + 15000;
    while (Date.now() < until && (await metaNow(made.ahu.id)).mainName !== 'Моё новое имя') await page.waitForTimeout(250);
    check('повтор тем же набранным проходит: имя человека записано, чужая марка не затёрта', (await metaNow(made.ahu.id)).mainName === 'Моё новое имя' && (await tagNow(made.ahu.id)).brand === 'Beta');
    await page.getByRole('button', { name: 'Готово' }).click();
    await waitRows([], 'карточка закрыта — строки OpenRecord этого человека нет');

    // ── 2. Удаление тега ──
    console.log('2. Удаление тега');
    // 2а. Тег открыт у коллеги
    const hold = await holdOpen([{ model: 'Tag', id: made.fan.id }]);
    check('Иванов держит FAN-2 открытым', hold.status === 200, hold);
    await page.reload(); await mute(true);
    await expandCard(made.fan.id);
    requests.length = 0;
    await cardOf(made.fan.id).getByTitle('Удалить тег с холста').click();
    await page.getByRole('button', { name: 'Удалить тег' }).click();
    const gate = page.locator('[data-refusal-dialog]');
    await gate.waitFor({ timeout: 15000 });
    const gateText = (await gate.textContent())!;
    check('окно называет коллегу по имени', gateText.includes('Иванов И. И.'), gateText);
    check('окно говорит, что тег открыт и удалить нельзя', /открыт/.test(gateText) && /нельзя/.test(gateText), gateText);
    check('экран отправил DELETE с целой версией записи', requests.some((r) => r.method === 'DELETE' && r.url === `/api/tags/${made.fan.id}?expectedVersion=${(sql.prepare('SELECT version FROM "Tag" WHERE id = ?').get(made.fan.id) as any).version}`), requests);
    check('тег цел в базе', !!(await tagNow(made.fan.id)));
    await shot('delete-open-refusal');
    await page.getByRole('button', { name: 'Понятно' }).click();
    await holdOpen([]);

    // 2б. Тег изменили, пока экран держал старую копию
    await page.reload(); await mute(true);
    await expandCard(made.valve.id);
    const valveSeen = await tagNow(made.valve.id);
    const valveTheirs = await colleague('PUT', `/api/tags/${made.valve.id}`, { wbs: '9.9', version: valveSeen.updatedAt });
    check('коллега поправил WBS клапана', valveTheirs.status === 200, valveTheirs);
    await cardOf(made.valve.id).getByTitle('Удалить тег с холста').click();
    await page.getByRole('button', { name: 'Удалить тег' }).click();
    const changedGate = page.locator('[data-refusal-dialog]');
    await changedGate.waitFor({ timeout: 15000 });
    same('окно показывает перечень: WBS был «—», стал 9.9', await changesOf(changedGate), [{ label: 'WBS', was: '—', now: '9.9' }]);
    check('тег не удалён', !!(await tagNow(made.valve.id)));
    await shot('delete-changed-refusal');
    await page.getByRole('button', { name: 'Понятно' }).click();

    // 2в. Нетронутый тег удаляется
    await expandCard(made.pump.id);
    await cardOf(made.pump.id).getByTitle('Удалить тег с холста').click();
    await page.getByRole('button', { name: 'Удалить тег' }).click();
    const gone = Date.now() + 15000;
    while (Date.now() < gone && await tagNow(made.pump.id)) await page.waitForTimeout(250);
    check('нетронутый тег удалён', !(await tagNow(made.pump.id)));
    check('окна отказа нет', await page.locator('[data-refusal-dialog]').count() === 0);

    // ── 3. «Закупки»: массовый этап по устаревшим данным ──
    console.log('3. «Закупки»');
    await page.goto(`${base}/#/management`);
    await page.reload(); await mute(true);
    await page.getByText('AHU-1', { exact: true }).first().waitFor({ timeout: 60000 });
    await page.locator('thead input[type=checkbox]').check();
    const filterSeen = await tagNow(made.filter.id);
    const procTheirs = await colleague('PATCH', `/api/tags/${made.filter.id}/procurement`, { procurement: { stage: 'ordered', supplier: 'Поставщик К' }, version: filterSeen.updatedAt });
    check('коллега записал закупку FLT-6', procTheirs.status === 200, procTheirs);
    requests.length = 0;
    await page.locator('.fx-tools', { hasText: 'Выбрано' }).getByRole('button', { name: /Куплен/ }).click();
    const bulk = page.locator('[data-refusal-dialog]');
    await bulk.waitFor({ timeout: 15000 }).catch((e: Error) => { throw new Error(`${e.message}\nответы bulk-metadata: ${JSON.stringify(bulkReplies)}\nзапросы: ${JSON.stringify(requests).slice(0, 600)}`); });
    const groups = await bulk.locator('[data-conflict-group] .fx-conflict-group').allTextContents();
    same('перечень по записям: только FLT-6', groups, ['FLT-6']);
    const bulkChanges = await changesOf(bulk);
    check('в перечне — этап и поставщик коллеги', bulkChanges.some((c: any) => c.label === 'Этап закупки' && c.now === 'Заказан') && bulkChanges.some((c: any) => c.label === 'Поставщик' && c.now === 'Поставщик К'), bulkChanges);
    check('экран отправил версии записей', requests.length === 1 && JSON.parse(requests[0].body).updates.every((u: any) => typeof u.version === 'string'), requests);
    const stages = [] as string[];
    for (const t of (await colleague('GET', '/api/projects/tg-p/tags')).body.tags as any[]) stages.push(`${t.identifier}:${JSON.parse(t.metadata || '{}').procurement?.stage ?? ''}`);
    check('ничего не записано: ни один тег не получил этап «Куплен», у FLT-6 — этап коллеги', !stages.some((s) => s.endsWith(':purchased')) && stages.includes('FLT-6:ordered'), stages);
    await shot('bulk-refusal');
    await page.getByRole('button', { name: 'Понятно' }).click();
    // Данные перечитаны: повтор по новым данным проходит
    await page.getByText('Поставщик К').first().waitFor({ timeout: 15000 }).catch(() => undefined);
    await page.locator('thead input[type=checkbox]').check().catch(() => undefined);
    const selected = await page.getByText(/Выбрано: \d+/).count();
    if (!selected) await page.locator('thead input[type=checkbox]').check();
    await page.locator('.fx-tools', { hasText: 'Выбрано' }).getByRole('button', { name: /Куплен/ }).click();
    const retryUntil = Date.now() + 15000; let after: string[] = [];
    while (Date.now() < retryUntil) {
      after = ((await colleague('GET', '/api/projects/tg-p/tags')).body.tags as any[]).map((t) => `${t.identifier}:${JSON.parse(t.metadata || '{}').procurement?.stage ?? ''}`);
      if (after.filter((s) => s.endsWith(':purchased')).length === after.length) break;
      await page.waitForTimeout(250);
    }
    check('повтор по свежим данным проходит: этап записан всем', after.every((s) => s.endsWith(':purchased')), after);

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
