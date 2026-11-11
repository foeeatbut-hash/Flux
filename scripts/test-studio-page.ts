/**
 * Studio: проект со своей страницей (договор v2) — заготовка каждого языка, проверка перед отправкой, пакет без runtime.js.
 *
 * Что доказывается:
 * - заготовка «страница» для всех 7 языков создаёт проект, проходящий проверку; формы в нём нет, ui/ и типы flux.* есть;
 * - проверка падает на: сетевом вызове, встроенных скрипте и стиле, внешнем адресе, хранилище, eval, жёстких цветах без токенов,
 *   недопустимом типе файла, отсутствии ui/index.html;
 * - flux.net.fetch (через мост) проверкой не ругается;
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
import { unpackBundle } from '../modules/trust/bundle';
import { publicHexOf, sealEnvelope } from '../modules/trust/envelope';
import { readCertificates, verifyRequest } from '../modules/trust/verify';
import { resources } from '../modules/contract';

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
  const viaBridge = await check({ ...base, 'ui/app.js': enc(`${page('ui/app.js')}\nflux.net.fetch('api', '/x');`) });
  ok('flux.net.fetch через мост проверка не считает сетевым вызовом', !failing(viaBridge).includes('page-csp'));

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
  console.log(`\nПроверок: ${passed}`);
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
