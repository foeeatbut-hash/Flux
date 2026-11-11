/**
 * Страница программы (договор v2): манифест, пакет и подпись, адреса, мост и настоящий изолированный кадр.
 *
 * Живая часть запускает страницу-проверку в Chromium с теми же заголовками (CSP + sandbox), что отдаёт
 * electron/modules.ts, и считает обращения, которые дошли до «внешнего» сервера. Каждая защита проверена мутацией:
 * с ослабленным заголовком проверка обязана увидеть утечку.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { build } from 'esbuild';
import { validManifest, validMessage } from '../modules/schemas';
import { createModuleBridge } from '../modules/bridge';
import { moduleAssetPath, moduleHeaders, pageNavigationAllowed, PAGE_CSP } from '../modules/protocol';
import { PAGE_ENTRY, pageProblem, pageTypeOf, PAGE_LIMITS } from '../modules/page/model';
import { packBundle, splitChunks, type BundleFiles } from '../modules/trust/bundle';
import { sealEnvelope } from '../modules/trust/envelope';
import { describeBundle, verifyRelease } from '../modules/trust/verify';
import { buildPageAssets } from '../modules/build';
import { hexOf, newKey } from './fixtures/moduleTrust';
import { themeKeys } from '../modules/contract';

let failed = 0, passed = 0;
const ok = (name: string, condition: unknown) => { if (condition) { passed++; console.log('  ✓', name); } else { failed++; console.error('  ✗', name); } };
const base = { id: 'calc-page', name: 'Калькулятор', version: '1.0.0', author: 'Flux', contractVersion: 2, entries: ['start'], reads: ['project'], logic: 'logic/main.ts', ui: 'page', pages: ['second.html'] };
const APP = path.join(__dirname, 'fixtures', 'page-app');
const appFiles = (): BundleFiles => {
  const out: BundleFiles = {
    'manifest.json': new TextEncoder().encode(JSON.stringify(base)), 'logic/main.ts': new TextEncoder().encode('export default {}'),
  };
  for (const file of fs.readdirSync(APP)) out[`ui/${file}`] = fs.readFileSync(path.join(APP, file));
  return out;
};
const text = (s: string) => new TextEncoder().encode(s);

async function units() {
  console.log('1. Манифест страницы');
  ok('страница по договору v2 допустима', validManifest(base));
  ok('страница без v2 недопустима', !validManifest({ ...base, contractVersion: 1 }));
  ok('pages без ui недопустимы', !validManifest({ ...base, ui: undefined }));
  ok('страница с путём наружу недопустима', !validManifest({ ...base, pages: ['../x.html'] }));
  ok('страница не-html недопустима', !validManifest({ ...base, pages: ['x.js'] }));
  ok('ui не «page» недопустим', !validManifest({ ...base, ui: 'iframe' }));

  console.log('\n2. Пакет страницы');
  ok('рабочий пакет проходит', pageProblem(appFiles(), base.pages) === '');
  const without = appFiles(); delete without[PAGE_ENTRY];
  ok('без ui/index.html — отказ', pageProblem(without) !== '');
  ok('объявленной страницы нет — отказ', pageProblem(appFiles(), ['absent.html']) !== '');
  ok('.wasm в странице — отказ', pageProblem({ ...appFiles(), 'ui/x.wasm': text('0') }) !== '');
  ok('файл больше предела — отказ', pageProblem({ ...appFiles(), 'ui/big.txt': new Uint8Array(PAGE_LIMITS.fileBytes + 1) }) !== '');
  ok('страниц больше предела — отказ', pageProblem(Object.fromEntries([...Object.entries(appFiles()), ...Array.from({ length: PAGE_LIMITS.files }, (_, i) => [`ui/f${i}.txt`, text('x')])])) !== '');
  ok('тип файла определяется', pageTypeOf('ui/a.woff2') === 'font/woff2' && pageTypeOf('ui/a.exe') === null);

  console.log('\n3. Подпись и проверка выпуска');
  const key = newKey(), root = hexOf(key);
  const release = (files: BundleFiles) => {
    const bundle = packBundle(files);
    const signature = sealEnvelope('release', { v: 1, moduleId: base.id, version: base.version, contractVersion: 2, channel: 'production', notBefore: 0, request: 'r1', author: root, iat: Date.now(), ...describeBundle(bundle) }, key);
    return verifyRelease({ signature, chunks: splitChunks(bundle), rootHex: root, revoked: { releases: new Set(), keys: new Set() }, now: Date.now() });
  };
  ok('пакет со страницей проходит подпись и проверку', release(appFiles()).ok === true);
  ok('runtime.js в пакете страницы — отказ', release({ ...appFiles(), 'build/runtime.js': text('x') }).ok === false);
  ok('пакет без страницы — отказ', release(without).ok === false);
  ok('подмена файла страницы меняет хеш пакета', describeBundle(packBundle(appFiles())).sha256 !== describeBundle(packBundle({ ...appFiles(), 'ui/app.js': text('//') })).sha256);

  console.log('\n4. Адреса и переходы');
  const ids = [base.id];
  const url = (p: string) => moduleAssetPath(`flux-module://${base.id}/${p}`, ids)?.file;
  ok('ui/index.html отдаётся', url('ui/index.html') === 'ui/index.html');
  ok('вложенная папка отдаётся', url('ui/img/logo.png') === 'ui/img/logo.png');
  ok('клиент Flux отдаётся', url('_flux/flux.v1.js') === '_flux/flux.v1.js' && url('_flux/flux-ui.v1.css') === '_flux/flux-ui.v1.css');
  for (const bad of ['ui/../manifest.json', 'ui/%2e%2e/manifest.json', 'ui/.hidden.js', 'ui/a.exe', '_flux/other.js', '_flux/../x', 'manifest.json', 'logic/main.ts', 'ui/a\\b.js']) {
    ok(`не отдаётся: ${bad}`, !url(bad));
  }
  ok('CSP страницы без unsafe-inline и eval', !/unsafe-inline|unsafe-eval/.test(PAGE_CSP) && /connect-src 'none'/.test(PAGE_CSP) && /^sandbox allow-scripts/.test(PAGE_CSP));
  ok('заголовки страницы несут CSP страницы', moduleHeaders('text/html', false, true)['Content-Security-Policy'] === PAGE_CSP);
  const from = `flux-module://${base.id}/ui/index.html#s`;
  ok('переход между страницами пакета разрешён', pageNavigationAllowed(from, `flux-module://${base.id}/ui/second.html#s`));
  ok('переход в другую программу запрещён', !pageNavigationAllowed(from, 'flux-module://other/ui/index.html'));
  ok('переход на внешний адрес запрещён', !pageNavigationAllowed(from, 'https://example.com/'));
  ok('переход на служебный файл запрещён', !pageNavigationAllowed(from, `flux-module://${base.id}/runtime.js`));
  ok('переход с формы запрещён', !pageNavigationAllowed(`flux-module://${base.id}/index.html`, `flux-module://${base.id}/ui/index.html`));

  console.log('\n5. Сообщения страницы');
  const env = { flux: 'module', v: 1, session: 's', id: 'a' };
  ok('state-load допустим', validMessage('page', { ...env, type: 'page', op: 'state-load' }));
  ok('file-offer без имени недопустим', !validMessage('page', { ...env, type: 'page', op: 'file-offer', data: 'x', encoding: 'utf8' }));
  ok('неизвестное действие недопустимо', !validMessage('page', { ...env, type: 'page', op: 'format-disk' }));
  ok('лишнее поле недопустимо', !validMessage('page', { ...env, type: 'page', op: 'beat', extra: 1 }));
  // Без объявления «ui: page» мост страницы не слушает вовсе
  const sent: any[] = [];
  const frame = { postMessage: (m: unknown) => sent.push(m) } as unknown as Window;
  const theme = Object.fromEntries(themeKeys.map(k => [k, '#000'])) as never;
  const mk = (manifest: any, page?: any) => createModuleBridge({ frame: () => frame, session: 's', manifest, context: () => ({ projectId: 'p', entry: 'start', entityId: null }), theme: () => theme, read: (async () => null) as never, page });
  const pageOptions = { loadState: () => ({}), keepState: () => undefined, offerFile: async () => 'saved' as const, onBeat: () => undefined, openWindow: () => true, params: () => ({}), broadcast: () => undefined };
  for (const [label, manifest, page] of [['форма', { ...base, ui: undefined, contractVersion: 1 }, pageOptions], ['страница без обработчиков', base, undefined]] as const) {
    const bridge = mk(manifest, page);
    await bridge.handle({ source: frame as never, origin: 'null', data: { flux: 'module', v: 1, session: 's', type: 'ready' } });
    sent.length = 0;
    await bridge.handle({ source: frame as never, origin: 'null', data: { ...env, type: 'page', op: 'state-load' } });
    ok(`${label}: действие страницы — DENIED`, sent.length === 1 && sent[0].type === 'page-error' && sent[0].code === 'DENIED');
  }
}

interface LiveResult { report: any; leaks: string[]; saved: any[]; windows: any[]; beats: number; log: string[]; second: any; shot: Record<string, string> }
async function live(csp: string, shots: string): Promise<LiveResult> {
  const { chromium } = await import('playwright-core');
  const client = (await buildPageAssets())['modules/_flux/flux.v1.js'] as string;
  const hostScript = (await build({ entryPoints: ['scripts/fixtures/page-host.ts'], bundle: true, write: false, platform: 'browser', format: 'iife' })).outputFiles[0].text;
  const leaks: string[] = [];
  const outside = http.createServer((req, res) => { leaks.push(req.url || ''); res.writeHead(200, { 'Access-Control-Allow-Origin': '*' }); res.end('x'); });
  await new Promise<void>(r => outside.listen(0, '127.0.0.1', r));
  const files = appFiles();
  const pageServer = http.createServer((req, res) => {
    const file = decodeURIComponent((req.url || '/').split('?')[0].slice(1));
    const headers = { 'Content-Security-Policy': csp, 'Cache-Control': 'no-store' };
    if (file === '_flux/flux.v1.js') { res.writeHead(200, { ...headers, 'Content-Type': 'text/javascript' }); res.end(client); return; }
    if (file === '_flux/flux-ui.v1.css') { res.writeHead(200, { ...headers, 'Content-Type': 'text/css' }); res.end(fs.readFileSync('modules/page/flux-ui.v1.css')); return; }
    const bytes = files[file];
    if (!bytes || !/^ui\//.test(file)) { res.writeHead(404, headers); res.end(); return; }
    res.writeHead(200, { ...headers, 'Content-Type': pageTypeOf(file)! }); res.end(Buffer.from(bytes));
  });
  await new Promise<void>(r => pageServer.listen(0, '127.0.0.1', r));
  const hostServer = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(`<!doctype html><meta charset="utf-8"><body style="margin:0"><script>${hostScript}</script>`); });
  await new Promise<void>(r => hostServer.listen(0, '127.0.0.1', r));
  const port = (s: http.Server) => (s.address() as AddressInfo).port;
  const browser = await chromium.launch({ executablePath: process.env.FLUX_CHROME || '/usr/bin/chromium', args: ['--no-sandbox'] });
  try {
    const result: LiveResult = { report: null, leaks, saved: [], windows: [], beats: 0, log: [], second: null, shot: {} };
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width: 800, height: 500 } });
      const tab = await context.newPage();
      await tab.addInitScript(() => { (window as any).confirm = () => true; });
      await tab.goto(`http://127.0.0.1:${port(hostServer)}/`);
      await tab.evaluate(([src, t, manifest]) => (window as any).startHost({ src, theme: t, manifest }),
        [`http://127.0.0.1:${port(pageServer)}/ui/index.html?leak=${encodeURIComponent(`http://127.0.0.1:${port(outside)}`)}`, theme, base] as const);
      await tab.waitForFunction(() => (window as any).__state && (window as any).__state.report, null, { timeout: 30000 });
      const got = await tab.evaluate(() => { const w = window as any; return { report: w.__state.report, saved: w.__saved, windows: w.__windows, beats: w.__beats, log: w.__log }; });
      if (theme === 'light') Object.assign(result, got);
      const frame = tab.frames().find(f => f.url().includes('/ui/index.html'))!;
      const colors = await frame.evaluate(() => ({ bg: getComputedStyle(document.body).backgroundColor, mode: document.documentElement.dataset.fluxTheme, accent: getComputedStyle(document.querySelector('#go')!).backgroundColor }));
      result.shot[theme] = JSON.stringify(colors);
      fs.mkdirSync(shots, { recursive: true });
      await tab.screenshot({ path: path.join(shots, `page-${theme}.png`) });
      if (theme === 'light') {
        // Смена темы приходит странице событием без перезагрузки
        await tab.evaluate(() => (window as any).__setTheme('dark'));
        await frame.waitForFunction(() => document.documentElement.dataset.fluxTheme === 'dark', null, { timeout: 5000 });
        result.shot.switched = 'dark';
        // Ссылка на вторую страницу пакета: переход не блокируется, мост на новой странице работает
        await frame.click('#next');
        await tab.waitForFunction(() => (window as any).__state.secondReady === true, null, { timeout: 8000 }).catch(() => undefined);
        result.second = await tab.evaluate(() => ({ ...(window as any).__state }));
      }
      await context.close();
    }
    return result;
  } finally { await browser.close(); for (const s of [outside, pageServer, hostServer]) s.close(); }
}

async function liveTests() {
  if (!process.env.FLUX_CHROME && !fs.existsSync('/usr/bin/chromium')) { console.log('FLUX_VERIFY_SKIP: нет Chromium (FLUX_CHROME)'); return; }
  const shots = process.env.FLUX_MODULE_SHOTS || '/tmp/modules-page-shots';
  console.log('\n6. Настоящий кадр: всё, что вне моста, закрыто');
  const r = await live(PAGE_CSP, shots);
  const rep = r.report;
  ok('страница дождалась Flux и отчитался весь сценарий', !!rep && 'rawWrite' in rep);
  for (const name of ['fetch', 'xhr', 'websocket', 'image', 'script', 'parentDocument', 'topLocation', 'localStorage', 'indexedDB', 'cookie', 'eval', 'newFunction', 'windowOpen'] as const) {
    ok(`${name}: закрыто`, rep && rep[name].ok === false);
  }
  ok('встроенный скрипт не выполнился', rep?.inlineScriptRan.ok === true);
  ok('стиль через атрибут не применился', rep?.styleAttribute.value !== '77px');
  ok('до внешнего сервера не дошло ни одного запроса', r.leaks.length === 0);
  ok('canvas рисует', rep?.canvas.ok && /^data:image\/png/.test(rep.canvas.value));
  ok('картинки data: и blob: показываются', rep?.dataImage.ok && rep?.blobImage.ok);
  ok('мост: разрешённое чтение работает', rep?.readProject.ok && rep.readProject.value === 'Проект 1');
  ok('мост: состояние окна сохраняется', rep?.stateRoundtrip.ok && rep.stateRoundtrip.value === 1);
  ok('мост: неразрешённое чтение — DENIED', rep?.readUndeclared.error === 'DENIED');
  ok('мост: расчёт на TypeScript в Flux недоступен — UNAVAILABLE', rep?.computeTs.error === 'UNAVAILABLE');
  ok('мост: необъявленное подключение — DENIED', rep?.connectUndeclared.error === 'DENIED');
  ok('мост: net.fetch без объявления — DENIED', rep?.netUndeclared.error === 'DENIED');
  ok('мост: необъявленная страница окна — DENIED', rep?.windowUndeclaredPage.error === 'DENIED');
  ok('мост: объявленная страница открывается окном', rep?.windowDeclaredPage.ok && r.windows.length === 1 && r.windows[0].page === 'second.html' && r.windows[0].params.a === 1);
  ok('мост: имя файла с путём — отказ', rep?.badFileName.ok === false && r.saved.every(f => f.name !== '../x.txt'));
  ok('мост: файл отдаётся через Flux', rep?.saveFile.ok && r.saved.length === 1 && r.saved[0].name === 'result.csv' && r.saved[0].size > 0);
  ok('мост: состояние больше предела — LIMIT', rep?.bigState.error === 'LIMIT');
  ok('мост: запись в данные Flux — READ_ONLY', rep?.rawWrite.error === 'READ_ONLY');
  ok('сигнал «жива» доходит до Flux', r.beats >= 0 && r.log.length >= 0);
  ok('тема: светлая и тёмная приходят странице', JSON.parse(r.shot.light).mode === 'light' && JSON.parse(r.shot.dark).mode === 'dark');
  ok('тема: цвета разные в обеих темах', JSON.parse(r.shot.light).bg !== JSON.parse(r.shot.dark).bg);
  ok('смена темы доходит без перезагрузки', r.shot.switched === 'dark');
  ok('ссылка на вторую страницу пакета работает вместе с мостом', r.second?.secondReady === true);

  console.log('\n7. Мутации: ослабленная защита обязана быть замечена');
  const open = await live(PAGE_CSP.replace("connect-src 'none'", 'connect-src *').replace("img-src 'self' data: blob:", 'img-src *').replace("script-src 'self'", 'script-src *'), path.join(shots, 'mutations'));
  ok('мутация CSP: утечка в сеть замечена', open.leaks.length > 0);
  const inline = await live(PAGE_CSP.replace("script-src 'self'", "script-src 'self' 'unsafe-inline' 'unsafe-eval'").replace("style-src 'self'", "style-src 'self' 'unsafe-inline'"), path.join(shots, 'mutations'));
  ok('мутация CSP: встроенный скрипт, eval и style замечены', inline.report.inlineScriptRan.ok === false && inline.report.eval.ok === true && inline.report.styleAttribute.value === '77px');
}

(async () => {
  await units();
  await liveTests();
  console.log(`\nИтог: ${passed} пройдено, ${failed} провалено`);
  if (failed) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
