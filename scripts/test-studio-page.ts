/**
 * Studio: проект со своей страницей (договор v2) — заготовка каждого языка, проверка перед отправкой, пакет без runtime.js.
 *
 * Что доказывается:
 * - заготовка «страница» для всех 7 языков создаёт проект, проходящий проверку; формы в нём нет, ui/ и типы flux.* есть;
 * - проверка падает на: сетевом вызове, встроенных скрипте и стиле, внешнем адресе, хранилище, eval, жёстких цветах без токенов,
 *   недопустимом типе файла, отсутствии ui/index.html;
 * - flux.net.fetch (через мост) проверкой не ругается; разрешения сети (internet, lan): адрес без permissions, закрытые адреса, лишнее разрешение, формат v3;
 * - пакет страницы не несёт build/runtime.js и принимается verifyRequest (форма с runtime.js — как раньше);
 * - типы flux.* строятся из договора.
 *
 * Запуск: npx tsx scripts/test-studio-page.ts
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import esbuild from 'esbuild';
import { runChecks, type CheckReport } from '../studio/shared/checks';
import { DeveloperKeyring, type SafeStorageLike } from '../studio/shared/keyring';
import { buildRequest } from '../studio/shared/publish';
import { createFromTemplate, TEMPLATE_IDS, type ProjectFiles } from '../studio/shared/templates';
import { fluxPageTypes } from '../modules/page/types';
import { trialProgramCall } from '../studio/shared/trialPrograms';
import { unpackBundle } from '../modules/trust/bundle';
import { publicHexOf, sealEnvelope } from '../modules/trust/envelope';
import { readCertificates, verifyRequest } from '../modules/trust/verify';
import { resources } from '../modules/contract';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import RunDialog from '../studio/renderer/sections/RunDialog';

const { buildDeveloperAssets } = require('../studio/build-assets.cjs');
let passed = 0;
const ok = (name: string, value: unknown) => { assert.ok(value, name); passed++; console.log(`  ✓ ${name}`); };
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-studio-page-'));
const text = (bytes: Uint8Array) => Buffer.from(bytes).toString('utf8');
const enc = (value: string) => new TextEncoder().encode(value);
const storage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(plain, 'utf8').reverse(),
  decryptString: (data) => Buffer.from(data).reverse().toString('utf8'),
};
const SHOTS = { 'store/light.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6]), 'store/dark.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 7]) };
function withShots(files: ProjectFiles): ProjectFiles {
  const manifest = JSON.parse(text(files['manifest.json']));
  manifest.store = { ...manifest.store, screenshots: Object.keys(SHOTS) };
  return { ...files, ...SHOTS, 'manifest.json': enc(JSON.stringify(manifest, null, 2)) };
}
const failing = (report: CheckReport) => report.items.filter(i => i.status === 'fail').map(i => i.id);

async function main() {
  const app = path.join(temp, 'app');
  await buildDeveloperAssets({ app, esbuild });
  const templatesRoot = path.join(app, 'templates');
  ok('клиент flux.* и набор Flux собраны в рабочий каталог Studio', fs.existsSync(path.join(app, 'runtime/flux.v1.js')) && fs.existsSync(path.join(app, 'runtime/flux-ui.v1.css')));
  const check = (files: ProjectFiles, changelog = 'Первая версия') => runChecks({ files, changelog, studioVersion: '1.0.0', engine: null });

  console.log('Заготовка «страница»: каждый язык');
  const created: Record<string, ProjectFiles> = {};
  for (const id of TEMPLATE_IDS.filter(t => t !== 'translator')) {
    const files = created[id] = createFromTemplate(templatesRoot, id, { id: `page-${id}`, name: `Страница ${id}`, author: 'Разработчик' }, 'page');
    const manifest = JSON.parse(text(files['manifest.json']));
    ok(`${id}: договор v2, ui=page, формы нет`, manifest.contractVersion === 2 && manifest.ui === 'page' && !files['form.json']);
    ok(`${id}: ui/index.html, app.js, style.css и типы flux.* на месте`, ['ui/index.html', 'ui/app.js', 'ui/style.css', 'types/flux.d.ts'].every(n => files[n]?.length));
    const report = await check(withShots(files));
    ok(`${id}: проверка проходит (${report.items.map(i => `${i.id}:${i.status}`).join(' ')})`, report.ok && failing(report).length === 0);
  }
  ok('пример-заготовка со страницей не создаётся', (() => { try { createFromTemplate(templatesRoot, 'translator', { id: 'tr-one', name: 'Т', author: 'Р' }, 'page'); } catch { return true; } return false; })());
  ok('форма по-прежнему создаётся по умолчанию', (() => { const f = createFromTemplate(templatesRoot, 'typescript', { id: 'form-one', name: 'Форма', author: 'Р' }); return !!f['form.json'] && !f['ui/index.html'] && JSON.parse(text(f['manifest.json'])).contractVersion === 1; })());

  console.log('Мутации: проверка страницы должна падать');
  const base = withShots(created.typescript);
  const page = (file: string) => text(base[file]);
  const mutate = (name: string, files: ProjectFiles, id: string) => check(files).then(r => ok(`${name} → «не прошло»: ${id}`, failing(r).includes(id)));
  await mutate('fetch в скрипте страницы', { ...base, 'ui/app.js': enc(`${page('ui/app.js')}\nfetch('https://example.com');`) }, 'page-csp');
  await mutate('WebSocket', { ...base, 'ui/app.js': enc(`${page('ui/app.js')}\nnew WebSocket('wss://x');`) }, 'page-csp');
  await mutate('localStorage', { ...base, 'ui/app.js': enc(`${page('ui/app.js')}\nlocalStorage.x = 1;`) }, 'page-csp');
  await mutate('eval', { ...base, 'ui/app.js': enc(`${page('ui/app.js')}\neval('1');`) }, 'page-csp');
  await mutate('выход в родительское окно', { ...base, 'ui/app.js': enc(`${page('ui/app.js')}\nparent.document.title = 'x';`) }, 'page-csp');
  await mutate('встроенный скрипт', { ...base, 'ui/index.html': enc(page('ui/index.html').replace('</body>', '<script>alert(1)</script></body>')) }, 'page-csp');
  await mutate('встроенный стиль', { ...base, 'ui/index.html': enc(page('ui/index.html').replace('<main ', '<main style="color:red" ')) }, 'page-csp');
  await mutate('обработчик onclick', { ...base, 'ui/index.html': enc(page('ui/index.html').replace('id="run"', 'id="run" onclick="x()"')) }, 'page-csp');
  await mutate('внешний скрипт по адресу', { ...base, 'ui/index.html': enc(page('ui/index.html').replace('</body>', '<script src="https://cdn.example.com/x.js"></script></body>')) }, 'page-csp');
  await mutate('внешний адрес в стилях', { ...base, 'ui/style.css': enc(`@import url("https://fonts.example.com/x.css");\n${page('ui/style.css')}`) }, 'page-csp');
  await mutate('жёсткие цвета без токенов', { ...base, 'ui/index.html': enc(page('ui/index.html').replace(/<link rel="stylesheet" href="\/_flux[^>]*>\n?/, '')), 'ui/style.css': enc('body { background: #ffffff; color: #000; }'), 'ui/app.js': enc('document.title = "x";') }, 'page-themes');
  await mutate('недопустимый тип файла в странице', { ...base, 'ui/tool.exe': enc('MZ') }, 'contract');
  await mutate('нет ui/index.html', Object.fromEntries(Object.entries(base).filter(([k]) => k !== 'ui/index.html')), 'contract');
  await mutate('объявлена страница, которой нет', (() => { const m = JSON.parse(text(base['manifest.json'])); m.pages = ['absent.html']; return { ...base, 'manifest.json': enc(JSON.stringify(m)) }; })(), 'contract');
  const patchManifest = (files: ProjectFiles, fn: (m: any) => void): ProjectFiles => { const m = JSON.parse(text(files['manifest.json'])); fn(m); return { ...files, 'manifest.json': enc(JSON.stringify(m)) }; };
  await mutate('нет store.requires.flux у страницы', patchManifest(base, m => { delete m.store.requires; }), 'contract');
  await mutate('store.requires.flux старше первой версии со страницами', patchManifest(base, m => { m.store.requires = { flux: '1.0.0' }; }), 'contract');
  const broken = await check({ ...Object.fromEntries(Object.entries(base).filter(([k]) => k !== 'ui/index.html')), 'ui/tool.exe': enc('MZ') });
  const contractItem = broken.items.find(i => i.id === 'contract')!;
  ok('при ошибках договора пункт показывает причины, а не «соответствует»', contractItem.status === 'fail' && /ui\/index\.html/.test(contractItem.detail) && !/соответствует договору v/.test(contractItem.detail));
  const viaBridge = await check({ ...base, 'ui/app.js': enc(`${page('ui/app.js')}\nflux.net.fetch('api', '/x');`) });
  ok('flux.net.fetch через мост проверка не считает сетевым вызовом', !failing(viaBridge).includes('page-csp'));

  console.log('Разрешения сети: интернет и локальная сеть');
  const NET = 'Показывает курсы валют из открытого сервиса';
  const LAN = 'Находит принтеры и контроллеры в сети предприятия';
  const withNet = (code: string, permissions: Array<{ kind: string; does: string }> | null, contractVersion = 3): ProjectFiles =>
    patchManifest({ ...base, 'ui/app.js': enc(`${page('ui/app.js')}\n${code}`) }, m => { if (permissions) { m.permissions = permissions; m.contractVersion = contractVersion; } });
  const netItem = async (files: ProjectFiles) => (await check(files)).items.find(i => i.id === 'page-net')!;
  const internetCall = "flux.net.fetch('https://api.example.com/rates?base=EUR');";
  ok('адрес в интернете с разрешением internet и v3 — проверка проходит', (await check(withNet(internetCall, [{ kind: 'internet', does: NET }]))).ok);
  ok('адрес в интернете без permissions → page-net', (await netItem(withNet(internetCall, null))).status === 'fail');
  ok('адрес в локальной сети при одном internet → page-net', (await netItem(withNet("flux.net.fetch('http://192.168.1.20/status');", [{ kind: 'internet', does: NET }]))).status === 'fail');
  ok('адрес в локальной сети с lan — проходит', (await check(withNet("flux.net.fetch('http://192.168.1.20/status');", [{ kind: 'lan', does: LAN }]))).ok);
  for (const url of ['http://127.0.0.1:8080/x', 'http://localhost/x', 'http://169.254.169.254/latest/meta-data/', 'http://0.0.0.0/']) {
    ok(`заведомо закрытый адрес ${url} → page-net даже с обоими разрешениями`, (await netItem(withNet(`flux.net.fetch('${url}');`, [{ kind: 'internet', does: NET }, { kind: 'lan', does: LAN }]))).status === 'fail');
  }
  ok('разрешение объявлено, а flux.net.fetch нет → page-net (лишнее не просим)', (await netItem(withNet('', [{ kind: 'internet', does: NET }]))).status === 'fail');
  ok('подключение http и прежняя форма fetch(connection, path) без permissions — не ошибка', (await netItem({ ...patchManifest(base, m => { m.connections = [{ id: 'api', kind: 'http', app: 'Сервер расчётов', does: 'Отправляет данные на расчёт', access: 'send', url: 'http://127.0.0.1:8123', pathPrefix: '/api' }]; }), 'ui/app.js': enc(`${page('ui/app.js')}\nflux.net.fetch('api', '/x');`) })).status === 'ok');
  ok('адрес из переменной не угадывается: с разрешением ошибки нет', (await netItem(withNet('const u = location.hash; flux.net.fetch(u);', [{ kind: 'internet', does: NET }]))).status === 'ok');
  await mutate('permissions в договоре v2 → contract', withNet(internetCall, [{ kind: 'internet', does: NET }], 2), 'contract');
  ok('причина — формат v3, а не общая фраза', /contractVersion 3/.test((await check(withNet(internetCall, [{ kind: 'internet', does: NET }], 2))).items.find(i => i.id === 'contract')!.detail));
  await mutate('permissions без текста для человека → contract', withNet(internetCall, [{ kind: 'internet', does: 'x' }]), 'contract');
  await mutate('permissions с адресом вместо слов → contract', withNet(internetCall, [{ kind: 'internet', does: 'Ходит на https://api.example.com за курсами' }]), 'contract');
  await mutate('permissions у программы с формой → contract', patchManifest(createFromTemplate(templatesRoot, 'typescript', { id: 'form-net', name: 'Форма', author: 'Р' }), m => { m.permissions = [{ kind: 'internet', does: NET }]; m.contractVersion = 3; }), 'contract');
  ok('в типах flux.d.ts обе формы fetch и пояснение про permissions', /fetch\(url: string, init\?: FluxFetchInit\)/.test(fluxPageTypes()) && /fetch\(connection: string, path: string, init\?: FluxFetchInit\)/.test(fluxPageTypes()) && /permissions/.test(fluxPageTypes()));
  ok('Studio знает действие runNet (пробный запуск ходит в сеть как Flux)', (require('../studio/shell/actions') as typeof import('../studio/shell/actions')).ALL_ACTIONS.includes('runNet'));

  console.log('Обращения к другим программам и методы exports');
  const CALL = 'Берёт у калькулятора курсов пересчёт сумм для отчёта';
  const EXPDO = 'Пересчитывает сумму из одной валюты в другую по курсу';
  const withCall = (code: string, permissions: Array<Record<string, unknown>> | null, contractVersion = 3): ProjectFiles =>
    patchManifest({ ...base, 'ui/app.js': enc(`${page('ui/app.js')}\n${code}`) }, m => { if (permissions) { m.permissions = permissions; m.contractVersion = contractVersion; } });
  const programsItem = async (files: ProjectFiles) => (await check(files)).items.find(i => i.id === 'page-programs');
  const allowRates = [{ kind: 'program', program: 'rates', does: CALL }];
  const rateCall = "flux.programs.call('rates', 'convert', { amount: 100 });";
  ok('обращение с разрешением на эту программу и v3 — проверка проходит', (await check(withCall(rateCall, allowRates))).ok);
  ok('обращение без permissions → page-programs', (await programsItem(withCall(rateCall, null)))?.status === 'fail');
  ok('обращение к другой программе, чем в permissions → page-programs', (await programsItem(withCall("flux.programs.call('prices', 'convert', {});", allowRates)))?.status === 'fail');
  ok('причина называет программу и нужную запись манифеста', /prices/.test((await programsItem(withCall("flux.programs.call('prices', 'convert', {});", allowRates)))!.detail) && /"kind": "program"/.test((await programsItem(withCall(rateCall, null)))!.detail));
  ok('вызов самой себя → page-programs', (await programsItem(withCall(`flux.programs.call('${JSON.parse(text(base['manifest.json'])).id}', 'convert', {});`, allowRates)))?.status === 'fail');
  ok('кривое имя метода → page-programs', (await programsItem(withCall("flux.programs.call('rates', 'Convert-it', {});", allowRates)))?.status === 'fail');
  ok('разрешение объявлено, а обращения в коде нет → page-programs', (await programsItem(withCall('', allowRates)))?.status === 'fail');
  ok('все обращения словами, а одно разрешение лишнее → page-programs', (await programsItem(withCall(rateCall, [...allowRates, { kind: 'program', program: 'prices', does: CALL }])))?.status === 'fail');
  ok('идентификатор из переменной не угадывается: с разрешением ошибки нет', (await programsItem(withCall('const id = location.hash.slice(1); flux.programs.call(id, "convert", {});', allowRates)))?.status === 'ok');
  ok('страница без обращений и без разрешений — пункта нет', (await programsItem(base)) === undefined);
  await mutate('permissions program в договоре v2 → contract', withCall(rateCall, allowRates, 2), 'contract');
  ok('причина — формат v3', /contractVersion 3/.test((await check(withCall(rateCall, allowRates, 2))).items.find(i => i.id === 'contract')!.detail));
  await mutate('разрешение program на самого себя → contract', withCall(rateCall, [{ kind: 'program', program: JSON.parse(text(base['manifest.json'])).id, does: CALL }]), 'contract');
  await mutate('разрешение program без текста для человека → contract', withCall(rateCall, [{ kind: 'program', program: 'rates', does: 'x' }]), 'contract');
  await mutate('разрешение program без идентификатора → contract', withCall(rateCall, [{ kind: 'program', does: CALL }]), 'contract');
  const py = created.python;
  const withExports = (files: ProjectFiles, list: Array<Record<string, unknown>> | null, extraSource = '', contractVersion = 3): ProjectFiles =>
    patchManifest(extraSource ? { ...files, 'logic/main.py': enc(`${text(files['logic/main.py'])}\n${extraSource}`) } : files, m => { if (list) { m.exports = list; m.contractVersion = contractVersion; } });
  const exportsItem = async (files: ProjectFiles) => (await check(files)).items.find(i => i.id === 'exports');
  ok('метод в exports, имя которого есть в logic/main.py — проходит', (await exportsItem(withExports(py, [{ method: 'convert', does: EXPDO }], 'def export_convert(data): return data  # convert')))?.status === 'ok');
  ok('метод объявлен, а имени в logic/main.py нет → exports', (await exportsItem(withExports(py, [{ method: 'convertRates', does: EXPDO }])))?.status === 'fail');
  const ts = created.typescript;
  const tsWith = (files: ProjectFiles, list: Array<Record<string, unknown>>, edit: (source: string) => string = x => x): ProjectFiles =>
    patchManifest({ ...files, 'logic/main.ts': enc(edit(text(files['logic/main.ts']))) }, m => { m.exports = list; m.contractVersion = 3; });
  const tsExports = [{ method: 'convert', does: EXPDO }];
  ok('метод на TypeScript: compute экспортирована и имя метода есть в logic/main.ts — проходит', (await exportsItem(tsWith(ts, tsExports, x => `${x}\n// convert`)))?.status === 'ok');
  ok('метод на TypeScript, имени которого нет в logic/main.ts → exports', (await exportsItem(tsWith(ts, tsExports)))?.status === 'fail');
  ok('метод на TypeScript без экспортируемой compute → exports', /нет экспортируемой функции compute/.test((await exportsItem(tsWith(ts, tsExports, x => `${x.replace('export function compute', 'function compute')}\n// convert`)))?.detail || ''));
  ok('логика, которая не собирается в build/logic.js → exports', /не собирается/.test((await exportsItem(tsWith(ts, tsExports, x => `${x}\n// convert\nexport const = ;`)))?.detail || ''));
  ok('логика из нескольких файлов не собирается в один build/logic.js → exports', /один файл/.test((await exportsItem(tsWith(ts, tsExports, x => `import './x';\n${x}\n// convert`)))?.detail || ''));
  const tsNoControls = tsWith(ts, tsExports, x => `${x}\n// convert`); delete tsNoControls['examples/controls.json'];
  ok('метод на TypeScript без контрольных примеров → controls', (await check(tsNoControls)).items.find(i => i.id === 'controls')?.status === 'fail');
  ok('без exports логика на обработчиках без compute и без примеров — по-прежнему «не проверяется автоматически»', await (async () => { const f = { ...ts, 'logic/main.ts': enc(text(ts['logic/main.ts']).replace('export function compute', 'function compute')) }; delete f['examples/controls.json']; return (await check(f)).items.find(i => i.id === 'controls')?.status === 'manual'; })());
  ok('без exports пункта нет', (await exportsItem(py)) === undefined);
  await mutate('exports в договоре v2 → contract', withExports(py, [{ method: 'convert', does: EXPDO }], 'convert', 2), 'contract');
  ok('причина — формат v3 и exports названы', /exports.*v3/.test((await check(withExports(py, [{ method: 'convert', does: EXPDO }], 'convert', 2))).items.find(i => i.id === 'contract')!.detail));
  await mutate('имя метода с заглавной буквы → contract', withExports(py, [{ method: 'Convert', does: EXPDO }], 'Convert'), 'contract');
  await mutate('метод без текста для человека → contract', withExports(py, [{ method: 'convert', does: 'x' }], 'convert'), 'contract');
  ok('в типах flux.d.ts есть flux.programs.call с кодами ошибок', /programs: \{ call\(program: string, method: string, data\?: unknown\)/.test(fluxPageTypes()) && /NOT_INSTALLED/.test(fluxPageTypes()) && /NO_METHOD/.test(fluxPageTypes()));
  const trial = trialProgramCall({ program: 'rates', method: 'convert', data: { amount: 5 } });
  ok('пробный запуск отвечает NOT_INSTALLED и пишет строку в журнал, без данных вызова', !trial.reply.ok && (trial.reply as { code: string }).code === 'NOT_INSTALLED' && /rates.*convert.*NOT_INSTALLED/.test(trial.line) && !/amount/.test(trial.line));

  console.log('Пакет страницы');
  const keyring = new DeveloperKeyring(path.join(temp, 'keys'), storage);
  const dev = keyring.create();
  const rootKey = crypto.generateKeyPairSync('ed25519').privateKey, rootHex = publicHexOf(rootKey);
  const certs = readCertificates([sealEnvelope('certificate', { v: 1, key: dev.publicKey, userId: 'd', name: 'Р', iat: Date.now() }, rootKey)], rootHex, { releases: new Set(), keys: new Set() });
  const ready = base;
  const report = await check(ready);
  const built = buildRequest(keyring, { moduleId: 'page-typescript', version: '0.1.0', files: ready, runtime: '', baseRelease: null, parentRequest: null, channel: 'test', changelog: 'Первая версия', comment: '', report, studioVersion: '1.0.0' });
  const verified = verifyRequest({ signature: built.signature, bundle: built.bundle, rootHex, certificates: certs });
  ok('запрос со страницей принимается проверкой сервера', verified.ok && verified.manifest.ui === 'page' && verified.claim.meta.contractVersion === 2);
  const files = unpackBundle(built.bundle);
  ok('в пакете страница и типы, runtime.js нет', files['ui/index.html'] && files['ui/app.js'] && files['types/flux.d.ts'] && !files['build/runtime.js']);
  const withRuntime = (() => {
    const bundleFiles = { ...files, 'build/runtime.js': enc('/* x */') };
    const signed = buildRequest(keyring, { moduleId: 'page-typescript', version: '0.1.0', files: bundleFiles, runtime: '/* x */', baseRelease: null, parentRequest: null, channel: 'test', changelog: 'x', comment: '', report, studioVersion: '1.0.0' });
    return verifyRequest({ signature: signed.signature, bundle: signed.bundle, rootHex, certificates: certs });
  })();
  ok('страница с runtime.js владельцу не доходит', !withRuntime.ok);

  console.log('Типы flux.*');
  const types = fluxPageTypes();
  ok('в типах все ресурсы договора', resources.every(r => types.includes(`'${r}'`)));
  ok('в типах мост: read, compute, state, net, saveFile, windows, onTheme', ['read<', 'compute(', 'state:', 'net:', 'saveFile(', 'windows:', 'onTheme('].every(x => types.includes(x)));
  ok('в типах нет методов записи в данные Flux', !/\b(?:write|update|delete|create)\w*\s*\(/.test(types.replace('windows', '')));
  ok('в типах окна программы: flux.dialogs, flux.window.setTitle/setUnsaved, options у windows.open', ['dialogs: {', 'confirm(options', 'alert(options', 'prompt(options', 'setTitle(text: string)', 'setUnsaved(unsaved: boolean', 'options?: { title?: string; width?: number; height?: number }'].every(x => types.includes(x)));
  const dialogHtml = (request: any) => renderToStaticMarkup(React.createElement(RunDialog, { program: 'Ведомость', request, onAnswer: () => undefined }));
  const confirmHtml = dialogHtml({ kind: 'confirm', title: 'Удалить?', text: 'Строка <b>5</b>', ok: 'Удалить', danger: true });
  ok('диалог Studio: название программы и заголовок в шапке, кнопки программы, текст экранирован', /Ведомость — Удалить\?/.test(confirmHtml) && />Удалить</.test(confirmHtml) && />Отмена</.test(confirmHtml) && !/<b>5<\/b>/.test(confirmHtml) && /&lt;b&gt;5/.test(confirmHtml));
  ok('диалог Studio: у сообщения одна кнопка, у строки ввода — поле с пределом', !/>Отмена</.test(dialogHtml({ kind: 'alert', title: 'a', text: 'b' })) && /maxLength="30"|maxlength="30"/i.test(dialogHtml({ kind: 'prompt', title: 'a', label: 'Имя', maxLength: 30 })));
  console.log(`\nПроверок: ${passed}`);
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
