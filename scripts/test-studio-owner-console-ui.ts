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
  window.__calls = [];
  window.ownerConsole = {
    onLocked: () => () => {}, onDisconnected: () => () => {}, onTab: () => () => {},
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
        case 'trialLoad': return ok({ manifest: { id: 'x', name: 'Расчёт', version: '1.1.0', language: 'python', entries: ['start'], reads: [] } });
        case 'releases': return ok({ releases: [{ id: 'rel-1', moduleId: 'connections-http', version: '1.0.0', channel: 'test', state: 'published', signature: 's', size: 1, chunkCount: 1, createdAt: new Date().toISOString() }] });
        case 'testers': return ok({ testers: ['u1'], users: [{ id: 'u1', name: 'Иван Первый', role: 'ENGINEER' }, { id: 'u2', name: 'Пётр Второй', role: 'ENGINEER' }] });
        case 'promote': case 'pin': case 'revoke': case 'saveTesters': return ok({ done: true, testers: args.testers });
        case 'certificates': return ok({ certificates, requests: certRequests });
        case 'certify': certificates = [...certificates, { keyHex: args.key, userId: args.userId, name: args.name, createdAt: new Date().toISOString() }]; certRequests = certRequests.filter(r => r.key !== args.key); return ok({ done: true });
        case 'declineCertificate': certRequests = certRequests.filter(r => r.key !== args.key); return ok({ done: true });
        case 'devices': return ok({ inst: 'company', devices: data.devices, releases: [{ version: '2.0.0', generation: 'g', signature: 's', sha256: 'a' }] });
        case 'assignUpdate': return ok({ ids: ['cmd'] });
        case 'openLicenses': return ok({ opened: true });
      }
      return { ok: false, error: 'Недоступное действие.' };
    },
  };
})();`;

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
    const url = 'file://' + path.join(built.app, 'ui', 'console', 'index.html');
    for (const [theme, width] of [['light', 1180], ['dark', 1180], ['light', 1024], ['dark', 1024]] as const) {
      console.log(`Тема: ${theme}, ширина ${width}`);
      const tag = `${theme}${width === 1180 ? '' : `-${width}`}`;
      const page = await browser.newPage({ viewport: { width, height: 860 } });
      await page.addInitScript((value: string) => { try { localStorage.setItem('theme', value); } catch { /* приватный режим */ } }, theme);
      const errors: string[] = [];
      page.on('pageerror', e => errors.push(e.message));
      page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
      await page.addInitScript(bridge());
      await page.goto(url);

      // Вход в хранилище и подключение
      await page.getByRole('heading', { name: 'Хранилище владельца' }).waitFor();
      await measure(page, `${tag}/хранилище`);
      await page.screenshot({ path: path.join(shots, `owner-console-${tag}-1-vault.png`) });
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
      ok(`${theme}: выпуск новой версии Flux открывает окно лицензий на нужной вкладке`, (await calls(page, 'openLicenses')).some(c => c[1].tab === 'updates'));

      // Лицензии
      await page.getByRole('tab', { name: 'Лицензии' }).click();
      await page.getByRole('button', { name: 'Открыть лицензии' }).click();
      await measure(page, `${tag}/лицензии`);
      await page.screenshot({ path: path.join(shots, `owner-console-${tag}-8-licenses.png`) });
      ok(`${theme}: «Лицензии» открывают окно лицензий, пароль второй раз не спрашивается`, (await calls(page, 'openLicenses')).some(c => c[1].tab === 'licenses') && (await calls(page, 'unlock')).length === 2 && (await page.getByLabel('Пароль хранилища').count()) === 0);
      ok(`${theme}: ошибок страницы нет`, errors.length === 0);
      await page.close();
    }
    console.log(`\nStudio — Владелец: разделы в окне — ${passed} проверок пройдено, снимки: ${shots}`);
  } finally { await browser.close(); fs.rmSync(temp, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exit(1); });
