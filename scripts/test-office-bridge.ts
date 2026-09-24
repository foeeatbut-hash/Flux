/**
 * Переписка окна Flux с редактором Flux Office (lib/officeBridge.ts и
 * tools/genoffice/flux-bridge.js) — без браузера.
 *
 * Что стережёт:
 *   - номер файла достаётся из «пути» редактора только чистым: ни «../», ни
 *     адреса в запрос к серверу не попадут;
 *   - сообщения принимаются только от своего фрейма и своего адреса; с диска
 *     (file://, origin 'null') — только от своего фрейма;
 *   - хеш совпадает с тем, что считает сервер;
 *   - мост внутри фрейма глушит ИИ и внешние вызовы, а сборка ставит запрет
 *     внешних соединений и мост раньше скриптов редактора.
 *
 * Запуск: npx tsx scripts/test-office-bridge.ts
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileIdOf, pathOf, targetOrigin, fromOwnFrame, sha256Hex, copyName, isOfficeMsg } from '../src/lib/officeBridge';

let f = 0;
const ok = (n: string, c: boolean, d?: unknown) =>
  (c ? console.log('  ✓', n) : (f++, console.error('  ✗', n, d === undefined ? '' : JSON.stringify(d))));

(async () => {
  console.log('1. Путь файла');
  ok('туда и обратно', fileIdOf(pathOf('a1b2-c3')) === 'a1b2-c3');
  ok('чужой путь — пусто', fileIdOf('C:\\docs\\a.docx') === '');
  ok('«../» — пусто', fileIdOf('flux://file/../api/users') === '');
  ok('адрес — пусто', fileIdOf('flux://file/x?y=1') === '');
  ok('не строка — пусто', fileIdOf(undefined) === '' && fileIdOf(42) === '');

  console.log('\n2. От кого сообщение');
  const frame = {};
  ok('свой фрейм, свой адрес', fromOwnFrame(frame, frame, 'http://localhost:3000', 'http://localhost:3000'));
  ok('свой фрейм, чужой адрес — нет', !fromOwnFrame(frame, frame, 'http://evil', 'http://localhost:3000'));
  ok('чужой фрейм — нет', !fromOwnFrame({}, frame, 'http://localhost:3000', 'http://localhost:3000'));
  ok('фрейма нет — нет', !fromOwnFrame(undefined, undefined, 'http://localhost:3000', 'http://localhost:3000'));
  ok('с диска: свой фрейм', fromOwnFrame(frame, frame, 'null', 'null'));
  ok('с диска: адрес сайта — нет', !fromOwnFrame(frame, frame, 'https://example.com', 'null'));
  ok('адресат: с сервера — свой адрес', targetOrigin('http://localhost:3000') === 'http://localhost:3000');
  ok('адресат: с диска — «*»', targetOrigin('null') === '*');
  ok('сообщение узнаётся', isOfficeMsg({ flux: 'office', op: 'save' }) && !isOfficeMsg({ op: 'save' }) && !isOfficeMsg(null));

  console.log('\n3. Хеш и имя копии');
  const bytes = Buffer.from('Документ Flux Office');
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length);
  ok('хеш как у сервера', await sha256Hex(ab) === createHash('sha256').update(bytes).digest('hex'));
  ok('копия сохраняет расширение', copyName('Отчёт.docx') === 'Отчёт (мои правки).docx');
  ok('копия без расширения', copyName('Отчёт') === 'Отчёт (мои правки)');

  console.log('\n4. Мост внутри фрейма');
  const src = readFileSync('tools/genoffice/flux-bridge.js', 'utf8');
  const posted: any[] = [];
  const store: Record<string, string> = {};
  const parent = { postMessage: (m: any, to: string) => posted.push({ m, to }) };
  let onMsg: (e: any) => void = () => {};
  const win: any = {
    location: { origin: 'http://localhost:3000' }, parent,
    addEventListener: (t: string, fn: any) => { if (t === 'message') onMsg = fn; },
    localStorage: { setItem: (k: string, v: string) => { store[k] = v; } },
  };
  win.window = win;
  const ctx = vm.createContext({
    window: win, localStorage: win.localStorage, Proxy, Promise, Object, String, Blob, URL,
    document: { head: { appendChild: () => {} }, createElement: () => ({}) },
  });
  vm.runInContext(src, ctx);
  const d = win.desktop;
  ok('window.desktop подставлен', !!d);
  ok('первое слово — hello своему адресу', posted[0]?.m?.op === 'hello' && posted[0]?.to === 'http://localhost:3000', posted[0]);
  const ai = await d.aiChat();
  ok('ИИ отвечает «отключено»', ai?.ok === false && /без внешних/.test(ai?.error || ''), ai);
  ok('вход Genspark — «отключено»', (await d.gskLogin())?.ok === false);
  ok('веб-поиск — «отключено»', (await d.webSearchQuery())?.ok === false);
  ok('подписка возвращает отписку', typeof d.onSomething(() => {}) === 'function');
  ok('язык — русский', await d.getLanguage() === 'ru');
  ok('панель ИИ свёрнута', store['aidocs.showAi'] === '0');
  d.saveDocx('flux://file/abc', new ArrayBuffer(4), true);
  const save = posted.find((p) => p.m.op === 'save');
  ok('сохранение несёт путь файла', save?.m?.payload?.path === 'flux://file/abc' && save?.m?.payload?.auto === true, save?.m);

  // Окно сказало «только просмотр» раньше, чем редактор подписался
  onMsg({ source: parent, origin: 'http://localhost:3000', data: { flux: 'office', event: 'readOnly', payload: true } });
  let ro: unknown = null;
  d.onFluxReadOnly((v: unknown) => { ro = v; });
  ok('«только просмотр» доходит и до позднего подписчика', ro === true);
  onMsg({ source: {}, origin: 'http://localhost:3000', data: { flux: 'office', event: 'readOnly', payload: false } });
  ok('чужое окно режим не меняет', ro === true);
  onMsg({ source: parent, origin: 'http://localhost:3000', data: { flux: 'office', event: 'readOnly', payload: false } });
  ok('своё окно — меняет', ro === false);

  console.log('\n5. Сборка');
  const build = readFileSync('tools/genoffice/build.mjs', 'utf8');
  const csp = (build.match(/const CSP = ([\s\S]*?);\n/) || [])[1] || '';
  ok('коммит GenOffice закреплён', /const COMMIT = '[0-9a-f]{40}'/.test(build));
  ok('внешние соединения запрещены', /connect-src 'self' file: blob: data:/.test(csp) && !/https?:/.test(csp), csp);
  ok('мост ставится в <head> до скриптов редактора', /replace\(\/<head>\/i/.test(build) && /flux-bridge\.js/.test(build));
  ok('LICENSE и NOTICE едут с редактором', /'LICENSE', 'NOTICE'/.test(build));
  ok('каталог ee/ не берётся', !/['"`]ee\//.test(build));
  const { PATCHES } = await import('../tools/genoffice/patches.mjs' as any);
  ok('правки GenOffice: режим просмотра встроен в защиту документа',
    PATCHES.some((p: any) => /fluxReadOnly \|\|/.test(p.replace)) && PATCHES.some((p: any) => /onFluxReadOnly/.test(p.replace)));
  ok('у каждой правки своё имя, файл и настоящая замена',
    PATCHES.every((p: any) => p.id && p.file && p.find && p.replace && p.replace !== p.find)
    && new Set(PATCHES.map((p: any) => p.id)).size === PATCHES.length);
  ok('чужая правка не повторяется у каждого участника',
    PATCHES.filter((p: any) => /isChangeOrigin/.test(p.replace)).length >= 5);
  ok('после записи в сеансе файл не перечитывается',
    PATCHES.some((p: any) => p.id === 'flux-no-reparse' && /__fluxCollab\?\.active/.test(p.replace)));

  console.log(f ? `\nПРОВАЛОВ: ${f}` : '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ');
  process.exit(f ? 1 : 0);
})();
