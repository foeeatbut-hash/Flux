/**
 * Обновление выбранным в настоящей службе и настоящем окне: подразделение, перевод туда и обратно, обязательный возврат версии.
 *
 * 1. Назначение подразделению: значок у участника появляется сам, у постороннего его нет; переведённый в подразделение
 *    получает обновление, выведенный — теряет его (события сервера, без перезапуска и без ожидания опроса).
 * 2. Возврат предыдущей версии: у компьютера (заглушка главного процесса, остальное настоящее: сервер, сокет, хранилища окна)
 *    подписанное задание с rollback доходит до окна; в окне нет «Позже», версия ставится по заданию (rollback и номер задания
 *    уходят главному процессу).
 *
 * Сервер — из исходников с FLUX_TEST_OWNER=1 и FLUX_TEST_UPDATE_KEY=1. Запуск:
 *   FLUX_API=http://localhost:3411 FLUX_USER=… FLUX_PASS=… npx tsx scripts/test-update-assign-ui.ts
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { testCredentials } from './testCredentials';
import { ownerTestLogin } from './fixtures/ownerTestLogin';
import { testSignature } from './fixtures/updateTestSign';
import { findChrome } from './chromePath';
import { signCampaign } from '../studio/owner/src/campaigns';
import { signUpdateEnvelope, verifiedDeviceChain } from '../electron/updateCommand';

const BASE = process.env.FLUX_API || 'http://localhost:3000';
const ADMIN = testCredentials();
const SHOTS = process.env.FLUX_SHOTS || '/tmp/u7-shots';
const STAMP = Date.now() % 1_000_000;
const LOW = `998.0.${STAMP}`, HIGH = `998.1.${STAMP}`;
const PASSWORD = 'update-assign-ui-test-only';
const TEST_KEY_HEX = '9d155f2aa7bb2b9ec4b8e271c8181cd9d289b2c4e264fec77848963e1a6b0215';

let failed = 0;
const ok = (name: string, value: unknown, detail?: unknown) =>
  value ? console.log('  ✓', name) : (failed++, console.error('  ✗', name, detail !== undefined ? JSON.stringify(detail).slice(0, 240) : ''));

const api = async (token: string, method: string, url: string, body?: unknown, raw?: Buffer) => {
  const res = await fetch(BASE + url, {
    method, headers: { ...(raw ? { 'Content-Type': 'application/octet-stream' } : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: raw ? new Uint8Array(raw) : body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  try { return { status: res.status, json: JSON.parse(text) }; } catch { return { status: res.status, json: null as any }; }
};

(async () => {
  const { chromium } = await import('playwright-core');
  const health = await fetch(BASE + '/api/health').catch(() => null);
  if (!health?.ok) { console.error(`Сервер на ${BASE} не отвечает.`); process.exit(2); }
  const adminToken = (await api('', 'POST', '/api/login', ADMIN)).json?.token || '';
  if (!adminToken) { console.error('Не удалось войти тестовым администратором.'); process.exit(2); }
  const owner = await ownerTestLogin(BASE), ownerToken = owner.token;

  const made: Record<string, { id: string; symbol: string; token: string }> = {};
  for (const who of ['a', 'b', 'c']) {
    const symbol = `upd-as-${who}-${STAMP}`;
    const created = await api(adminToken, 'POST', '/api/users', { symbol, lastName: `Проверкин${who.toUpperCase()}`, firstName: 'Назначение', role: 'ENGINEER_VENT', password: PASSWORD });
    const id = created.json?.id || created.json?.user?.id || '';
    if (!id) { console.error('Не удалось создать сотрудника.', created.status, created.json); process.exit(2); }
    made[who] = { id, symbol, token: (await api('', 'POST', '/api/login', { symbol, password: PASSWORD })).json?.token || '' };
  }
  const departments: string[] = [];
  let browser: any;
  try {
    // Два выпуска: ниже и выше
    for (const version of [LOW, HIGH]) {
      const exe = Buffer.alloc(6 * 1024 * 1024, 5); exe[0] = 0x4d; exe[1] = 0x5a; exe.write(`U7-${version}`, exe.length - 40, 'utf8');
      const up = await api(ownerToken, 'POST', `/api/updates/upload?version=${version}`, undefined, exe);
      const pub = await api(ownerToken, 'POST', '/api/updates', { version, generation: up.json?.generation, changelog: `Изменения ${version}`, signature: testSignature(exe, version) });
      ok(`выпуск ${version} опубликован`, pub.status === 200, pub.json || pub.status);
    }
    const unit = await api(ownerToken, 'POST', '/api/departments', { name: `Проверка обновлений ${STAMP}` });
    const other = await api(ownerToken, 'POST', '/api/departments', { name: `Другое ${STAMP}` });
    departments.push(unit.json?.id, other.json?.id);
    ok('подразделения созданы', !!unit.json?.id && !!other.json?.id, [unit.status, unit.json]);
    const move = (who: string, departmentId: string) => api(ownerToken, 'POST', '/api/departments/assign', { userIds: [made[who].id], departmentId, reason: 'проверка обновлений' });
    ok('участник A переведён в подразделение, посторонний B — в другое', (await move('a', unit.json.id)).status === 200 && (await move('b', other.json.id)).status === 200);

    browser = await chromium.launch({ executablePath: findChrome(), args: ['--no-sandbox'] });
    const errors: string[] = [];
    const open = async (who: string, init?: string) => {
      const page = await browser.newPage({ viewport: { width: 1500, height: 940 } });
      page.on('pageerror', (e: any) => errors.push(`${who}: исключение ${String(e.message).slice(0, 160)}`));
      page.on('console', (m: any) => { if (m.type() === 'error') errors.push(`${who}: консоль ${m.text().slice(0, 160)}`); });
      if (init) await page.addInitScript(init);
      await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const input = page.locator('input').first();
      if (await input.isVisible().catch(() => false)) {
        await input.fill(made[who].symbol); await page.locator('input[type="password"]').first().fill(PASSWORD); await page.keyboard.press('Enter'); await page.waitForTimeout(5000);
      }
      return page;
    };
    const badgeOf = (page: any) => page.locator('button[title*="обновление v"], button[title^="Владелец вернул версию"]').first();
    const appears = async (page: any, ms = 8000) => { await badgeOf(page).waitFor({ state: 'visible', timeout: ms }).catch(() => {}); return badgeOf(page).isVisible().catch(() => false); };
    const vanishes = async (page: any, ms = 8000) => { await badgeOf(page).waitFor({ state: 'hidden', timeout: ms }).catch(() => {}); return !(await badgeOf(page).isVisible().catch(() => false)); };

    console.log('1. Назначение подразделению: участник, посторонний, перевод туда и обратно');
    const pageA = await open('a'), pageB = await open('b');
    await pageA.waitForTimeout(2000);
    ok('до назначения значка нет ни у кого', !(await badgeOf(pageA).isVisible().catch(() => false)) && !(await badgeOf(pageB).isVisible().catch(() => false)));
    const assigned = await api(ownerToken, 'POST', '/api/updates/assignments', { version: HIGH, departmentIds: [unit.json.id] });
    ok('владелец назначил обновление подразделению', assigned.status === 200 && !!assigned.json?.id, assigned.json || assigned.status);
    ok('у участника подразделения значок появился за секунды', await appears(pageA));
    await pageB.waitForTimeout(3000);
    ok('у постороннего значка нет', !(await badgeOf(pageB).isVisible().catch(() => false)));
    ok('перевод в подразделение уже после назначения: обновление получено', (await move('b', unit.json.id)).status === 200 && await appears(pageB));
    await pageB.screenshot({ path: path.join(SHOTS, 'update-assign-light-member.png') });
    ok('вывод из подразделения: значок исчез', (await move('b', other.json.id)).status === 200 && await vanishes(pageB));
    await api(ownerToken, 'POST', `/api/updates/assignments/${assigned.json.id}/cancel`, {});
    ok('отмена назначения убрала значок у участника', await vanishes(pageA));
    await pageA.close(); await pageB.close();

    console.log('2. Возврат предыдущей версии: обязательное, без «Позже», по подписанному заданию');
    const device = crypto.generateKeyPairSync('ed25519'), deviceId = crypto.randomUUID();
    const deviceHex = (device.publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('hex');
    const proofOf = (a: any) => ({ publicKey: deviceHex, proof: signUpdateEnvelope('FLUXUPDDEVICE1', { deviceId, userId: a.userId, version: HIGH, platform: 'win32', arch: 'x64',
      status: a.status, commandId: a.commandId, code: a.code || '', at: Date.now() }, device.privateKey) });
    const acceptOf = (a: any) => {
      const latest = verifiedDeviceChain(a.commands, { inst: a.inst, deviceId, userId: a.userId, keyHex: TEST_KEY_HEX });
      return latest ? { ...latest.command, remainingMs: Math.max(0, latest.command.deadline - Date.now()) } : null;
    };
    const mock = `(() => {
      window.__calls = [];
      window.electron = {
        isPackaged: async () => true, isPortable: async () => ({ portable: true }), getAppVersion: async () => ${JSON.stringify(HIGH)},
        onUpdaterStatus: () => {}, onUpdaterError: () => {},
        updateHeartbeatProof: async a => window.__u7proof(a), acceptUpdateCommands: async a => window.__u7accept(a),
        startDownload: async p => { window.__calls.push(['startDownload', p]); return { success: true }; },
        quitAndInstall: async id => { window.__calls.push(['quitAndInstall', id]); return { success: true }; },
      };
    })();`;
    const pageC = await browser.newPage({ viewport: { width: 1500, height: 940 } });
    pageC.on('pageerror', (e: any) => errors.push(`c: исключение ${String(e.message).slice(0, 160)}`));
    pageC.on('console', (m: any) => { if (m.type() === 'error') errors.push(`c: консоль ${m.text().slice(0, 160)}`); });
    await pageC.exposeFunction('__u7proof', proofOf); await pageC.exposeFunction('__u7accept', acceptOf);
    await pageC.addInitScript(mock);
    await pageC.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await pageC.waitForTimeout(2500);
    const input = pageC.locator('input').first();
    if (await input.isVisible().catch(() => false)) {
      await input.fill(made.c.symbol); await pageC.locator('input[type="password"]').first().fill(PASSWORD); await pageC.keyboard.press('Enter'); await pageC.waitForTimeout(5000);
    }
    let state: any = null;
    for (let i = 0; i < 20 && !state?.devices?.some((d: any) => d.deviceId === deviceId); i++) { await pageC.waitForTimeout(1000); state = (await api(ownerToken, 'GET', '/api/updates/devices')).json; }
    ok('компьютер сообщил о себе серверу', !!state?.devices?.some((d: any) => d.deviceId === deviceId && d.version === HIGH), state?.devices);
    const low = state.releases.find((r: any) => r.version === LOW);
    const signed = signCampaign({ kind: 'main', keys: { update: { privatePem: fs.readFileSync(path.join(__dirname, 'fixtures/update-test-key.txt'), 'utf8') } } },
      { inst: state.inst, actor: owner.user.id, action: 'schedule', rollback: true, minutes: 10, release: { ...low }, targets: [{ deviceId, userId: made.c.id, previous: null }] });
    const sent = await api(ownerToken, 'POST', '/api/updates/campaigns', signed);
    ok('сервер принял подписанный возврат', sent.status === 200, sent.json || sent.status);
    ok('значок появился у сотрудника, у которого версия выше возвращаемой', await appears(pageC, 15000));
    ok('в подсказке сказано про возврат', /Владелец вернул версию/.test(String(await badgeOf(pageC).getAttribute('title') || '')), await badgeOf(pageC).getAttribute('title'));
    await badgeOf(pageC).click();
    const dialog = pageC.getByRole('dialog', { name: 'Обновление Flux', exact: true });
    await dialog.waitFor({ timeout: 8000 }).catch(() => {});
    ok('окно возврата открылось с нужной версией', await dialog.isVisible().catch(() => false) && (await dialog.innerText().catch(() => '')).includes(LOW));
    ok('обязательное: «Позже» нет', (await dialog.getByRole('button', { name: 'Позже', exact: true }).count()) === 0);
    ok('окно объясняет, что откладывать нельзя', /нельзя/.test(await dialog.innerText().catch(() => '')));
    await pageC.screenshot({ path: path.join(SHOTS, 'update-rollback-light-dialog.png') });
    await pageC.evaluate(() => document.documentElement.classList.add('dark'));
    await pageC.waitForTimeout(400);
    await pageC.screenshot({ path: path.join(SHOTS, 'update-rollback-dark-dialog.png') });
    await dialog.getByRole('button', { name: 'Вернуть версию', exact: true }).click();
    await pageC.waitForTimeout(3000);
    const calls: Array<[string, any]> = await pageC.evaluate(() => (window as any).__calls);
    const download = calls.find(c => c[0] === 'startDownload')?.[1], install = calls.find(c => c[0] === 'quitAndInstall');
    ok('главному процессу ушла загрузка именно возвращаемой версии с пометкой возврата и номером задания',
      download?.version === LOW && download?.rollback === true && download?.campaignId === sent.json?.id, calls);
    ok('установка запрошена по номеру задания', install?.[1] === sent.json?.id, calls);
    await pageC.close();
    ok('в консоли нет ошибок', errors.length === 0, errors.slice(0, 4));
  } catch (e: any) {
    failed++; console.error('  ✗ ошибка сценария:', String(e?.stack || e).slice(0, 600));
  } finally {
    await browser?.close().catch(() => {});
    for (const version of [LOW, HIGH]) await api(ownerToken, 'DELETE', `/api/updates/${version}`).catch(() => {});
    for (const id of departments) if (id) await api(ownerToken, 'POST', `/api/departments/${id}/archive`, {}).catch(() => {});
    for (const who of Object.values(made)) await api(adminToken, 'DELETE', `/api/users/${who.id}`).catch(() => {});
  }
  console.log(failed ? `\nПровалено проверок: ${failed}` : '\nПроверка обновления выбранным пройдена');
  process.exit(failed ? 1 : 0);
})();
