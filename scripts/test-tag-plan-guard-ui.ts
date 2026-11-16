/**
 * Мастер импорта тегов, разбор захвата и связи строк ВДР против настоящей службы: запись по
 * устаревшему предпросмотру не пишет ничего, окно называет, что изменили, и ждёт нового подтверждения
 * (строка 5 очерёдности, .claude/progress/bulk-plan-guard.md; решения владельца 15 ноября 2026, п. 3 и п. 7).
 *
 * Поднимается настоящий server.ts на свободном порту с одноразовой базой; маршруты не подменяются
 * (кроме одного ответа ввоза ВДР — см. п. 4). Окно открыто и показывает предпросмотр; пока человек
 * его смотрит, «коллега» пишет те же записи вторым запросом (токен другого входа). Проверяется:
 *   1. Мастер импорта: коллега поправил марку тега, который ввоз обновит, — окно показывает перечень
 *      «Марка: Acme → Beta», в базе не записано ничего (ни обновлений, ни нового тега), запрос ушёл с
 *      `seen`; коллега завёл тег, которого предпросмотр не видел, — отказ называет его; после нового
 *      предпросмотра и нового подтверждения запись проходит.
 *   2. Разбор захвата, применение: коллега поправил дополняемый тег — окно в плане показывает перечень,
 *      созданного нет, строка изменённого тега пришла со снятой отметкой; человек отмечает её заново —
 *      записывается.
 *   3. Разбор захвата, отмена: коллега поправил дополненный тег — отмена не пишет «до» поверх его правки и
 *      не удаляет созданное, отчёт показывает перечень; повтор подтверждает отмену.
 *   4. Связи строк ВДР: коллега изменил строку после применения — отмена связывания показывает перечень и
 *      не снимает связей; повтор снимает. Ввоз файла ВДР: ответ-отказ 409 (подставлен) показан окном с перечнем.
 * Снимки отказов в обеих темах — в каталог FLUX_PLAN_SHOTS (по умолчанию /tmp/t-shots).
 *
 * Мутации, которыми набор проверен (каждая роняет его; результат — в отчёте исполнителя): мастер не шлёт
 * `seen`; мастер не показывает перечень; захват не шлёт `seen`; отмена захвата не шлёт `seen`;
 * применение не оставляет отметку снятой у изменённой строки; диалог связей не шлёт `seen` и не показывает перечень.
 *
 * Запуск: npx tsx scripts/test-tag-plan-guard-ui.ts   (нужен браузер: FLUX_CHROME или /opt/pw-browsers)
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
const SHOTS = process.env.FLUX_PLAN_SHOTS || '/tmp/t-shots';
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
  const XLSX = require('xlsx');
  fs.mkdirSync(SHOTS, { recursive: true });

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-plan-guard-'));
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
    user.run('pg-admin', 'pg-admin', 'Инженер', hash, 'ADMIN', '{}');
    user.run('pg-petrova', 'pg-petrova', 'Петрова А. А.', hash, 'ADMIN', '{}');
    sql.prepare('INSERT INTO "Project" (id, name) VALUES (?, ?)').run('pg-p', 'Проект плана');
    sql.prepare('INSERT INTO "ProjectMember" (id, projectId, userId) VALUES (?, ?, ?)').run('pg-m1', 'pg-p', 'pg-admin');
    sql.prepare('INSERT INTO "ProjectMember" (id, projectId, userId) VALUES (?, ?, ?)').run('pg-m2', 'pg-p', 'pg-petrova');

    const loginAs = async (symbol: string) => {
      const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol, password }) });
      assert.equal(login.status, 200, `вход ${symbol}`);
      const token = ((await login.json()) as any).token as string;
      return async (method: string, url: string, body?: unknown) => {
        const r = await fetch(`${base}${url}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
      };
    };
    // «Коллега» — Петрова: правит те же записи, что и человек за экраном
    const colleague = await loginAs('pg-petrova');

    // Теги заводим настоящим маршрутом
    const made: Record<string, any> = {};
    let slot = 0;
    const mkTag = async (key: string, code: string, brand: string) => {
      const r = await colleague('POST', '/api/projects/pg-p/tags', { identifier: code, brand, department: '', metadata: { x: 80 + (slot % 3) * 340, y: 80 + Math.floor(slot / 3) * 330, mainName: `Имя ${code}`, connections: [], descriptions: [] } });
      assert.equal(r.status, 200, `тег ${code}: ${JSON.stringify(r.body)}`);
      made[key] = r.body.tag; slot++;
    };
    await mkTag('ahu', 'AHU-1', 'Acme');
    await mkTag('fan', 'FAN-2', '');
    await mkTag('valve', 'VLV-3', 'Acme');
    const tagsNow = async () => (await colleague('GET', '/api/projects/pg-p/tags')).body.tags as any[];
    const tagNow = async (id: string) => (await tagsNow()).find((t) => t.id === id);
    const byCode = async (code: string) => (await tagsNow()).find((t) => t.identifier === code);
    const edit = async (id: string, body: Record<string, unknown>) => {
      const seen = await tagNow(id);
      const r = await colleague('PUT', `/api/tags/${id}`, { ...body, version: seen.updatedAt });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    };

    // ── Браузер ──
    browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const pageErrors: string[] = [];
    page.on('pageerror', (e: Error) => pageErrors.push(e.message));
    const posted: Array<{ url: string; body: any }> = [];
    page.on('request', (r: any) => {
      if (r.method() === 'POST' && /tags\/(bulk-import|capture-apply|capture-undo)|tag-links\/undo/.test(r.url())) {
        let body: any = null; try { body = JSON.parse(r.postData() || 'null'); } catch { /* не JSON */ }
        posted.push({ url: r.url().replace(base, ''), body });
      }
    });
    // Захвата с экрана в браузере нет: оболочка подкладывается заглушкой только при метке в хранилище
    // Скрипт — строкой: сборка набора подкладывает в именованные функции вспомогательную, которой в странице нет
    await page.addInitScript({ content: `
      window.addEventListener('socket:entity:changed', function (e) { if (window.__mute) e.stopImmediatePropagation(); }, true);
      window.addEventListener('socket:vdr:changed', function (e) { if (window.__mute) e.stopImmediatePropagation(); }, true);
      try {
        if (localStorage.getItem('__fake_capture')) {
          window.electron = { capture: {
            start: function () {}, onReady: function () { return function () {}; },
            takePending: function () { var v = localStorage.getItem('__fake_capture'); return Promise.resolve(v ? JSON.parse(v) : null); },
          } };
        }
      } catch (e) { /* хранилища нет */ }
    ` });
    await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('input', { timeout: 90000 });
    const inputs = await page.$$('input');
    await inputs[0].fill('pg-admin'); await inputs[1].fill(password); await page.keyboard.press('Enter');
    await page.waitForSelector('[data-taskbar]', { timeout: 60000 });
    await page.evaluate(() => localStorage.setItem('max_active_project_pg-admin', JSON.stringify({ id: 'pg-p', name: 'Проект плана' })));
    const mute = () => page.evaluate(() => { (window as any).__mute = true; });
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
    const groupsOf = (root: any) => root.locator('[data-conflict-group] .fx-conflict-group').allTextContents();
    /** Помещается ли отказ в окне и читается ли: кегль не мельче 12 px */
    const legible = (root: any) => root.evaluate((el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      const note = el.querySelector('.fx-conflict-now, .fx-conflict-message') as HTMLElement | null;
      return { inside: r.left >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight + 1, fontSize: note ? parseFloat(getComputedStyle(note).fontSize) : 0 };
    });

    // ── 1. Мастер импорта ──
    console.log('1. Мастер импорта');
    await page.goto(`${base}/#/registry`);
    await page.reload(); await mute();
    await page.getByRole('tab', { name: /Экспорт и импорт/ }).click();
    await page.locator('[data-tour="tag-import-btn"]').click();
    await page.getByRole('button', { name: /Вставить из буфера/ }).click();
    const table = ['Код тега\tМарка\tНаименование', 'AHU-1\tNewBrand\tПриточная', 'FAN-2\tZed\tВентилятор', 'NEW-1\tN1\tНовый'].join('\n');
    await page.locator('textarea').fill(table);
    await page.getByRole('button', { name: 'Разобрать' }).click();
    const importBtn = page.getByRole('button', { name: /Импортировать/ });
    await importBtn.waitFor({ timeout: 15000 });
    await page.waitForFunction(() => /Готово к импорту: 3/.test(document.body.innerText), null, { timeout: 15000 });
    const dupTitle = page.getByText('Такие теги уже есть');

    // 1а. Коллега правит тег, который ввоз обновит, пока окно «Такие теги уже есть» открыто
    await importBtn.click();
    await dupTitle.waitFor({ timeout: 20000 });
    await edit(made.ahu.id, { brand: 'Beta' });
    const worldBefore = JSON.stringify((await tagsNow()).map((t) => [t.id, t.brand, t.version]));
    posted.length = 0;
    await page.getByRole('button', { name: /Объединить/ }).click();
    const refusal = page.locator('[data-refusal-dialog]');
    await refusal.waitFor({ timeout: 20000 });
    check('отказ — role="alert", окно с перечнем', await refusal.locator('[data-conflict-notice]').getAttribute('role') === 'alert');
    check('текст: ничего не записано, проверьте и подтвердите заново', /Ничего не записано/.test((await refusal.locator('[data-conflict-message]').textContent())!) && /подтвердите заново/.test((await refusal.locator('[data-conflict-message]').textContent())!));
    same('перечень по записям: только AHU-1', await groupsOf(refusal), ['AHU-1']);
    same('перечень: марка была Acme, стала Beta', await changesOf(refusal), [{ label: 'Марка', was: 'Acme', now: 'Beta' }]);
    const sizes = await legible(refusal);
    check('отказ читается: кегль не мельче 12 px, помещается в окне', sizes.fontSize >= 12 && sizes.inside, sizes);
    const sent = posted.find((p) => p.url.endsWith('/tags/bulk-import'));
    check('запрос ушёл с версиями тегов, которые ввоз тронет (AHU-1 и FAN-2), и без лишних',
      !!sent && Object.keys(sent.body.seen || {}).sort().join() === [made.ahu.id, made.fan.id].sort().join()
      && sent.body.seen[made.ahu.id] === made.ahu.version && sent.body.seen[made.fan.id] === made.fan.version, sent?.body?.seen);
    check('в базе не записано ничего: ни обновлений, ни нового тега NEW-1', JSON.stringify((await tagsNow()).map((t) => [t.id, t.brand, t.version])) === worldBefore && !(await byCode('NEW-1')));
    await shot('wizard-refusal');
    await page.getByRole('button', { name: 'Понятно' }).click();
    check('мастер остался открыт, повтор — новым предпросмотром', await importBtn.isVisible());

    // 1б. Предпросмотр заново; пока окно открыто, коллега заводит тег, которого предпросмотр не видел
    await importBtn.click();
    await dupTitle.waitFor({ timeout: 20000 });
    const created = await colleague('POST', '/api/projects/pg-p/tags', { identifier: 'NEW-1', brand: 'Чужой', metadata: { x: 900, y: 80, connections: [], descriptions: [] } });
    check('коллега завёл NEW-1', created.status === 200, created);
    await page.getByRole('button', { name: /Объединить/ }).click();
    await refusal.waitFor({ timeout: 20000 });
    same('перечень по записям: только NEW-1', await groupsOf(refusal), ['NEW-1']);
    same('перечень: тега не было, появился после предпросмотра', await changesOf(refusal), [{ label: 'Тег', was: 'не было', now: 'появился после предпросмотра' }]);
    check('чужой тег не обновлён молча, FAN-2 не тронут', (await byCode('NEW-1')).brand === 'Чужой' && !(await byCode('FAN-2')).brand);
    await shot('wizard-appeared');
    await page.getByRole('button', { name: 'Понятно' }).click();

    // 1в. Третий предпросмотр показывает всё, что есть, и подтверждение записывает
    await importBtn.click();
    await dupTitle.waitFor({ timeout: 20000 });
    check('совпадения теперь три: AHU-1, FAN-2, NEW-1', /AHU-1.*FAN-2.*NEW-1|NEW-1.*AHU-1.*FAN-2/.test(await page.locator('.font-mono').filter({ hasText: 'AHU-1' }).first().textContent() || ''));
    await page.getByRole('button', { name: /Объединить/ }).click();
    await page.getByText('Импорт завершён').waitFor({ timeout: 20000 });
    check('повтор по свежим данным записал: марки из файла у всех трёх', (await byCode('AHU-1')).brand === 'NewBrand' && (await byCode('FAN-2')).brand === 'Zed' && (await byCode('NEW-1')).brand === 'N1');
    await page.getByRole('button', { name: 'Готово' }).click();

    // ── 2–3. Разбор захвата ──
    console.log('2. Разбор захвата: применение');
    // План: FAN-2 дополняется (марка пуста у существующего — но к этому моменту она «Zed»), поэтому готовим свежие данные
    await colleague('PUT', `/api/tags/${made.valve.id}`, { brand: '', version: (await tagNow(made.valve.id)).updatedAt });
    const capture = { items: [{ kind: 'table', text: 'Код тега\tМарка\nVLV-3\tOmega\nNEW-9\tQ9', html: '', image: '', truncated: 0, at: Date.now() }] };
    await page.evaluate((c: unknown) => localStorage.setItem('__fake_capture', JSON.stringify(c)), capture);
    await page.goto(`${base}/#/registry`);
    await page.reload(); await mute();
    const review = page.getByRole('dialog', { name: 'Разбор захвата' });
    await review.waitFor({ timeout: 30000 }).catch(async (e: Error) => {
      await page.screenshot({ path: path.join(SHOTS, 'debug-capture.png') });
      throw new Error(`${e.message}\nстенд: ${JSON.stringify(await page.evaluate(() => ({ electron: typeof (window as any).electron, mark: localStorage.getItem('__fake_capture'), take: typeof (window as any).electron?.capture?.takePending })))}\nтекст страницы: ${(await page.locator('body').innerText()).slice(0, 100)}\nошибки: ${JSON.stringify(pageErrors)}`);
    });
    // Захват забирается при каждом показе окна, пока метка в хранилище есть (разработческий режим монтирует окно дважды)
    await page.evaluate(() => localStorage.removeItem('__fake_capture'));
    await review.getByRole('button', { name: /Далее/ }).click();
    await review.getByText('План захвата: теги').waitFor({ timeout: 15000 });
    const planRow = (code: string) => review.locator('tr', { hasText: code });
    check('в плане: VLV-3 — «дубль, есть новое» (дополнить), NEW-9 — новый (создать)', /дубль, есть новое/.test(await planRow('VLV-3').textContent() || '') && /новый/.test(await planRow('NEW-9').textContent() || ''));

    // Коллега правит дополняемый тег, пока человек смотрит план
    await edit(made.valve.id, { department: 'ВК' });
    posted.length = 0;
    await review.getByRole('button', { name: 'Применить' }).click();
    const planNotice = review.locator('[data-conflict-notice]');
    await planNotice.waitFor({ timeout: 20000 });
    same('перечень по записям: только VLV-3', await groupsOf(planNotice), ['VLV-3']);
    same('перечень: отдел был «—», стал ВК', await changesOf(planNotice), [{ label: 'Отдел', was: '—', now: 'ВК' }]);
    const applySent = posted.find((p) => p.url.endsWith('/tags/capture-apply'));
    check('запрос применения ушёл с версией дополняемого тега и только с ней', !!applySent && Object.keys(applySent.body.seen || {}).join() === made.valve.id, applySent?.body?.seen);
    check('в базе не записано ничего: NEW-9 не создан, марка VLV-3 пуста', !(await byCode('NEW-9')) && !(await byCode('VLV-3')).brand);
    const isOn = (code: string) => planRow(code).locator('td').first().locator('button').evaluate((b: HTMLElement) => b.className.includes('bg-emerald-600'));
    check('строка изменённого тега пришла со снятой отметкой, строка нового тега осталась отмеченной', !(await isOn('VLV-3')) && (await isOn('NEW-9')));
    const sz = await legible(planNotice);
    check('отказ читается: кегль не мельче 12 px, помещается в окне', sz.fontSize >= 12 && sz.inside, sz);
    await shot('capture-apply-refusal');
    check('кнопка «Применить» доступна: NEW-9 отмечен', await review.getByRole('button', { name: 'Применить' }).isEnabled());

    // Человек прочёл перечень и отмечает VLV-3 заново
    await planRow('VLV-3').locator('td').first().locator('button').first().click();
    posted.length = 0;
    await review.getByRole('button', { name: 'Применить' }).click();
    await review.getByText('Захват применён').waitFor({ timeout: 20000 });
    check('после нового подтверждения записано: NEW-9 создан, марка VLV-3 дополнена, отдел коллеги цел',
      (await byCode('NEW-9')).brand === 'Q9' && (await byCode('VLV-3')).brand === 'Omega' && (await byCode('VLV-3')).department === 'ВК');
    const retry = posted.find((p) => p.url.endsWith('/tags/capture-apply'));
    check('повторный запрос — с новой версией тега (после правки коллеги)', !!retry && retry.body.seen[made.valve.id] === (await byCode('VLV-3')).version - 1, retry?.body?.seen);

    console.log('3. Разбор захвата: отмена');
    await edit(made.valve.id, { wbs: '5.5' });
    posted.length = 0;
    await review.getByRole('button', { name: 'Отменить захват' }).click();
    const undoNotice = review.locator('[data-conflict-notice]');
    await undoNotice.waitFor({ timeout: 20000 });
    same('отчёт показывает перечень по записям: VLV-3', await groupsOf(undoNotice), ['VLV-3']);
    same('перечень: WBS был «—», стал 5.5', await changesOf(undoNotice), [{ label: 'WBS', was: '—', now: '5.5' }]);
    const undoSent = posted.find((p) => p.url.endsWith('/tags/capture-undo'));
    check('запрос отмены ушёл с версиями записанных тегов (VLV-3 и созданного NEW-9)', !!undoSent && Object.keys(undoSent.body.seen || {}).length === 2, undoSent?.body?.seen);
    check('отмена не записала ничего: NEW-9 цел, марка VLV-3 и WBS коллеги на месте', !!(await byCode('NEW-9')) && (await byCode('VLV-3')).brand === 'Omega' && (await byCode('VLV-3')).wbs === '5.5');
    await shot('capture-undo-refusal');
    await review.getByRole('button', { name: 'Отменить захват' }).click();
    await review.waitFor({ state: 'detached', timeout: 20000 });
    check('повтор после перечня отменяет: NEW-9 удалён, марка VLV-3 возвращена', !(await byCode('NEW-9')) && !(await byCode('VLV-3')).brand);

    // ── 4. Связи строк ВДР ──
    console.log('4. Связи строк ВДР');
    const reg = await colleague('POST', '/api/vdr/registers', { projectId: 'pg-p', name: 'ВДР плана' });
    const REG = reg.body.register.id as string;
    // Строки заводятся раньше тегов: связей по id у них ещё нет, и план переноса есть что связывать
    const mkItem = async (no: string, titleRu: string, code: string) => (await colleague('POST', '/api/vdr/items', { registerId: REG, contractorNo: no, titleRu, equipmentTags: JSON.stringify([code]) })).body.item.id as string;
    const I1 = await mkItem('ДОК-1', 'Общий вид', 'LNK-1'); const I2 = await mkItem('ДОК-2', 'Схема узла', 'LNK-2');
    await mkTag('l1', 'LNK-1', ''); await mkTag('l2', 'LNK-2', '');
    check('служба завела реестр, две строки и два тега', !!REG && !!I1 && !!I2);
    await page.goto(`${base}/#/docflow?tab=registry&vdr=${REG}`);
    await page.reload(); await mute();
    await page.locator('tr', { hasText: 'ДОК-1' }).first().waitFor({ timeout: 30000 });
    const planNow = (await colleague('GET', '/api/vdr/tag-links?projectId=pg-p')).body.plan;
    check('план переноса на сервере: две связи к созданию', planNow?.toLink?.length === 2, planNow);
    await page.getByRole('button', { name: /Связать теги: 2/ }).click();
    const linkDialog = page.getByRole('dialog', { name: 'Связи строк ВДР с тегами' });
    await linkDialog.getByRole('button', { name: /Связать: 2/ }).click();
    await linkDialog.getByRole('button', { name: 'Отменить связывание' }).waitFor({ timeout: 20000 });
    const links = () => (sql.prepare('SELECT COUNT(*) AS n FROM "DocRegisterItemTag"').get() as any).n as number;
    check('связи созданы', links() === 2);
    const stamp = async (id: string): Promise<string> => (await colleague('GET', `/api/vdr/items?registerId=${REG}`)).body.items.find((i: any) => i.id === id).updatedAt;
    const colleagueItem = await colleague('PUT', `/api/vdr/items/${I1}`, { titleRu: 'Общий вид (правка)', expectedUpdatedAt: await stamp(I1) });
    check('коллега поправил название строки ДОК-1', colleagueItem.status === 200, colleagueItem);
    posted.length = 0;
    await linkDialog.getByRole('button', { name: 'Отменить связывание' }).click();
    const linkNotice = linkDialog.locator('[data-conflict-notice]');
    await linkNotice.waitFor({ timeout: 20000 });
    same('отмена: перечень по строкам — ДОК-1', await groupsOf(linkNotice), ['ДОК-1']);
    same('отмена: название было «Общий вид», стало «Общий вид (правка)»', await changesOf(linkNotice), [{ label: 'Наименование (рус)', was: 'Общий вид', now: 'Общий вид (правка)' }]);
    const linkSent = posted.find((p) => p.url.endsWith('/tag-links/undo'));
    check('запрос отмены ушёл с версиями обеих строк', !!linkSent && Object.keys(linkSent.body.seen || {}).sort().join() === [I1, I2].sort().join(), linkSent?.body?.seen);
    check('связи не сняты', links() === 2);
    await shot('vdr-links-undo-refusal');
    await linkDialog.getByRole('button', { name: 'Отменить связывание' }).click();
    const unlinked = Date.now() + 15000;
    while (Date.now() < unlinked && links() !== 0) await page.waitForTimeout(250);
    check('повтор после перечня снимает связи', links() === 0);
    await linkDialog.getByRole('button', { name: 'Закрыть' }).last().click();

    // Ввоз файла ВДР: отказ приходит ответом сервера (подставлен — гонку внутри транзакции в браузере не поставить;
    // настоящий отказ проверяет набор маршрутов), экран показывает окно с перечнем по строкам
    const itemNow = (await colleague('GET', `/api/vdr/items?registerId=${REG}`)).body.items.find((i: any) => i.id === I2);
    await page.route('**/api/vdr/import', (route: any) => route.fulfill({
      status: 409, contentType: 'application/json',
      body: JSON.stringify({ error: 'Пока шёл ввоз, часть строк реестра изменили. Ничего не записано. Ниже — что изменилось; проверьте и повторите ввоз.', code: 'VERSION_CONFLICT', changed: [{ id: I2, current: { ...itemNow, titleRu: 'Схема узла (новая)', version: (itemNow.version || 1) + 1 } }], gone: [] }),
    }));
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Contractor Document No', 'Russian Title', 'English Title', 'Rev'], ['ДОК-2', 'Схема узла', 'Node', 'A']]), 'Register');
    await page.getByRole('button', { name: 'Импорт', exact: true }).locator('xpath=following-sibling::input[@type="file"]').setInputFiles({ name: 'ВДР.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) });
    const importRefusal = page.locator('[data-refusal-dialog]');
    await importRefusal.waitFor({ timeout: 20000 }).catch(async (e: Error) => {
      await page.screenshot({ path: path.join(SHOTS, 'debug-import.png') });
      throw new Error(`${e.message}\nфайловых полей: ${await page.locator('input[type=file]').count()}\nошибки: ${JSON.stringify(pageErrors)}\nтекст: ${(await page.locator('body').innerText()).slice(0, 400)}`);
    });
    same('ввоз ВДР: перечень по строкам — ДОК-2', await groupsOf(importRefusal), ['ДОК-2']);
    same('ввоз ВДР: название было «Схема узла», стало «Схема узла (новая)»', await changesOf(importRefusal), [{ label: 'Наименование (рус)', was: 'Схема узла', now: 'Схема узла (новая)' }]);
    check('ввоз ВДР: текст отказа про ввоз', /ввоз/i.test((await importRefusal.locator('[data-conflict-message]').textContent())!));
    await shot('vdr-import-refusal');
    await page.getByRole('button', { name: 'Понятно' }).click();

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
