/**
 * flux.openFile: программа просит файл пользователя (добавлено к договору v2, существующие вызовы не менялись).
 *
 * Что доказывается:
 * - схема сообщения: расширения в виде «.csv», до десяти; чужая форма отвергается, прежние действия страницы допустимы как раньше;
 * - мост: диалог показывает хост; без хоста или не из страницы — DENIED; отказ человека — CANCELLED; больше 512 КиБ — LIMIT;
 *   диалоги не чаще раза в секунду; имя файла до программы доходит без пути; содержимое — только выбранного файла;
 * - главный процесс Flux (modules/page/pickFile.ts): диалог, чтение только выбранного обычного файла, предел размера, отказ;
 * - настоящий кадр в Chromium: клиент flux.openFile отдаёт имя, размер, text() и bytes(), а отказ приходит ошибкой CANCELLED.
 *
 * Запуск: npx tsx scripts/test-modules-openfile.ts   (живая часть — FLUX_CHROME)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { build } from 'esbuild';
import { validMessage } from '../modules/schemas';
import { createModuleBridge } from '../modules/bridge';
import { themeKeys } from '../modules/contract';
import { openAcceptProblem, openFilters, PAGE_LIMITS, PAGE_MIN_FLUX } from '../modules/page/model';
import { pickForProgram, pickTitle, readPicked } from '../modules/page/pickFile';
import { buildPageAssets } from '../modules/build';
import { fluxPageTypes } from '../modules/page/types';
import { INVOKE_CHANNELS } from '../electron/ipcAllow';

let failed = 0, passed = 0;
const ok = (name: string, condition: unknown) => { if (condition) { passed++; console.log('  ✓', name); } else { failed++; console.error('  ✗', name); } };
const base = { id: 'pick-page', name: 'Читалка', version: '1.0.0', author: 'Flux', contractVersion: 2, entries: ['start'], reads: ['project'], logic: 'logic/main.ts', ui: 'page', store: { category: 'calc', summary: 'x', requires: { flux: PAGE_MIN_FLUX } } } as any;

async function units() {
  console.log('1. Расширения и фильтры диалога');
  ok('список не задан — допустимо', openAcceptProblem(undefined) === '');
  ok('".csv", ".txt" — допустимо', openAcceptProblem(['.csv', '.txt']) === '');
  for (const bad of [['csv'], ['.'], ['.c/v'], ['.слово'], [1], 'csv', Array.from({ length: 11 }, (_, i) => `.e${i}`), ['.toolongextension']]) ok(`не годится: ${JSON.stringify(bad).slice(0, 40)}`, openAcceptProblem(bad) !== '');
  const filters = openFilters(['.CSV', '.txt', '.csv']);
  ok('фильтры: нужные файлы без повторов и «все файлы» — выход из тупика', filters.length === 2 && filters[0].extensions.join() === 'csv,txt' && filters[1].extensions[0] === '*');
  ok('без расширений — только «все файлы»', openFilters([]).length === 1 && openFilters(undefined)[0].extensions[0] === '*');

  console.log('\n2. Схема сообщения');
  const env = { flux: 'module', v: 1, session: 's', id: 'p-1', type: 'page' };
  ok('file-pick без списка допустим', validMessage('page', { ...env, op: 'file-pick' }));
  ok('file-pick со списком допустим', validMessage('page', { ...env, op: 'file-pick', accept: ['.csv'] }));
  ok('расширение без точки недопустимо', !validMessage('page', { ...env, op: 'file-pick', accept: ['csv'] }));
  ok('больше десяти расширений недопустимо', !validMessage('page', { ...env, op: 'file-pick', accept: Array.from({ length: 11 }, (_, i) => `.e${i}`) }));
  ok('лишнее поле (путь) недопустимо', !validMessage('page', { ...env, op: 'file-pick', path: 'C:/secret.txt' }));
  ok('прежние действия допустимы как раньше', validMessage('page', { ...env, op: 'state-load' }) && validMessage('page', { ...env, op: 'file-offer', name: 'a.csv', data: 'x', encoding: 'utf8' }) && validMessage('page', { ...env, op: 'beat' }));
  ok('типы flux.d.ts для редактора знают openFile', /openFile\(options\?: \{ accept\?: string\[\] \}\)/.test(fluxPageTypes()) && /saveFile\(/.test(fluxPageTypes()));

  console.log('\n3. Мост');
  const sent: any[] = [];
  const frame = { postMessage: (m: unknown) => sent.push(m) } as unknown as Window;
  const theme = Object.fromEntries(themeKeys.map(k => [k, '#000'])) as never;
  const baseOptions = { loadState: () => ({}), keepState: () => undefined, offerFile: async () => 'saved' as const, onBeat: () => undefined, openWindow: () => true, params: () => ({}), broadcast: () => undefined };
  const make = (manifest: any, page: any) => createModuleBridge({ frame: () => frame, session: 's', manifest, context: () => ({ projectId: 'p', entry: 'start', entityId: null }), theme: () => theme, read: (async () => null) as never, page });
  let n = 0;
  const send = async (bridge: ReturnType<typeof make>, extra: Record<string, unknown> = {}) => {
    sent.length = 0;
    await bridge.handle({ source: frame as never, origin: 'null', data: { ...env, id: `p-${++n}`, op: 'file-pick', ...extra } });
    return sent[0];
  };
  const ready = async (bridge: ReturnType<typeof make>) => { await bridge.handle({ source: frame as never, origin: 'null', data: { flux: 'module', v: 1, session: 's', type: 'ready' } }); };
  const bytes = new TextEncoder().encode('a;b\n1;2\n');
  const requests: any[] = [];
  const hostReply = { value: { name: 'данные.csv', mime: 'text/csv', bytes } as any };
  const bridge = make(base, { ...baseOptions, pickFile: async (r: any) => { requests.push(r); return hostReply.value; } });
  await ready(bridge);
  let reply = await send(bridge, { accept: ['.csv'] });
  ok('файл отдан: имя, размер, содержимое base64', reply.type === 'page-result' && reply.data.name === 'данные.csv' && reply.data.size === bytes.length && reply.data.encoding === 'base64' && atob(reply.data.data) === 'a;b\n1;2\n');
  ok('хост получил только список расширений', requests.length === 1 && JSON.stringify(requests[0]) === '{"accept":[".csv"]}');
  reply = await send(bridge);
  ok('второй диалог сразу — LIMIT (не чаще раза в секунду)', reply.type === 'page-error' && reply.code === 'LIMIT' && requests.length === 1);
  await new Promise(r => setTimeout(r, 1050));
  hostReply.value = 'cancelled';
  reply = await send(bridge);
  ok('отказ человека — CANCELLED', reply.type === 'page-error' && reply.code === 'CANCELLED');
  await new Promise(r => setTimeout(r, 1050));
  hostReply.value = 'limit';
  reply = await send(bridge);
  ok('хост сказал «слишком большой» — LIMIT', reply.code === 'LIMIT');
  await new Promise(r => setTimeout(r, 1050));
  hostReply.value = { name: 'big.bin', mime: '', bytes: new Uint8Array(PAGE_LIMITS.openBytes + 1) };
  reply = await send(bridge);
  ok('хост ошибся с размером — мост всё равно LIMIT', reply.code === 'LIMIT');
  await new Promise(r => setTimeout(r, 1050));
  hostReply.value = { name: 'C:\\Users\\Иван\\Документы\\секрет.txt', mime: '', bytes };
  reply = await send(bridge);
  ok('путь в имени до программы не доходит', reply.type === 'page-result' && reply.data.name === 'секрет.txt');
  await new Promise(r => setTimeout(r, 1050));
  hostReply.value = { name: '../../etc/passwd', mime: '', bytes };
  reply = await send(bridge);
  ok('«..» и слэши в имени отрезаются', reply.data.name === 'passwd');
  await new Promise(r => setTimeout(r, 1050));
  const failing = make(base, { ...baseOptions, pickFile: async () => { throw new Error('диалог упал'); } });
  await ready(failing);
  reply = await send(failing);
  ok('сбой диалога — FAILED, а не молчание', reply.code === 'FAILED');
  const noHost = make(base, baseOptions);
  await ready(noHost);
  reply = await send(noHost);
  ok('хост без выбора файла (старый) — DENIED', reply.code === 'DENIED');
  const form = make({ ...base, ui: undefined, contractVersion: 1 }, { ...baseOptions, pickFile: async () => hostReply.value });
  await ready(form);
  reply = await send(form);
  ok('программа с формой файл не просит — DENIED', reply.code === 'DENIED');
  const bad = make(base, { ...baseOptions, pickFile: async () => hostReply.value });
  await ready(bad);
  reply = await send(bad, { accept: ['csv'] });
  ok('неверный список расширений — DENIED, диалог не открывался', reply.code === 'DENIED');

  console.log('\n4. Главный процесс Flux: чтение только выбранного файла');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-openfile-'));
  const chosen = path.join(temp, 'выбранный.csv'), neighbour = path.join(temp, 'соседний.txt');
  fs.writeFileSync(chosen, 'x;y\n'); fs.writeFileSync(neighbour, 'чужое');
  const shown: any[] = [];
  const reply1 = await pickForProgram({ program: 'Читалка', accept: ['.csv'] }, async o => { shown.push(o); return chosen; });
  ok('выбранный файл прочитан: имя без папки, содержимое', reply1.ok && reply1.name === 'выбранный.csv' && Buffer.from((reply1 as any).bytes).toString() === 'x;y\n');
  ok('в ответе нет пути и соседних файлов', JSON.stringify(Object.keys(reply1)) === '["ok","name","bytes"]' && !JSON.stringify(reply1).includes(temp));
  ok('диалог назван по программе и с фильтром', shown[0].title === pickTitle('Читалка') && /Читалка/.test(shown[0].title) && shown[0].filters[0].extensions.join() === 'csv');
  ok('отказ человека — CANCELLED', (await pickForProgram({ program: 'Читалка' }, async () => null) as any).code === 'CANCELLED');
  ok('неверный список — DENIED, диалог не показан', await (async () => { let called = false; const r = await pickForProgram({ program: 'x', accept: ['csv'] }, async () => { called = true; return chosen; }); return (r as any).code === 'DENIED' && !called; })());
  fs.writeFileSync(path.join(temp, 'большой.bin'), Buffer.alloc(PAGE_LIMITS.openBytes + 1));
  ok('больше предела — LIMIT без чтения', (readPicked(path.join(temp, 'большой.bin')) as any).code === 'LIMIT');
  ok('ровно предел — читается', readPicked((() => { const f = path.join(temp, 'ровно.bin'); fs.writeFileSync(f, Buffer.alloc(PAGE_LIMITS.openBytes)); return f; })()).ok);
  ok('папка вместо файла — FAILED', (readPicked(temp) as any).code === 'FAILED');
  ok('нет файла — FAILED', (readPicked(path.join(temp, 'нет.txt')) as any).code === 'FAILED');
  ok('название программы в заголовке не ломает диалог', !/[\u0000-\u001f]/.test(pickTitle('a\nb\u0000c')) && pickTitle('я'.repeat(500)).length < 120);
  ok('канал разрешён общему мосту окна Flux', INVOKE_CHANNELS.has('modules:pick-file'));
  fs.rmSync(temp, { recursive: true, force: true });
}

async function live() {
  const chrome = process.env.FLUX_CHROME || '/usr/bin/chromium';
  if (!fs.existsSync(chrome)) {
    if (process.env.CI) { failed++; console.error(`  ✗ в CI нет Chromium (${chrome}): живая проверка не выполнена`); return; }
    console.log('FLUX_VERIFY_SKIP: нет Chromium (FLUX_CHROME)'); return;
  }
  console.log('\n5. Настоящий кадр: клиент flux.openFile');
  const { chromium } = await import('playwright-core');
  const client = (await buildPageAssets())['modules/_flux/flux.v1.js'] as string;
  const hostScript = (await build({ entryPoints: ['scripts/fixtures/page-host.ts'], bundle: true, write: false, platform: 'browser', format: 'iife' })).outputFiles[0].text;
  const pageServer = http.createServer((req, res) => {
    if ((req.url || '').startsWith('/_flux/flux.v1.js')) { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(client); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><meta charset="utf-8"><body><script src="/_flux/flux.v1.js"></script><p>Страница</p>');
  });
  const hostServer = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(`<!doctype html><meta charset="utf-8"><body style="margin:0"><script>${hostScript}</script>`); });
  await new Promise<void>(r => pageServer.listen(0, '127.0.0.1', r));
  await new Promise<void>(r => hostServer.listen(0, '127.0.0.1', r));
  const port = (s: http.Server) => (s.address() as AddressInfo).port;
  const browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
  try {
    const tab = await (await browser.newContext()).newPage();
    await tab.goto(`http://127.0.0.1:${port(hostServer)}/`);
    await tab.evaluate(([src, manifest]) => (window as any).startHost({ src, theme: 'light', manifest }), [`http://127.0.0.1:${port(pageServer)}/ui/index.html`, base] as const);
    await tab.waitForFunction(() => (window as any).__beats >= 1, null, { timeout: 20000 });
    const frame = tab.frames().find(f => f.url().includes('/ui/index.html'))!;
    const ask = (accept?: string[]) => frame.evaluate(async (a) => {
      try { const f = await (window as any).flux.openFile(a ? { accept: a } : undefined); return { name: f.name, size: f.size, text: f.text(), bytes: Array.from(f.bytes() as Uint8Array) }; }
      catch (e: any) { return { error: e.code }; }
    }, accept);
    const pause = () => tab.waitForTimeout(1100);
    await tab.evaluate(() => { (window as any).__pickNext = { name: 'данные.csv', mime: 'text/csv', bytes: new TextEncoder().encode('год;значение\n2026;42') }; });
    const got: any = await ask(['.csv']);
    ok('flux.openFile отдаёт имя, размер, text() и bytes()', got.name === 'данные.csv' && got.size === 31 && got.text === 'год;значение\n2026;42' && got.bytes.length === 31);
    ok('просьба дошла до хоста со списком расширений', JSON.stringify(await tab.evaluate(() => (window as any).__picks)) === '[{"accept":[".csv"]}]');
    await pause();
    await tab.evaluate(() => { (window as any).__pickNext = 'cancelled'; });
    ok('отказ человека — ошибка CANCELLED', (await ask() as any).error === 'CANCELLED');
    await pause();
    ok('неверное расширение — ошибка DENIED', (await ask(['csv']) as any).error === 'DENIED');
    await pause();
    await tab.evaluate(() => { (window as any).__pickNext = 'limit'; });
    ok('слишком большой файл — ошибка LIMIT', (await ask() as any).error === 'LIMIT');
    ok('прежний saveFile работает как раньше', await frame.evaluate(async () => { try { await new Promise(r => setTimeout(r, 1100)); return (await (window as any).flux.saveFile('result.csv', 'a;b')) === 'saved'; } catch { return false; } }));
  } finally { await browser.close(); pageServer.close(); hostServer.close(); }
}

(async () => {
  await units();
  await live();
  console.log(`\nПройдено: ${passed}${failed ? `, провалено: ${failed}` : ''}`);
  process.exit(failed ? 1 : 0);
})().catch(error => { console.error(error); process.exit(1); });
