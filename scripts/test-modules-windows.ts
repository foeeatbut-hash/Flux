/**
 * Окна программ (добавлено к договору v2, существующие сообщения не менялись): диалоги через Flux
 * (flux.dialogs), заголовок и размер окна (flux.windows.open с третьим аргументом, flux.window.setTitle),
 * пометка «есть несохранённое» (flux.window.setUnsaved).
 *
 * Что доказывается:
 * - схема: новые op с пределами длины (заголовок 80, текст 600, кнопки 30), чужие поля и пустые надписи отвергаются,
 *   прежние сообщения страницы допустимы как раньше, неизвестный op — отказ;
 * - мост: хост без новых полей (старый Flux) отвечает DENIED; один диалог за раз и не чаще раза в секунду (LIMIT);
 *   управляющие знаки — DENIED; ответы по видам; хост получает только простой текст; setTitle/setUnsaved режутся по пределам;
 * - типы flux.d.ts и клиент знают новые вызовы;
 * - настоящий кадр в Chromium: клиент отдаёт ответы диалогов и пишет заголовок, размер и несохранённое в хост.
 *
 * Запуск: npx tsx scripts/test-modules-windows.ts   (живая часть — FLUX_CHROME)
 */
import { verifySkip } from './verifySkip';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { build } from 'esbuild';
import { validMessage } from '../modules/schemas';
import { createModuleBridge } from '../modules/bridge';
import { themeKeys } from '../modules/contract';
import { DIALOG_LIMITS, PAGE_MIN_FLUX, WINDOW_OPTION_LIMITS } from '../modules/page/model';
import { buildPageAssets } from '../modules/build';
import { fluxPageTypes } from '../modules/page/types';
import { findChrome } from './chromePath';

let failed = 0, passed = 0;
const ok = (name: string, condition: unknown) => { if (condition) { passed++; console.log('  ✓', name); } else { failed++; console.error('  ✗', name); } };
const base = { id: 'win-page', name: 'Редактор', version: '1.0.0', author: 'Flux', contractVersion: 2, entries: ['start'], reads: ['project'], logic: 'logic/main.ts', ui: 'page', pages: ['detail.html'], store: { category: 'calc', summary: 'x', requires: { flux: PAGE_MIN_FLUX } } } as any;
const pause = (ms = 1050) => new Promise(r => setTimeout(r, ms));

async function units() {
  console.log('1. Схема сообщений');
  const env = { flux: 'module', v: 1, session: 's', id: 'p-1', type: 'page' };
  const valid = (extra: Record<string, unknown>) => validMessage('page', { ...env, ...extra });
  ok('confirm: заголовок и текст', valid({ op: 'dialog-confirm', title: 'Удалить?', text: 'Строка 5' }));
  ok('confirm: кнопки и danger', valid({ op: 'dialog-confirm', title: 'a', text: 'b', ok: 'Удалить', cancel: 'Оставить', danger: true }));
  ok('confirm: без текста — недопустимо', !valid({ op: 'dialog-confirm', title: 'a' }));
  ok('confirm: пустой заголовок — недопустимо', !valid({ op: 'dialog-confirm', title: '', text: 'b' }));
  ok(`confirm: заголовок ${DIALOG_LIMITS.title} знаков — можно, больше — нет`, valid({ op: 'dialog-confirm', title: 'я'.repeat(80), text: 'b' }) && !valid({ op: 'dialog-confirm', title: 'я'.repeat(81), text: 'b' }));
  ok(`confirm: текст ${DIALOG_LIMITS.text} — можно, больше — нет`, valid({ op: 'dialog-confirm', title: 'a', text: 'я'.repeat(600) }) && !valid({ op: 'dialog-confirm', title: 'a', text: 'я'.repeat(601) }));
  ok(`confirm: кнопка ${DIALOG_LIMITS.button} — можно, больше — нет, пустая — нет`, valid({ op: 'dialog-confirm', title: 'a', text: 'b', ok: 'я'.repeat(30) }) && !valid({ op: 'dialog-confirm', title: 'a', text: 'b', cancel: 'я'.repeat(31) }) && !valid({ op: 'dialog-confirm', title: 'a', text: 'b', ok: '' }));
  ok('confirm: чужое поле (html) — недопустимо', !valid({ op: 'dialog-confirm', title: 'a', text: 'b', html: '<b>x</b>' }));
  ok('confirm: danger не булево — недопустимо', !valid({ op: 'dialog-confirm', title: 'a', text: 'b', danger: 'yes' }));
  ok('alert: заголовок и текст', valid({ op: 'dialog-alert', title: 'a', text: 'b' }) && !valid({ op: 'dialog-alert', title: 'a' }) && !valid({ op: 'dialog-alert', title: 'a', text: 'b', ok: 'x' }));
  ok('prompt: подпись обязательна, остальное нет', valid({ op: 'dialog-prompt', title: 'a', label: 'Имя' }) && !valid({ op: 'dialog-prompt', title: 'a' }));
  ok('prompt: значение, текст, maxLength', valid({ op: 'dialog-prompt', title: 'a', label: 'l', text: 't', value: 'v', maxLength: 50 }));
  ok('prompt: maxLength 0 и больше 1000 — недопустимо', !valid({ op: 'dialog-prompt', title: 'a', label: 'l', maxLength: 0 }) && !valid({ op: 'dialog-prompt', title: 'a', label: 'l', maxLength: 1001 }));
  ok('window-title: до 80 знаков', valid({ op: 'window-title', text: 'Ведомость' }) && valid({ op: 'window-title', text: '' }) && !valid({ op: 'window-title', text: 'я'.repeat(81) }));
  ok('window-unsaved: флаг и текст до 200', valid({ op: 'window-unsaved', unsaved: true }) && valid({ op: 'window-unsaved', unsaved: false, text: 'я'.repeat(200) }) && !valid({ op: 'window-unsaved', unsaved: true, text: 'я'.repeat(201) }) && !valid({ op: 'window-unsaved' }) && !valid({ op: 'window-unsaved', unsaved: 1 }));
  ok('window-open: заголовок и размер', valid({ op: 'window-open', page: 'detail.html', options: { title: 'Строка 5', width: 640, height: 480 } }));
  ok('window-open: меньше 320×240 — недопустимо', !valid({ op: 'window-open', page: 'detail.html', options: { width: 319 } }) && !valid({ op: 'window-open', page: 'detail.html', options: { height: 239 } }));
  ok('window-open: дробный размер, чужое поле, заголовок больше 80 — недопустимо', !valid({ op: 'window-open', page: 'detail.html', options: { width: 400.5 } }) && !valid({ op: 'window-open', page: 'detail.html', options: { x: 1 } }) && !valid({ op: 'window-open', page: 'detail.html', options: { title: 'я'.repeat(81) } }));
  ok('window-open: без options — как раньше', valid({ op: 'window-open', page: 'detail.html' }) && valid({ op: 'window-open', page: 'detail.html', params: { a: 1 } }));
  ok('прежние действия страницы допустимы как раньше', valid({ op: 'state-load' }) && valid({ op: 'beat' }) && valid({ op: 'params-load' }) && valid({ op: 'channel-send', data: 1 })
    && valid({ op: 'file-offer', name: 'a.csv', data: 'x', encoding: 'utf8' }) && valid({ op: 'file-pick', accept: ['.csv'] }));
  ok('неизвестный op — недопустимо', !valid({ op: 'dialog-html', title: 'a', text: 'b' }) && !valid({ op: 'window-close' }) && !valid({ op: 'window-resize', width: 400 }));
  ok('типы flux.d.ts знают диалоги, заголовок и несохранённое', /dialogs: \{/.test(fluxPageTypes()) && /confirm\(options/.test(fluxPageTypes()) && /setUnsaved\(unsaved: boolean/.test(fluxPageTypes()) && /setTitle\(text: string\)/.test(fluxPageTypes()) && /options\?: \{ title\?: string; width\?: number/.test(fluxPageTypes()));

  console.log('\n2. Мост');
  const sent: any[] = [];
  const frame = { postMessage: (m: unknown) => sent.push(m) } as unknown as Window;
  const theme = Object.fromEntries(themeKeys.map(k => [k, '#000'])) as never;
  const baseOptions = { loadState: () => ({}), keepState: () => undefined, offerFile: async () => 'saved' as const, onBeat: () => undefined, openWindow: () => true, params: () => ({}), broadcast: () => undefined };
  const make = (manifest: any, page: any) => createModuleBridge({ frame: () => frame, session: 's', manifest, context: () => ({ projectId: 'p', entry: 'start', entityId: null }), theme: () => theme, read: (async () => null) as never, page });
  let n = 0;
  const send = async (bridge: ReturnType<typeof make>, extra: Record<string, unknown>) => {
    sent.length = 0;
    await bridge.handle({ source: frame as never, origin: 'null', data: { ...env, id: `p-${++n}`, ...extra } });
    return sent[0];
  };
  const ready = async (bridge: ReturnType<typeof make>) => { await bridge.handle({ source: frame as never, origin: 'null', data: { flux: 'module', v: 1, session: 's', type: 'ready' } }); };
  const asked: any[] = [], titles: string[] = [], flags: any[] = [], opened: any[] = [];
  const answer = { value: true as any };
  const bridge = make(base, { ...baseOptions, dialog: async (r: any) => { asked.push(r); return answer.value; }, setTitle: (t: string) => titles.push(t), setUnsaved: (u: boolean, t: string) => flags.push([u, t]),
    openWindow: (page: string, params: any, options: any) => { opened.push({ page, params, options }); return true; } });
  await ready(bridge);

  let reply = await send(bridge, { op: 'dialog-confirm', title: 'Удалить?', text: 'Строка 5', danger: true });
  ok('confirm: ответ true, хост получил простой текст и danger', reply.type === 'page-result' && reply.data === true && JSON.stringify(asked[0]) === '{"kind":"confirm","title":"Удалить?","text":"Строка 5","danger":true}');
  reply = await send(bridge, { op: 'dialog-alert', title: 'a', text: 'b' });
  ok('второй диалог сразу — LIMIT (не чаще раза в секунду), хост не вызван', reply.type === 'page-error' && reply.code === 'LIMIT' && asked.length === 1);
  await pause(); answer.value = false;
  reply = await send(bridge, { op: 'dialog-confirm', title: 'a', text: 'b' });
  ok('confirm: отказ — false (не ошибка)', reply.type === 'page-result' && reply.data === false);
  await pause(); answer.value = undefined;
  reply = await send(bridge, { op: 'dialog-alert', title: 'Готово', text: 'Сохранено' });
  ok('alert: ответ null', reply.type === 'page-result' && reply.data === null && asked[2].kind === 'alert');
  await pause(); answer.value = 'Новое имя';
  reply = await send(bridge, { op: 'dialog-prompt', title: 'Имя', label: 'Как назвать', value: 'Старое', maxLength: 50 });
  ok('prompt: строка, хост получил подпись, значение и предел', reply.data === 'Новое имя' && JSON.stringify(asked[3]) === '{"kind":"prompt","title":"Имя","label":"Как назвать","value":"Старое","maxLength":50}');
  await pause(); answer.value = 'я'.repeat(80);
  reply = await send(bridge, { op: 'dialog-prompt', title: 'Имя', label: 'l', maxLength: 10 });
  ok('prompt: ответ длиннее предела обрезается мостом', reply.data === 'я'.repeat(10) && asked[4].maxLength === 10);
  await pause(); answer.value = null;
  reply = await send(bridge, { op: 'dialog-prompt', title: 'Имя', label: 'l' });
  ok('prompt: отказ — null; предел по умолчанию 200', reply.type === 'page-result' && reply.data === null && asked[5].maxLength === DIALOG_LIMITS.defaultMaxLength);
  await pause();
  reply = await send(bridge, { op: 'dialog-prompt', title: 'Имя', label: 'l', value: 'abcdef', maxLength: 3 });
  ok('prompt: начальное значение длиннее предела — DENIED, хост не вызван', reply.code === 'DENIED' && asked.length === 6);
  reply = await send(bridge, { op: 'dialog-confirm', title: 'a\u0007b', text: 'x' });
  ok('управляющий знак в заголовке — DENIED', reply.code === 'DENIED' && asked.length === 6);
  reply = await send(bridge, { op: 'dialog-confirm', title: 'a', text: 'строка 1\nстрока 2\tколонка' });
  ok('перевод строки и табуляция в тексте допустимы', reply.type === 'page-result' && asked.length === 7);
  reply = await send(bridge, { op: 'dialog-confirm', title: 'a', text: '<img src=x onerror=alert(1)>' });
  ok('разметка не вырезается мостом, а доходит текстом (рисует Flux как текст); следом идёт LIMIT по частоте', reply.code === 'LIMIT');

  const slowResolve: Array<(v: any) => void> = [];
  const slow = make(base, { ...baseOptions, dialog: () => new Promise(resolve => { slowResolve.push(resolve); }) });
  await ready(slow);
  sent.length = 0;
  const first = slow.handle({ source: frame as never, origin: 'null', data: { ...env, id: 'p-a', op: 'dialog-confirm', title: 'a', text: 'b' } });
  await pause(1100);
  reply = await send(slow, { op: 'dialog-alert', title: 'a', text: 'b' });
  ok('пока первый диалог открыт, второй — LIMIT даже через секунду', reply.code === 'LIMIT' && slowResolve.length === 1);
  slowResolve[0](true); await first;
  ok('ответ первого дошёл после второго отказа', sent.some(m => m.id === 'p-a' && m.data === true));
  await pause();
  const closing = make(base, { ...baseOptions, dialog: () => new Promise(() => undefined) });
  await ready(closing);
  sent.length = 0;
  void closing.handle({ source: frame as never, origin: 'null', data: { ...env, id: 'p-z', op: 'dialog-confirm', title: 'a', text: 'b' } });
  await new Promise(r => setTimeout(r, 20));
  closing.dispose();
  ok('закрытие окна: диалог без ответа, мост ничего не шлёт', sent.length === 0);

  const failing = make(base, { ...baseOptions, dialog: async () => { throw new Error('упал'); } });
  await ready(failing);
  reply = await send(failing, { op: 'dialog-alert', title: 'a', text: 'b' });
  ok('сбой диалога — FAILED', reply.code === 'FAILED');

  await pause();
  reply = await send(bridge, { op: 'window-title', text: '  Строка 5  ' });
  ok('setTitle: хост получает обрезанный по краям заголовок', reply.type === 'page-result' && titles[0] === 'Строка 5');
  reply = await send(bridge, { op: 'window-title', text: '' });
  ok('setTitle пустой — вернуть название программы', titles[1] === '');
  reply = await send(bridge, { op: 'window-title', text: 'a\nb' });
  ok('setTitle с переводом строки — DENIED', reply.code === 'DENIED' && titles.length === 2);
  reply = await send(bridge, { op: 'window-unsaved', unsaved: true, text: '  Таблица изменена  ' });
  ok('setUnsaved(true, текст): хост получает флаг и текст', reply.type === 'page-result' && JSON.stringify(flags[0]) === '[true,"Таблица изменена"]');
  reply = await send(bridge, { op: 'window-unsaved', unsaved: false, text: 'забыть' });
  ok('setUnsaved(false): текст сбрасывается', JSON.stringify(flags[1]) === '[false,""]');
  reply = await send(bridge, { op: 'window-unsaved', unsaved: true, text: 'a\u0000b' });
  ok('текст несохранённого с управляющим знаком — DENIED', reply.code === 'DENIED' && flags.length === 2);
  reply = await send(bridge, { op: 'window-open', page: 'detail.html', params: { row: 5 }, options: { title: ' Строка 5 ', width: 640, height: 480 } });
  ok('windows.open: хост получает заголовок и размер', reply.type === 'page-result' && JSON.stringify(opened[0]) === '{"page":"detail.html","params":{"row":5},"options":{"title":"Строка 5","width":640,"height":480}}');
  reply = await send(bridge, { op: 'window-open', page: 'detail.html' });
  ok('windows.open без options — хост получает undefined, как раньше', opened[1].options === undefined && opened[1].params && Object.keys(opened[1].params).length === 0);
  reply = await send(bridge, { op: 'window-open', page: 'index.html', options: { title: 'a\u0001' } });
  ok('windows.open: управляющий знак в заголовке — DENIED', reply.code === 'DENIED' && opened.length === 2);
  reply = await send(bridge, { op: 'window-open', page: 'чужая.html', options: { title: 'a' } });
  ok('windows.open: страницы нет в манифесте — DENIED и с options', reply.code === 'DENIED' && opened.length === 2);

  const old = make(base, baseOptions);
  await ready(old);
  for (const extra of [{ op: 'dialog-confirm', title: 'a', text: 'b' }, { op: 'dialog-alert', title: 'a', text: 'b' }, { op: 'dialog-prompt', title: 'a', label: 'l' }, { op: 'window-title', text: 'x' }, { op: 'window-unsaved', unsaved: true }]) {
    reply = await send(old, extra);
    ok(`старый хост без поля: ${extra.op} — DENIED`, reply.type === 'page-error' && reply.code === 'DENIED');
  }
  reply = await send(old, { op: 'window-open', page: 'detail.html', options: { title: 'x', width: 400 } });
  ok('старый хост: windows.open с options открывает окно как раньше (параметры окна он игнорирует)', reply.type === 'page-result');
  const form = make({ ...base, ui: undefined, contractVersion: 1 }, { ...baseOptions, dialog: async () => true, setTitle: () => undefined, setUnsaved: () => undefined });
  await ready(form);
  for (const extra of [{ op: 'dialog-confirm', title: 'a', text: 'b' }, { op: 'window-title', text: 'x' }, { op: 'window-unsaved', unsaved: true }]) {
    reply = await send(form, extra);
    ok(`программа с формой: ${extra.op} — DENIED`, reply.code === 'DENIED');
  }
  const writeLike = await send(bridge, { op: 'dialog-confirm', type: 'page', title: 'a', text: 'b', method: 'POST' });
  ok('признаки записи по-прежнему отвергаются (READ_ONLY)', writeLike.code === 'READ_ONLY');
}

async function live() {
  const chrome = findChrome();
  if (!fs.existsSync(chrome)) {
    if (process.env.CI) { failed++; console.error(`  ✗ в CI нет Chromium (${chrome}): живая проверка не выполнена`); return; }
    verifySkip('нет Chromium (FLUX_CHROME)'); return;
  }
  console.log('\n3. Настоящий кадр: клиент flux.dialogs / flux.window / flux.windows.open');
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
    const run = (code: string) => frame.evaluate(async (c) => { try { return { value: await (new Function('flux', `return (async () => { ${c} })()`))((window as any).flux) }; } catch (e: any) { return { error: e.code || String(e) }; } }, code) as Promise<any>;
    const next = (value: unknown) => tab.evaluate(v => { (window as any).__dialogNext = v; }, value);
    await next(true);
    ok('flux.dialogs.confirm → true', (await run(`return flux.dialogs.confirm({ title: 'Удалить?', text: 'Строка 5', ok: 'Удалить', danger: true })`)).value === true);
    ok('хост получил текст и кнопки', JSON.stringify(await tab.evaluate(() => (window as any).__dialogs[0])) === '{"kind":"confirm","title":"Удалить?","text":"Строка 5","ok":"Удалить","danger":true}');
    await tab.waitForTimeout(1100); await next(false);
    ok('confirm: отказ → false', (await run(`return flux.dialogs.confirm({ title: 'a', text: 'b' })`)).value === false);
    await tab.waitForTimeout(1100); await next(null);
    ok('flux.dialogs.alert → null', (await run(`return flux.dialogs.alert({ title: 'a', text: 'b' })`)).value === null);
    await tab.waitForTimeout(1100); await next('Имя');
    ok('flux.dialogs.prompt → строка', (await run(`return flux.dialogs.prompt({ title: 'a', label: 'Имя', value: 'x', maxLength: 20 })`)).value === 'Имя');
    await tab.waitForTimeout(1100); await next(null);
    ok('prompt: отказ → null', (await run(`return flux.dialogs.prompt({ title: 'a', label: 'Имя' })`)).value === null);
    ok('второй диалог сразу — ошибка LIMIT', (await run(`return flux.dialogs.alert({ title: 'a', text: 'b' })`)).error === 'LIMIT');
    ok('слишком длинный заголовок — ошибка DENIED', (await run(`return flux.dialogs.alert({ title: 'я'.repeat(81), text: 'b' })`)).error === 'DENIED');
    ok('flux.window.setTitle доходит до хоста', (await run(`await flux.window.setTitle('Строка 5'); return 1`)).value === 1 && (await tab.evaluate(() => (window as any).__titles))[0] === 'Строка 5');
    ok('flux.window.setUnsaved(true, текст) доходит до хоста', (await run(`await flux.window.setUnsaved(true, 'Таблица изменена'); await flux.window.setUnsaved(false); return 1`)).value === 1
      && JSON.stringify(await tab.evaluate(() => (window as any).__unsaved)) === '[{"unsaved":true,"text":"Таблица изменена"},{"unsaved":false,"text":""}]');
    ok('flux.windows.open с заголовком и размером', (await run(`await flux.windows.open('detail.html', { row: 5 }, { title: 'Строка 5', width: 640, height: 480 }); return 1`)).value === 1
      && JSON.stringify((await tab.evaluate(() => (window as any).__windows)).at(-1)) === '{"page":"detail.html","params":{"row":5},"options":{"title":"Строка 5","width":640,"height":480}}');
    ok('flux.windows.open как раньше: два аргумента', (await run(`await flux.windows.open('index.html', { a: 1 }); return 1`)).value === 1
      && JSON.stringify((await tab.evaluate(() => (window as any).__windows)).at(-1)) === '{"page":"index.html","params":{"a":1}}');
    ok('размер меньше 320×240 — ошибка DENIED', (await run(`return flux.windows.open('index.html', {}, { width: 100 })`)).error === 'DENIED');
    ok('клиент заморожен: flux.dialogs нельзя подменить', (await run(`try { flux.dialogs = null; } catch (e) {} return typeof flux.dialogs.confirm`)).value === 'function');
  } finally { await browser.close(); pageServer.close(); hostServer.close(); }
}

(async () => {
  void WINDOW_OPTION_LIMITS;
  await units();
  await live();
  console.log(`\nПройдено: ${passed}${failed ? `, провалено: ${failed}` : ''}`);
  process.exit(failed ? 1 : 0);
})().catch(error => { console.error(error); process.exit(1); });
