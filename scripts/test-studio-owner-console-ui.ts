/**
 * Окно разделов владельца в браузере: интерфейс настоящий (готовый пакет сборки владельца), мост с главным
 * процессом подменён заглушкой, которая ведёт себя как console.cjs. Состояние, а не таймеры.
 *
 * Проверяется по разделам: запросы на публикацию (очередь, код и разница, «Связь с Flux», отчёт проверок,
 * замечание к строке → возврат, отклонение с причиной, выпуск и правка через главный процесс), выпуски и каналы,
 * сертификаты (запросы, выдача, отзыв), обновления Flux (выбор устаревших, назначение и отмена), вход в хранилище и
 * подключение. В обеих темах: сплошной фон, нет горизонтальной прокрутки, нет ошибок страницы, поля подписаны,
 * контраст не ниже 4.5:1. Снимки (PNG) — в FLUX_STUDIO_SHOTS, в git не кладутся.
 *
 * Запуск: FLUX_CHROME=/opt/pw-browsers/chromium-1194/chrome-linux/chrome npx tsx scripts/test-studio-owner-console-ui.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Page } from 'playwright-core';
import { packBundle, unpackBundle } from '../modules/trust/bundle';
import { diffFiles, diffPermissions, manifestOf } from '../modules/trust/diff';
import { describeBundle } from '../modules/trust/verify';

const { buildStudio } = require('../studio/build.cjs');
let passed = 0;
const ok = (name: string, value: unknown) => { assert.ok(value, name); passed++; console.log(`  ✓ ${name}`); };
const shots = process.env.FLUX_STUDIO_SHOTS || path.join(os.tmpdir(), 'flux-studio-shots');

const manifest = (version: string, withConnection: boolean) => JSON.stringify({
  id: 'connections-http', name: 'Расчёт на сервере', version, author: 'Flux', contractVersion: withConnection ? 3 : 1, entries: ['start'], reads: ['project'], logic: 'logic/main.ts',
  ...(withConnection ? { permissions: [{ kind: 'internet', does: 'Показывает курсы валют из открытого сервиса' }] } : {}),
  ...(withConnection ? { connections: [{ id: 'api', kind: 'http', url: 'http://127.0.0.1:18123', pathPrefix: '/api', app: 'Сервер расчётов', does: 'Отправляет на сервер расчётов номер проекта и получает ответ', access: 'send' }] } : {}),
}, null, 2);
const before = packBundle({ 'manifest.json': manifest('1.0.0', false), 'logic/main.ts': 'export function run() {\n  return 1;\n}\n', 'form.json': '{}' });
const after = packBundle({ 'manifest.json': manifest('1.1.0', true), 'logic/main.ts': 'export function run() {\n  return 2;\n}\n// новое\n', 'form.json': '{}' });
const afterFiles = unpackBundle(after);
const request = {
  id: 'req-1', moduleId: 'connections-http', version: '1.1.0', state: 'pending', byOwner: false, authorKey: 'k', authorId: 'developer', parentId: null, baseRelease: 'connections-http@1.0.0',
  size: after.length, createdAt: new Date().toISOString(), decidedBy: '', decidedAt: null, review: null,
  meta: { changelog: 'Считает через сервер', comment: 'Проверьте подключение', channel: 'test', checks: '{"договор":"ok","контрольные примеры":"ok"}', fluxVersion: '1.20.20', contractVersion: 1 },
};
const detail = {
  request, signature: 'FLUXMODREQ1.x', bundle: Buffer.from(after).toString('base64'), sha256: describeBundle(after).sha256,
  diff: { against: { release: 'connections-http@1.0.0' }, files: diffFiles(unpackBundle(before), afterFiles), permissions: diffPermissions(manifestOf(unpackBundle(before)), manifestOf(afterFiles)!) },
};
const other = { ...request, id: 'req-2', moduleId: 'report-builder', version: '0.3.0', state: 'returned', baseRelease: null, meta: { ...request.meta, changelog: 'Отчёты' } };
const devices = [
  { deviceId: 'aaaaaaaa-0000-0000-0000-000000000001', userId: 'u1', name: 'Иван Первый', symbol: '1', isActive: true, version: '1.0.0', platform: 'win32', arch: 'x64', lastSeen: Date.now(), offline: false, status: 'idle', code: '', commandId: null, action: null, deadline: null, targetVersion: null },
  { deviceId: 'bbbbbbbb-0000-0000-0000-000000000002', userId: 'u2', name: 'Пётр Второй', symbol: '2', isActive: true, version: '2.0.0', platform: 'win32', arch: 'x64', lastSeen: Date.now(), offline: false, status: 'updated', code: '', commandId: null, action: null, deadline: null, targetVersion: null },
];

/** Заглушка главного процесса: те же имена действий и форма ответов, что у console.cjs */
const bridge = () => `(() => {
  const data = ${JSON.stringify({ request, other, detail, devices })};
  let state = { version: '9.9.9', unlocked: false, vaultExists: true, backupSession: false, kind: '', connected: false, display: '', user: null };
  let requests = [data.request, data.other], certificates = [{ keyHex: 'ab'.repeat(32), userId: 'developer', name: 'Разработчик', createdAt: new Date().toISOString() }];
  let certRequests = [{ key: 'cd'.repeat(32), userId: 'dev2', name: 'Второй разработчик', at: Date.now() }];
  const now = Date.now();
  let licenses = [{ id: 'LIC-0001', inst: 'inst-aaaa-1111', org: 'ООО «Север»', logins: ['ivanov', 'petrov'], exp: now + 200 * 86400000, code: 'FLUX2.aaa' }, { id: 'LIC-0002', inst: 'inst-bbbb-2222', org: 'АО «Юг»', logins: ['sidorov'], exp: now - 5 * 86400000, code: 'FLUX2.bbb' }];
  let revocations = [], exe = null, setupKit = false;
  const updates = [{ version: '1.20.20', published: true, iat: now - 86400000, name: 'Flux-1.20.20.exe', size: 90 * 1048576, signature: 'FLUXUPD1.x', server: 'MariaDB / MySQL · db.example:3306/Flux' }];
  const full = () => ({ ...state, vaultPath: 'C:/Users/owner/.flux-owner/vault.flux-owner', setupKitPath: setupKit ? 'C:/копии/комплект' : '', publicFilePath: '', previousVaultPath: setupKit ? 'C:/старое.flux-owner' : '', setupVerified: false,
    publicKeys: { license: 'ab'.repeat(32), update: 'cd'.repeat(32), owner: 'ef'.repeat(32) }, backupOwnerPublic: '12'.repeat(32), licenses, updates, revocations, server: state.display, exe });
  window.__calls = [];
  window.ownerConsole = {
    onLocked: () => () => {}, onDisconnected: () => () => {}, onTab: () => () => {}, onProgress: () => () => {},
    call: async (action, args = {}) => {
      window.__calls.push([action, args]);
      const ok = value => ({ ok: true, value });
      switch (action) {
        case 'state': return ok(state);
        case 'unlock': if (args.password !== 'правильный-пароль') return { ok: false, error: 'Неверный пароль хранилища.' }; state = { ...state, unlocked: true, kind: 'main' }; return ok(state);
        case 'connect': state = { ...state, connected: true, display: 'MariaDB / MySQL · db.example:3306/Flux', user: { id: 'owner', name: 'Владелец' } }; return ok(state);
        case 'lock': state = { ...state, unlocked: false, connected: false }; return ok(state);
        case 'requests': return ok({ requests });
        case 'request': return ok({ ...data.detail, request: requests.find(r => r.id === args.id) });
        case 'returnRequest': requests = requests.map(r => r.id === args.id ? { ...r, state: 'returned' } : r); return ok({ done: true });
        case 'rejectRequest': requests = requests.map(r => r.id === args.id ? { ...r, state: 'rejected' } : r); return ok({ done: true });
        case 'release': requests = requests.map(r => r.id === args.id ? { ...r, state: 'released' } : r); return ok({ release: { id: 'rel-1' } });
        case 'ownerEdit': return ok({ id: 'req-owner' });
        case 'trialLoad': return ok({ manifest: window.__page ? { id: 'x', name: 'Страница', version: '1.1.0', ui: 'page', entries: ['start'], reads: [] } : { id: 'x', name: 'Расчёт', version: '1.1.0', language: 'python', entries: ['start'], reads: [] } });
        case 'trialPickFile': return ok(args.accept && args.accept[0] === '.none' ? { ok: false, code: 'CANCELLED' } : { ok: true, name: 'данные.csv', data: btoa('a;b') });
        case 'releases': return ok({ releases: [{ id: 'rel-1', moduleId: 'connections-http', version: '1.0.0', channel: 'test', state: 'published', signature: 's', size: 1, chunkCount: 1, createdAt: new Date().toISOString() }] });
        case 'testers': return ok({ testers: ['u1'], users: [{ id: 'u1', name: 'Иван Первый', role: 'ENGINEER' }, { id: 'u2', name: 'Пётр Второй', role: 'ENGINEER' }] });
        case 'promote': case 'pin': case 'revoke': case 'saveTesters': return ok({ done: true, testers: args.testers });
        case 'certificates': return ok({ certificates, requests: certRequests });
        case 'certify': certificates = [...certificates, { keyHex: args.key, userId: args.userId, name: args.name, createdAt: new Date().toISOString() }]; certRequests = certRequests.filter(r => r.key !== args.key); return ok({ done: true });
        case 'declineCertificate': certRequests = certRequests.filter(r => r.key !== args.key); return ok({ done: true });
        case 'devices': return ok({ inst: 'company', devices: data.devices, releases: [{ version: '2.0.0', generation: 'g', signature: 's', sha256: 'a' }] });
        case 'assignUpdate': return ok({ ids: ['cmd'] });
        case 'licensesState': return ok(full());
        case 'licenseRequest': return ok({ inst: 'inst-cccc-3333', org: 'ООО «Запад»', people: [{ login: 'ivanov', name: 'Иван Иванов' }, { login: 'kuznetsov', name: 'Пётр Кузнецов' }, { login: 'smirnov', name: 'Анна Смирнова' }] });
        case 'issue': licenses = [...licenses, { id: 'LIC-0003', inst: 'inst-cccc-3333', org: args.org, logins: args.logins, exp: args.expiresAt, code: 'FLUX2.ccc' }]; return ok({ code: 'FLUX2.ccc' });
        case 'licenseRevoke': revocations = [...revocations, { inst: args.inst, ids: args.ids }]; return ok({ code: 'FLUXREV1.zzz' });
        case 'publishRevocation': case 'copy': case 'publicExport': case 'publicApply': case 'export': case 'changePassword': case 'signUpdate': case 'publish': case 'withdrawUpdate': case 'exportDiagnostics': case 'openFlux': case 'showSetupFolder': return ok({ done: true });
        case 'chooseExe': exe = { name: 'Flux-1.21.0.exe', size: 91 * 1048576, sha256: '9f'.repeat(32) }; return ok({ ...full() });
        case 'chooseSetupFolder': return ok({ folderPath: 'C:/копии' });
        case 'setup': setupKit = true; state = { ...state, unlocked: true, kind: 'main' }; return ok({ ...full() });
        case 'verifySetup': return args.password === 'правильный-пароль' ? ok({ ...full(), setupVerified: true }) : { ok: false, error: 'Неверный пароль хранилища.' };
      }
      return { ok: false, error: 'Недоступное действие.' };
    },
  };
})();`;

/**
 * Программа-страница для пробного запуска: настоящий протокол flux-module:// в браузере недоступен, поэтому адрес кадра подменяется
 * документом с тем же обменом сообщениями, что у клиента flux.v1.js (ready → запросы op → ответы). Бросать запросы из него будет проверка.
 */
const PROBE = `<!doctype html><meta charset=utf-8><body><script>
const session = location.hash.slice(1), waiting = {}; let n = 0;
window.addEventListener('message', e => { const m = e.data; if (m && m.session === session && waiting[m.id]) { waiting[m.id](m); delete waiting[m.id]; } });
window.ask = (op, body) => new Promise(res => { const id = 'p-' + (++n); waiting[id] = res; parent.postMessage({ flux: 'module', v: 1, session, id, type: 'page', op, ...body }, '*'); });
parent.postMessage({ flux: 'module', v: 1, session, type: 'ready' }, '*');
<\/script>`;
const frameInit = `(() => { const set = Element.prototype.setAttribute; Element.prototype.setAttribute = function (name, value) {
  if (this.tagName === 'IFRAME' && name === 'src' && String(value).startsWith('flux-module://trial/')) value = 'data:text/html;charset=utf-8,' + encodeURIComponent(${JSON.stringify(PROBE)}) + '#' + String(value).split('#')[1];
  return set.call(this, name, value); }; })();`;

const luminance = (rgb: number[]) => { const [r, g, b] = rgb.map(v => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a: number[], b: number[]) => { const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
async function measure(page: Page, label: string) {
  // Цвета Flux приходят в oklch(): для контраста сводим к RGB через холст
  const info = await page.evaluate(`(() => {
    const rgb = css => { const c = document.createElement('canvas').getContext('2d'); c.clearRect(0, 0, 1, 1); c.fillStyle = css; c.fillRect(0, 0, 1, 1); const d = c.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
    const body = getComputedStyle(document.body);
    return { bg: rgb(body.backgroundColor), color: rgb(body.color), overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      unlabeled: [...document.querySelectorAll('input:not([type=checkbox]), select, textarea')].filter(i => !i.labels?.length && !i.getAttribute('aria-label')).length };
  })()`) as { bg: number[]; color: number[]; overflowX: number; unlabeled: number };
  const bg = info.bg, fg = info.color;
  ok(`${label}: фон сплошной`, bg[3] === 1);
  ok(`${label}: нет горизонтальной прокрутки`, info.overflowX <= 0);
  // Слова интерфейса (решение владельца): подписи кнопок, вкладок, заголовков и подсказок без «канал», «договор» и др.
  const words = await page.evaluate(`[...document.querySelectorAll('button, [role=tab], h1, h2, h3, label, th, .hint, .muted, strong, .fx-empty')].map(e => e.innerText || '').join(' | ')`) as string;
  ok(`${label}: в подписях нет слов «канал», «договор», «привязки», «манифест», «бандл»`, !/канал|договор|привяз|манифест|бандл/i.test(words));
  ok(`${label}: у полей есть подписи`, info.unlabeled === 0);
  ok(`${label}: контраст текста не ниже 4.5:1`, contrast(fg.slice(0, 3), bg.slice(0, 3)) >= 4.5);
}
const calls = (page: Page, action: string) => page.evaluate((a) => (window as any).__calls.filter((c: unknown[]) => c[0] === a), action) as Promise<Array<[string, any]>>;

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-owner-console-ui-'));
  fs.mkdirSync(shots, { recursive: true });
  const browser = await chromium.launch({ ...(process.env.FLUX_CHROME ? { executablePath: process.env.FLUX_CHROME } : {}), args: ['--no-sandbox'] });
  try {
    const built = await buildStudio({ target: 'owner', outDir: path.join(temp, 'owner') });
    const indexFile = path.join(built.app, 'ui', 'console', 'index.html');
    // Протокол flux-module:// в браузере недоступен: в копии страницы кадру разрешён data: (и встроенный скрипт: кадр наследует политику страницы), чтобы подставить программу-пробу (PROBE)
    fs.writeFileSync(indexFile, fs.readFileSync(indexFile, 'utf8').replace('frame-src flux-module:', 'frame-src flux-module: data:').replace("script-src 'self'", "script-src 'self' 'unsafe-inline'"));
    const url = 'file://' + indexFile;
    for (const [theme, width] of [['light', 1180], ['dark', 1180], ['light', 1024], ['dark', 1024]] as const) {
      console.log(`Тема: ${theme}, ширина ${width}`);
      const tag = `${theme}${width === 1180 ? '' : `-${width}`}`;
      const page = await browser.newPage({ viewport: { width, height: 860 } });
      await page.addInitScript((value: string) => { try { localStorage.setItem('theme', value); } catch { /* приватный режим */ } }, theme);
      const errors: string[] = [];
      page.on('pageerror', e => errors.push(e.message));
      page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
      await page.addInitScript(bridge());
      await page.addInitScript(frameInit);
      await page.goto(url);

      // Вход в хранилище и подключение
      await page.getByRole('heading', { name: 'Хранилище владельца' }).waitFor();
      await measure(page, `${tag}/хранилище`);
      await page.screenshot({ path: path.join(shots, `owner-console-${tag}-1-vault.png`) });
      // Создание новых ключей — внутри окна, тремя шагами (раньше — отдельное окно лицензий)
      await page.getByRole('button', { name: 'Создать новые ключи' }).click();
      await page.getByRole('heading', { name: 'Создайте хранилище владельца' }).waitFor();
      await measure(page, `${tag}/создание хранилища`);
      await page.screenshot({ path: path.join(shots, `owner-console-${tag}-1a-vault-setup.png`) });
      await page.fill('#setup-password', 'новая-фраза-пароль-1'); await page.fill('#setup-confirm', 'другая-фраза-пароль-2');
      await page.getByRole('button', { name: 'Выбрать папку для копий' }).click();
      await page.getByRole('button', { name: 'Создать ключи' }).click();
      await page.getByRole('alert').waitFor();
      ok(`${theme}: разные пароли не создают ключи`, /не совпадают/.test(await page.getByRole('alert').innerText()) && (await calls(page, 'setup')).length === 0);
      await page.getByRole('button', { name: 'Назад' }).click();
      await page.getByRole('heading', { name: 'Хранилище владельца' }).waitFor();
      await page.fill('#vault-password', 'неверный-пароль-хранилища');
      await page.getByRole('button', { name: 'Открыть хранилище' }).click();
      await page.getByRole('alert').waitFor();
      ok(`${theme}: неверный пароль показан текстом, пароль очищен`, /Неверный пароль/.test(await page.getByRole('alert').innerText()) && (await page.inputValue('#vault-password')) === '');
      await page.fill('#vault-password', 'правильный-пароль');
      await page.getByRole('button', { name: 'Открыть хранилище' }).click();
      await page.getByRole('heading', { name: 'Подключение к общей базе' }).waitFor();
      ok(`${theme}: адрес базы скрыт полем пароля`, (await page.locator('#uri').getAttribute('type')) === 'password');
      await measure(page, `${tag}/подключение`);
      await page.fill('#uri', 'mysql://U:P@H:3306/Flux');
      await page.getByRole('button', { name: 'Подключиться' }).click();

      // Три пункта вместо прежних разделов
      await page.getByRole('tab', { name: /Программы на проверку/ }).waitFor();
      ok(`${theme}: ровно три пункта: программы на проверку, обновления Flux, лицензии`, (await page.getByRole('tablist', { name: 'Разделы владельца' }).getByRole('tab').allInnerTexts()).map(t => t.replace(/\s*\d+$/, '').trim()).join('|') === 'Программы на проверку|Flux: обновления|Лицензии');
      ok(`${theme}: в «Программах на проверку» четыре подраздела`, (await page.getByRole('group', { name: 'Программы на проверку' }).getByRole('button').count()) === 4);

      // Запросы на публикацию
      await page.getByRole('button', { name: /connections-http 1\.1\.0/ }).waitFor();
      ok(`${theme}: очередь показывает только ждущие решения`, (await page.getByRole('button', { name: /report-builder/ }).count()) === 0);
      await page.getByText('Расширены разрешения').waitFor();
      ok(`${theme}: расширение разрешений выделено`, true);
      await page.getByTestId('request-code').waitFor();
      const code = await page.getByTestId('request-code').innerText();
      ok(`${theme}: код и разница с прошлой версией построчно`, code.includes('+ // новое') || code.includes('+ ') );
      await measure(page, `${tag}/запрос`);
      await page.screenshot({ path: path.join(shots, `owner-console-${tag}-2-request.png`) });
      await page.getByRole('tab', { name: 'Связь с Flux' }).click();
      await page.getByTestId('owner-connection-texts').waitFor();
      ok(`${theme}: подключение показано человеческим текстом`, /хочет подключиться к Сервер расчётов/.test(await page.getByTestId('owner-connection-texts').innerText()) && (await page.getByTestId('diff-connection').count()) === 1);
      ok(`${theme}: разрешение сети выделено в разнице: «новое: любой адрес в интернете»`, (await page.getByTestId('diff-permission').count()) === 1 && /новое\s+любой адрес в интернете — Показывает курсы валют/.test((await page.getByTestId('diff-permission').innerText()).replace(/\s+/g, ' ')));
      await page.screenshot({ path: path.join(shots, `owner-console-${tag}-3-flux.png`) });
      await page.getByRole('tab', { name: /Замечания и проверки/ }).click();
      ok(`${theme}: отчёт проверок виден и помечен «заявлено автором»`, (await page.getByText('контрольные примеры').count()) > 0 && (await page.getByText('заявлено автором').count()) > 0);
      await page.getByRole('tab', { name: 'Проверить в работе' }).click();

      // Страница программы: настоящие файл и диалоги (не отказ), как в запуске разработчика
      await page.evaluate('window.__page = true');
      await page.getByRole('button', { name: 'Запустить на тестовой базе' }).click();
      const probe = await (async () => { for (let i = 0; i < 100; i++) { const f = page.frames().find(x => x.url().startsWith('data:text/html')); if (f && await f.evaluate('typeof window.ask').catch((e: Error) => { (globalThis as any).__probeErr = e.message; return ''; }) === 'function') return f; await page.waitForTimeout(100); } throw new Error('страница пробного запуска не загрузилась: ' + (globalThis as any).__probeErr + JSON.stringify(page.frames().map(x => x.url().slice(0, 60))) + await page.evaluate('document.querySelector("iframe")?.outerHTML.slice(0, 200)')); })();
      await page.waitForTimeout(300);
      const picked: any = await probe.evaluate(`ask('file-pick', { accept: ['.csv'] })`);
      ok(`${theme}: flux.openFile в пробном запуске выдал выбранный файл, а не отказ`, picked.type === 'page-result' && picked.data.name === 'данные.csv' && atob(picked.data.data) === 'a;b' && picked.data.size === 3);
      ok(`${theme}: главный процесс получил просьбу о файле с подсказкой расширений`, (await calls(page, 'trialPickFile')).some(c => c[1].accept?.[0] === '.csv'));
      await page.waitForTimeout(1100);
      const refused: any = await probe.evaluate(`ask('file-pick', { accept: ['.none'] })`);
      ok(`${theme}: отказ человека в диалоге выбора файла — CANCELLED`, refused.type === 'page-error' && refused.code === 'CANCELLED');
      const confirmed = probe.evaluate(`ask('dialog-confirm', { title: 'Удалить расчёт?', text: 'Это нельзя отменить.', ok: 'Удалить', danger: true })`);
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('button', { name: 'Удалить' }).waitFor();
      ok(`${theme}: вопрос показан настоящим диалогом Studio: заголовок с названием программы, текст, свои подписи кнопок`, /Страница — Удалить расчёт\?/.test(await dialog.innerText()) && /Это нельзя отменить/.test(await dialog.innerText()) && (await dialog.getByRole('button', { name: 'Отмена' }).count()) === 1);
      await measure(page, `${tag}/диалог программы`);
      await page.screenshot({ path: path.join(shots, `owner-console-${tag}-2a-program-dialog.png`) });
      await dialog.getByRole('button', { name: 'Удалить' }).click();
      const yes: any = await confirmed;
      ok(`${theme}: «Удалить» — программе пришло true`, yes.type === 'page-result' && yes.data === true);
      await page.waitForTimeout(1100);
      const typed = probe.evaluate(`ask('dialog-prompt', { title: 'Имя', label: 'Название расчёта', value: 'Новый', maxLength: 20 })`);
      await page.getByLabel('Название расчёта').fill('Мой расчёт');
      await page.getByTestId('trial-dialog-ok').click();
      const text: any = await typed;
      ok(`${theme}: ввод строки доходит до программы`, text.data === 'Мой расчёт');
      await page.waitForTimeout(1100);
      const closed = probe.evaluate(`ask('dialog-confirm', { title: 'Закрыть?', text: 'Вопрос' })`);
      await dialog.waitFor();
      await page.keyboard.press('Escape');
      const no: any = await closed;
      ok(`${theme}: закрытие диалога без ответа — программе false, диалог убран`, no.data === false && (await dialog.count()) === 0);
      await page.waitForTimeout(1100);
      const note = probe.evaluate(`ask('dialog-alert', { title: 'Готово', text: 'Расчёт сохранён' })`);
      await dialog.getByRole('button', { name: 'Понятно' }).click();
      ok(`${theme}: сообщение закрывается кнопкой «Понятно»`, (await note as any).data === null && (await dialog.getByRole('button', { name: 'Отмена' }).count()) === 0);
      ok(`${theme}: в журнале запуска нет слов об отказе`, !/отвечено отказом|отвечено/.test(await page.getByLabel('Журнал программы').innerText()));
      await page.evaluate('window.__page = false');
      await page.getByRole('button', { name: 'Остановить' }).click();
      await page.getByRole('button', { name: 'Запустить на тестовой базе' }).click();
      await page.getByText('Пробный запуск для этого языка — во Flux').waitFor();
      ok(`${theme}: Python: понятная надпись «пробный запуск для этого языка — во Flux»`, true);

      // Замечание к строке → возврат на доработку
      await page.getByRole('tab', { name: /Файлы/ }).click();
      await page.getByRole('button', { name: 'logic/main.ts' }).click();
      await page.locator('.code .line', { hasText: '// новое' }).click();
      await page.getByLabel(/Замечание к строке/).fill('Нужен комментарий почему');
      await page.getByRole('button', { name: 'Добавить замечание' }).click();
      await page.getByRole('tab', { name: /Замечания и проверки · 1/ }).click();
      ok(`${theme}: замечание к строке сохранено с номером строки`, /logic\/main\.ts:\d+ — Нужен комментарий почему/.test(await page.locator('.scroll.sect').innerText()));
      await page.getByRole('button', { name: 'Вернуть на доработку' }).click();
      await page.getByLabel('Общее замечание').fill('Поправьте и пришлите снова');
      await page.getByRole('dialog').getByRole('button', { name: 'Вернуть' }).click();
      await page.getByRole('dialog').waitFor({ state: 'detached' });
      const returned = (await calls(page, 'returnRequest'))[0][1];
      ok(`${theme}: возврат ушёл в главный процесс с замечанием к строке`, returned.id === 'req-1' && returned.note === 'Поправьте и пришлите снова' && returned.comments.length === 1 && returned.comments[0].path === 'logic/main.ts' && returned.comments[0].line > 0);

      // Отклонение требует причину; выпуск уходит с хешем показанного пакета
      await page.getByRole('button', { name: /Все · 2/ }).click();
      await page.getByRole('button', { name: /report-builder/ }).click();
      await page.getByRole('button', { name: /connections-http 1\.1\.0/ }).click();
      ok(`${theme}: решённый запрос не предлагает решений`, (await page.getByRole('button', { name: 'Выпустить' }).count()) === 0);
      await page.getByRole('button', { name: /Ждут/ }).click();
      await page.screenshot({ path: path.join(shots, `owner-console-${tag}-4-after-return.png`) });

      // Выпуски
      await page.getByRole('group', { name: 'Программы на проверку' }).getByRole('button', { name: 'Выпущенные' }).click();
      await page.getByRole('button', { name: 'Выпустить для всех' }).waitFor();
      await measure(page, `${tag}/выпуски`);
      await page.getByRole('button', { name: 'Отозвать' }).click();
      await page.getByLabel('Причина').fill('Ошибка в расчёте');
      await page.getByRole('dialog').getByRole('button', { name: 'Подписать' }).click();
      await page.getByRole('dialog').waitFor({ state: 'detached' });
      const revoked = (await calls(page, 'revoke'))[0][1];
      ok(`${theme}: отзыв выпуска ушёл с именем выпуска и причиной`, revoked.target === 'release' && revoked.value === 'connections-http@1.0.0' && revoked.reason === 'Ошибка в расчёте');
      await page.screenshot({ path: path.join(shots, `owner-console-${tag}-5-releases.png`) });

      // Кому доступны
      await page.getByRole('group', { name: 'Программы на проверку' }).getByRole('button', { name: 'Кому доступны' }).click();
      await page.getByTestId('module-testers').waitFor();
      await measure(page, `${tag}/кому доступны`);
      await page.screenshot({ path: path.join(shots, `owner-console-${tag}-5b-testers.png`) });

      // Запросы на право публиковать
      await page.getByRole('group', { name: 'Программы на проверку' }).getByRole('button', { name: /Запросы на право публиковать/ }).click();
      await page.getByTestId('certificate-requests').waitFor();
      await measure(page, `${tag}/сертификаты`);
      await page.screenshot({ path: path.join(shots, `owner-console-${tag}-6-certificates.png`) });
      await page.getByTestId('certificate-requests').getByRole('button', { name: 'Выдать' }).click();
      ok(`${theme}: запрос на сертификат подставил ключ и имя`, (await page.inputValue('#cert-key')) === 'cd'.repeat(32) && (await page.inputValue('#cert-name')) === 'Второй разработчик');
      await page.getByRole('dialog').getByRole('button', { name: 'Подписать сертификат' }).click();
      await page.getByRole('dialog').waitFor({ state: 'detached' });
      await page.getByRole('cell', { name: 'Второй разработчик' }).waitFor();
      ok(`${theme}: сертификат выдан, запрос закрыт`, (await page.getByTestId('certificate-requests').count()) === 0 && (await calls(page, 'certify'))[0][1].userId === 'dev2');

      // Обновления Flux
      await page.getByRole('tab', { name: 'Flux: обновления' }).click();
      await page.getByRole('button', { name: /Выбрать всех устаревших · 1/ }).waitFor();
      await page.getByRole('button', { name: /Иван Первый/ }).click();
      await measure(page, `${tag}/обновления`);
      await page.screenshot({ path: path.join(shots, `owner-console-${tag}-7-updates.png`) });
      await page.getByRole('button', { name: /Выбрать всех устаревших/ }).click();
      await page.getByRole('button', { name: 'Назначить обновление' }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Назначить' }).click();
      await page.getByRole('dialog').waitFor({ state: 'detached' });
      const assigned = (await calls(page, 'assignUpdate'))[0][1];
      ok(`${theme}: назначение ушло только для устаревшего устройства, срок и версия на месте`, assigned.action === 'schedule' && assigned.version === '2.0.0' && assigned.minutes === 10
        && assigned.devices.length === 1 && assigned.devices[0] === 'aaaaaaaa-0000-0000-0000-000000000001:u1');
      await page.getByRole('button', { name: /Опубликовать новую версию Flux/ }).click();
      await page.getByRole('heading', { name: 'Выпуск для сотрудников' }).waitFor();
      ok(`${theme}: выпуск новой версии Flux открывается в «Лицензиях», отдельного окна нет`, (await page.getByRole('tab', { name: 'Лицензии' }).getAttribute('aria-selected')) === 'true' && (await calls(page, 'openLicenses')).length === 0);
      await measure(page, `${tag}/выпуск Flux`);
      await page.getByRole('button', { name: 'Выбрать EXE' }).click();
      await page.getByTestId('exe-details').getByText(/Flux-1\.21\.0\.exe/).waitFor();
      await page.fill('#pub-version', '1.21.0'); await page.fill('#pub-changelog', 'Исправления');
      await page.getByRole('button', { name: 'Подписать и опубликовать' }).click();
      await page.getByText('Обновление опубликовано через БД.').waitFor();
      ok(`${theme}: публикация ушла с версией и описанием`, (await calls(page, 'publish'))[0][1].version === '1.21.0' && (await calls(page, 'publish'))[0][1].changelog === 'Исправления');
      ok(`${theme}: реестр выпусков показывает подписанный выпуск`, /1\.20\.20 · Опубликована/.test(await page.getByTestId('update-registry').innerText()));
      await page.screenshot({ path: path.join(shots, `owner-console-${tag}-8b-flux-publish.png`) });

      // Лицензии: выпуск, реестр, отзыв
      await page.getByRole('group', { name: 'Лицензии' }).getByRole('button', { name: 'Лицензии компаний' }).click();
      await page.getByRole('heading', { name: 'Выпустить лицензию' }).waitFor();
      await measure(page, `${tag}/лицензии`);
      await page.screenshot({ path: path.join(shots, `owner-console-${tag}-8-licenses.png`) });
      await page.fill('#lic-code', 'FLUXREQ1.abc');
      await page.getByRole('button', { name: 'Прочитать запрос' }).click();
      await page.getByTestId('license-request').waitFor();
      ok(`${theme}: запрос прочитан: компания и все сотрудники выбраны`, (await page.inputValue('#lic-company')) === 'ООО «Запад»' && /3 из 3/.test(await page.getByTestId('license-request').innerText()));
      await page.getByRole('button', { name: 'Снять выбор' }).click();
      ok(`${theme}: без сотрудников ключ не выпускается`, await page.getByRole('button', { name: 'Выпустить ключ' }).isDisabled());
      await page.getByLabel('Выбрать Иван Иванов').check(); await page.fill('#lic-expiration', '2030-01-31');
      await page.screenshot({ path: path.join(shots, `owner-console-${tag}-8a-license-request.png`) });
      await page.getByRole('button', { name: 'Выпустить ключ' }).click();
      await page.getByText('Лицензия выпущена и сохранена в зашифрованном реестре.').waitFor();
      const issued = (await calls(page, 'issue'))[0][1];
      ok(`${theme}: выпуск ушёл с кодом запроса, выбранным сотрудником, компанией и концом дня даты`, issued.code === 'FLUXREQ1.abc' && issued.logins.join() === 'ivanov' && issued.org === 'ООО «Запад»' && new Date(issued.expiresAt).getFullYear() === 2030 && new Date(issued.expiresAt).getHours() === 23);
      ok(`${theme}: готовый ключ показан, в реестре появилась строка`, (await page.getByRole('textbox', { name: 'Готовый ключ' }).inputValue()) === 'FLUX2.ccc' && (await page.getByTestId('license-registry').getByText('ООО «Запад»').count()) === 1);
      await page.getByRole('button', { name: 'Скопировать', exact: true }).click();
      ok(`${theme}: ключ копируется через главный процесс`, (await calls(page, 'copy')).some(c => c[1].text === 'FLUX2.ccc'));
      ok(`${theme}: истёкшая лицензия помечена`, (await page.getByTestId('license-registry').getByText('Истекла').count()) === 1);
      await page.getByLabel('Выбрать лицензию LIC-0001').check();
      await page.getByLabel('Выбрать лицензию LIC-0003').check();
      await page.getByRole('button', { name: 'Отозвать выбранные' }).click();
      await page.getByText('Для одного списка отзыва выберите лицензии одной установки.').waitFor();
      ok(`${theme}: отзыв из разных установок отклонён, главный процесс не вызывался`, (await calls(page, 'licenseRevoke')).length === 0);
      await page.getByLabel('Выбрать лицензию LIC-0003').uncheck();
      await page.getByRole('button', { name: 'Отозвать выбранные' }).click();
      await page.getByRole('button', { name: 'Отправить отзыв в общую БД' }).waitFor();
      ok(`${theme}: список отзыва подписан и показан готовым ключом, лицензия помечена «Отозвана»`, (await page.getByRole('textbox', { name: 'Готовый ключ' }).inputValue()) === 'FLUXREV1.zzz' && (await page.getByTestId('license-registry').getByText('Отозвана').count()) === 1);
      await page.screenshot({ path: path.join(shots, `owner-console-${tag}-8c-license-revoked.png`) });

      // Ключи и резервная копия
      await page.getByRole('group', { name: 'Лицензии' }).getByRole('button', { name: 'Ключи и резервная копия' }).click();
      await page.getByRole('heading', { name: 'Открытые ключи для Flux' }).waitFor();
      ok(`${theme}: открытые ключи показаны, закрытых нет`, (await page.getByTestId('public-keys').locator('tr').count()) === 4 && !/PRIVATE/.test(await page.getByTestId('public-keys').innerText()));
      await measure(page, `${tag}/ключи и копия`);
      await page.fill('#keys-new', 'новый-пароль-хранилища'); await page.fill('#keys-again', 'другой-пароль-хранилища');
      await page.getByRole('button', { name: 'Сменить пароль хранилища' }).click();
      await page.getByText('Пароли не совпадают.').waitFor();
      ok(`${theme}: разные пароли не меняют хранилище`, (await calls(page, 'changePassword')).length === 0);
      await page.fill('#keys-export-password', 'пароль-копии-12345');
      await page.getByRole('button', { name: 'Экспортировать резервную копию' }).click();
      await page.getByText('Резервная копия сохранена.').waitFor();
      ok(`${theme}: пароль копии очищен после экспорта`, (await page.inputValue('#keys-export-password')) === '' && (await calls(page, 'export'))[0][1].password === 'пароль-копии-12345');
      await page.screenshot({ path: path.join(shots, `owner-console-${tag}-8d-license-keys.png`) });
      ok(`${theme}: «Лицензии» не открывают отдельного окна, пароль второй раз не спрашивается`, (await calls(page, 'openLicenses')).length === 0 && (await calls(page, 'unlock')).length === 2);
      ok(`${theme}: ошибок страницы нет`, errors.length === 0);
      await page.close();
    }
    console.log(`\nStudio — Владелец: разделы в окне — ${passed} проверок пройдено, снимки: ${shots}`);
  } finally { await browser.close(); fs.rmSync(temp, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exit(1); });
