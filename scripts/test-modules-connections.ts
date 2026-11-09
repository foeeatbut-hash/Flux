/**
 * Подключения подпрограмм (этап 3б), главный процесс без Electron: объявление в
 * манифесте, проверка адресов после разрешения имени, сквозные HTTP / WebSocket /
 * COM (поддельный), решения человека, пределы и журнал. Серверы — настоящие,
 * локальные: проверяется, что неразрешённое до них не доходит вообще.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import {
  checkHeaders, describeConnection, grantKey, humanText, parseConnections, pathAllowed, type ConnectionDecl,
} from '../modules/connections/model';
import { addressClass } from '../modules/connections/address';
import { validManifest, validMessage } from '../modules/schemas';
import { diffPermissions } from '../modules/trust/diff';
import { permissionLines } from '../modules/store/model';
import { ModuleConnections, type VerifiedModule } from '../electron/moduleConnections';
import { ModuleGrants } from '../electron/moduleGrants';
import { ModuleJournal } from '../electron/moduleJournal';
import { validEntry } from '../modules/journal/model';
import { FakeCom } from './fixtures/fakeCom';

let passed = 0;
const check = (name: string, condition: unknown) => { assert.ok(condition, name); passed++; console.log(`✓ ${name}`); };
let completed = false;
process.on('exit', () => { if (!completed) { console.error('ПРОВАЛ: проверка подключений не дошла до конца'); process.exitCode = 1; } });

const listen = (server: http.Server) => new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as any).port)));

async function main() {
  // ── Манифест: объявление ──
  const base = { app: 'Сервер расчётов', does: 'Отправляет параметры оборудования на расчёт', access: 'send' };
  const ok = parseConnections([{ id: 'api', kind: 'http', url: 'http://127.0.0.1:8123', pathPrefix: '/api', ...base }, { id: 'e3', kind: 'com', progId: 'CT.Application', app: 'E3.series', does: 'Читает схемы открытого проекта E3', access: 'read' }]);
  check('объявление http и com разбирается, адрес нормализуется', ok?.length === 2 && (ok[0] as any).url === 'http://127.0.0.1:8123' && describeConnection(ok[0]).includes('внутренняя сеть'));
  check('адрес с путём, учётными данными, запросом или чужой схемой — отказ', [
    { url: 'http://h:1/api' }, { url: 'http://u:p@h:1' }, { url: 'http://h:1?x=1' }, { url: 'ftp://h' }, { url: 'http://h:99999' },
  ].every(x => parseConnections([{ id: 'a', kind: 'http', ...base, ...x }]) === null));
  check('COM-объекты запуска программ и сети в обход адресов запрещены', ['WScript.Shell', 'Shell.Application', 'MSXML2.XMLHTTP', 'Microsoft.XMLHTTP', 'Excel.Application']
    .every(progId => parseConnections([{ id: 'a', kind: 'com', progId, app: 'Программа', does: 'Делает что-то полезное для человека', access: 'read' }]) === null));
  check('лишнее поле, повтор id, больше восьми — отказ', parseConnections([{ id: 'a', kind: 'com', progId: 'A.B', ...base, extra: 1 }]) === null
    && parseConnections([{ id: 'a', kind: 'com', progId: 'A.B', ...base }, { id: 'a', kind: 'com', progId: 'A.C', ...base }]) === null
    && parseConnections(Array.from({ length: 9 }, (_, i) => ({ id: `c${i}`, kind: 'com', progId: 'A.B', ...base }))) === null);
  check('тексты для человека: пустые и технические не проходят', !humanText('', 12, 240, 3) && !humanText('GET http://10.0.0.1/api', 12, 240, 3)
    && !humanText('Scripting.FileSystemObject.Open', 12, 240, 3) && !humanText('{"a":1} {"b":2}', 12, 240, 3) && humanText('Читает схемы открытого проекта', 12, 240, 3));
  check('без app, does или access объявление не принимается', ['app', 'does', 'access'].every(k => { const d: any = { id: 'a', kind: 'com', progId: 'A.B', ...base }; delete d[k]; return parseConnections([d]) === null; }));
  const manifest = { id: 'x', name: 'X', author: 'A', version: '1.0.0', contractVersion: 1, entries: ['start'], reads: [], logic: 'logic/main.ts', connections: [{ id: 'a', kind: 'com', progId: 'WScript.Shell', ...base }] };
  check('манифест с запрещённым COM-объектом не принимается договором', !validManifest(manifest) && validManifest({ ...manifest, connections: [{ id: 'a', kind: 'com', progId: 'A.B', ...base }] }));

  // ── Пути, заголовки, адреса ──
  check('путь внутри префикса; обходы через .., %2e%2e, //, \\, %2f — нет', pathAllowed('/api', '/api/x?q=1') === '/api/x?q=1' && pathAllowed('/api', '/api') === '/api'
    && ['/apix', '/api/../admin', '/api/%2e%2e/admin', '//evil.com/api', '/api\\x', '/api%2fx', '/', 'api/x', '/api/x#h'].every(p => pathAllowed('/api', p) === null));
  check('заголовки: cookie, host, origin и управление соединением запрещены, authorization можно', checkHeaders({ cookie: 'a=b' }) === null && checkHeaders({ Host: 'evil' }) === null
    && checkHeaders({ 'content-length': '1' }) === null && checkHeaders({ 'x-a': 'a\r\nb: c' }) === null && checkHeaders({ Authorization: 'Bearer t' })?.authorization === 'Bearer t');
  check('классы адресов: публичный, внутренний, петля, облачные метаданные, IPv4 в обёртке IPv6', addressClass('8.8.8.8') === 'public' && addressClass('10.1.2.3') === 'private'
    && addressClass('127.0.0.1') === 'loopback' && addressClass('169.254.169.254') === 'blocked' && addressClass('::ffff:10.0.0.1') === 'private' && addressClass('::ffff:7f00:1') === 'loopback'
    && addressClass('fe80::1') === 'blocked' && addressClass('0.0.0.0') === 'blocked' && addressClass('не адрес') === 'blocked');

  // ── Сообщение моста ──
  const env = { flux: 'module', v: 1, session: 's', id: 'i', type: 'connect', connection: 'api' };
  check('схема вызова: адрес в вызове невозможен, лишние поля и неизвестные операции отвергаются', validMessage('connect', { ...env, call: { op: 'http', method: 'GET', path: '/api' } })
    && !validMessage('connect', { ...env, call: { op: 'http', method: 'GET', path: '/api', url: 'http://evil' } }) && !validMessage('connect', { ...env, call: { op: 'exec', cmd: 'calc' } })
    && !validMessage('connect', { ...env, call: { op: 'http', method: 'TRACE', path: '/' } }) && !validMessage('connect', { ...env, call: { op: 'com-call', handle: 1, name: 'Run; calc' } }));

  // ── Серверы ──
  let hits = 0, elsewhere = 0, lastRequest: any = null;
  const other = http.createServer((_q, r) => { elsewhere++; r.end('other'); });
  const otherPort = await listen(other);
  const api = http.createServer((q, r) => {
    hits++;
    const chunks: Buffer[] = [];
    q.on('data', c => chunks.push(c));
    q.on('end', () => {
      lastRequest = { method: q.method, url: q.url, headers: q.headers, body: Buffer.concat(chunks).toString() };
      if (q.url!.startsWith('/api/redirect')) { r.writeHead(302, { location: `http://127.0.0.1:${otherPort}/x`, 'set-cookie': 'sid=1' }); r.end(); return; }
      if (q.url!.startsWith('/api/big')) { r.end(Buffer.alloc(600 * 1024, 97)); return; }
      r.writeHead(200, { 'content-type': 'application/json', 'x-answer': '42', 'set-cookie': 'sid=2' });
      r.end(JSON.stringify({ echo: lastRequest.body, path: q.url }));
    });
  });
  const apiPort = await listen(api);
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise(r => wss.on('listening', r));
  const wsPort = (wss.address() as any).port;
  wss.on('connection', socket => { socket.on('message', (d, bin) => socket.send(bin ? d : `эхо:${d}`)); });

  // ── Служба: проверенный выпуск, решения, журнал ──
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-conn-'));
  const decls: ConnectionDecl[] = parseConnections([
    { id: 'api', kind: 'http', url: `http://127.0.0.1:${apiPort}`, pathPrefix: '/api', ...base },
    { id: 'push', kind: 'ws', url: `ws://127.0.0.1:${wsPort}`, pathPrefix: '/', app: 'Сервер событий', does: 'Получает уведомления о расчётах', access: 'read' },
    { id: 'fso', kind: 'com', progId: 'Scripting.FileSystemObject', app: 'Файловые имена Windows', does: 'Разбирает имена файлов без чтения диска', access: 'read' },
    { id: 'e3', kind: 'com', progId: 'CT.Application', app: 'E3.series', does: 'Читает схемы открытого проекта E3', access: 'read' },
    { id: 'evil', kind: 'http', url: 'http://evil.test:80', pathPrefix: '/', ...base },
    { id: 'corp', kind: 'http', url: 'http://corp.test:80', pathPrefix: '/', internal: true, ...base },
    { id: 'meta', kind: 'http', url: 'http://meta.test:80', pathPrefix: '/', internal: true, ...base },
  ])!;
  const manifestOf = (connections: ConnectionDecl[]) => ({ id: 'conn-demo', name: 'Пример подключений', version: '1.0.0', author: 'Автор', contractVersion: 1, entries: ['start'], reads: [], logic: 'logic/main.ts', connections }) as any;
  let current: VerifiedModule | null = { manifest: manifestOf(decls), version: '1.0.0', author: 'Автор', verifiedAt: 1 };
  const grants = new ModuleGrants(path.join(dir, 'grants.json'));
  const journal = new ModuleJournal(path.join(dir, 'journal.json'));
  const com = new FakeCom();
  let clock = 1_000_000;
  const lookup = async (host: string) => host === 'evil.test' ? ['127.0.0.1'] : host === 'corp.test' ? ['10.1.2.3'] : host === 'meta.test' ? ['169.254.169.254'] : ['8.8.8.8'];
  const service = new ModuleConnections({ resolve: async (id, version) => (current && id === 'conn-demo' && version === current.version ? current : null), userId: () => 'u1', grants, journal, com, lookup, now: () => clock });
  const call = (connection: string, body: unknown, session = 's1', version = '1.0.0') => service.call('w1', { moduleId: 'conn-demo', version, session, connection, call: body });
  const code = (r: any) => (r.ok ? 'ok' : r.code);
  const allow = (id: string, session = 's1') => grants.decide('u1', 'conn-demo', id, grantKey(decls.find(d => d.id === id)!), `w1:${session}`, 'always');

  // Без разрешения канал не открывается, вопрос уходит окну
  const first: any = await call('api', { op: 'http', method: 'GET', path: '/api/ping' });
  check('нет решения человека — вопрос (ASK) с проверенными текстами, до сервера вызов не дошёл', first.code === 'ASK' && first.ask.app === 'Сервер расчётов' && first.ask.does.includes('параметры') && hits === 0);
  check('неизвестный выпуск и необъявленное подключение — отказ', code(await call('api', { op: 'http', method: 'GET', path: '/api' }, 's1', '9.9.9')) === 'DENIED'
    && code(await call('nope', { op: 'http', method: 'GET', path: '/api' })) === 'DENIED' && code(await call('api', { op: 'com-open' })) === 'DENIED' && hits === 0);
  check('чужая форма вызова (адрес внутри вызова) отвергается главным процессом', code(await call('api', { op: 'http', method: 'GET', path: '/api', url: 'http://evil' })) === 'DENIED');
  await grants.decide('u1', 'conn-demo', 'api', grantKey(decls[0]), 'w1:s1', 'never');
  check('«Не разрешать» запоминается: понятная ошибка без вопроса и без обращения к серверу', code(await call('api', { op: 'http', method: 'GET', path: '/api/ping' })) === 'NOT_ALLOWED' && hits === 0);
  await grants.decide('u1', 'conn-demo', 'api', grantKey(decls[0]), 'w1:s1', 'once');
  await grants.decide('u1', 'conn-demo', 'api', grantKey(decls[0]), 'w1:s1', 'ask');
  check('сброс решения — снова вопрос', (await call('api', { op: 'http', method: 'GET', path: '/api/ping' }) as any).code === 'ASK');
  await grants.decide('u1', 'conn-demo', 'api', grantKey(decls[0]), 'w1:s1', 'once');
  const onceReply: any = await call('api', { op: 'http', method: 'GET', path: '/api/ping' });
  check('«Только сейчас» пропускает в этом окне, но не запоминается: в другом окне — снова вопрос', onceReply.ok && (await call('api', { op: 'http', method: 'GET', path: '/api/ping' }, 's2') as any).code === 'ASK');
  await service.closeSession('w1', 's1');
  check('после закрытия окна «только сейчас» кончилось', (await call('api', { op: 'http', method: 'GET', path: '/api/ping' }) as any).code === 'ASK');
  await allow('api');

  // HTTP как есть
  clock += 2000;
  const echoed: any = await call('api', { op: 'http', method: 'POST', path: '/api/calc?x=1', headers: { 'x-token': 't1', authorization: 'Bearer abc', 'content-type': 'text/plain' }, body: 'привет' });
  check('HTTP: метод, путь с запросом, заголовки и тело доходят как есть; ответ — статус, заголовки, тело',
    echoed.ok && echoed.data.status === 200 && JSON.parse(echoed.data.body).echo === 'привет' && lastRequest.method === 'POST' && lastRequest.url === '/api/calc?x=1'
    && lastRequest.headers['x-token'] === 't1' && lastRequest.headers.authorization === 'Bearer abc' && echoed.data.headers['x-answer'] === '42');
  check('cookie Flux и сервера не передаются: запрос с cookie отвергнут, set-cookie ответа не отдаётся', code(await call('api', { op: 'http', method: 'GET', path: '/api/x', headers: { cookie: 'flux=1' } })) === 'TARGET'
    && echoed.data.headers['set-cookie'] === undefined && lastRequest.headers.cookie === undefined);
  const before = hits;
  check('путь вне префикса, обход и чужой префикс — отказ до сервера', code(await call('api', { op: 'http', method: 'GET', path: '/admin' })) === 'TARGET' && code(await call('api', { op: 'http', method: 'GET', path: '/api/../admin' })) === 'TARGET'
    && code(await call('api', { op: 'http', method: 'GET', path: '/api/%2e%2e/admin' })) === 'TARGET' && hits === before);
  clock += 2000;
  const redirect: any = await call('api', { op: 'http', method: 'GET', path: '/api/redirect' });
  check('редирект на другой адрес не выполняется: ответ 3xx возвращается как есть, до чужого сервера запрос не идёт', redirect.ok && redirect.data.status === 302 && redirect.data.headers.location.includes(`${otherPort}`) && elsewhere === 0);
  const big: any = await call('api', { op: 'http', method: 'GET', path: '/api/big' });
  check('ответ больше предела — ошибка LIMIT, а не обрезка', code(big) === 'LIMIT');

  // Адреса после разрешения имён
  await allow('evil'); await allow('corp'); await allow('meta');
  clock += 2000;
  check('имя, которое разрешилось в 127.0.0.1, без явного объявления внутреннего — отказ', code(await call('evil', { op: 'http', method: 'GET', path: '/' })) === 'TARGET');
  check('адрес облачных метаданных закрыт даже при флаге internal', code(await call('meta', { op: 'http', method: 'GET', path: '/' })) === 'TARGET');
  const corp: any = await call('corp', { op: 'http', method: 'GET', path: '/' });
  check('внутреннее имя с явным internal проходит проверку адреса (соединение уже с несуществующим узлом)', corp.code !== 'TARGET');

  // Пределы
  clock += 5000;
  let limited = 0;
  const burst = await Promise.all(Array.from({ length: 30 }, () => call('api', { op: 'http', method: 'GET', path: '/api/ping' })));
  for (const r of burst) if (code(r) === 'LIMIT') limited++;
  check('частота: сверх 20 вызовов в секунду и больше 4 одновременных — LIMIT', limited >= 10);

  // WebSocket
  clock += 5000;
  await allow('push');
  const open: any = await call('push', { op: 'ws-open', path: '/events' });
  const sent: any = await call('push', { op: 'ws-send', socket: open.data.socket, data: 'ку' });
  const got: any = await call('push', { op: 'ws-recv', socket: open.data.socket, timeoutMs: 3000 });
  check('WebSocket: открыть, послать, получить как есть', open.ok && sent.ok && got.ok && got.data.data === 'эхо:ку');
  check('чужой номер сокета и пустая очередь', code(await call('push', { op: 'ws-recv', socket: 'нет', timeoutMs: 0 })) === 'FAILED' && (await call('push', { op: 'ws-recv', socket: open.data.socket, timeoutMs: 0 }) as any).data.empty === true);
  const sockets = [open.data.socket];
  for (let i = 0; i < 4; i++) { const s: any = await call('push', { op: 'ws-open', path: '/events' }); if (s.ok) sockets.push(s.data.socket); }
  check('открытых подключений на модуль не больше четырёх', sockets.length === 4);
  check('закрытие возвращает место', (await call('push', { op: 'ws-close', socket: sockets[0] }) as any).ok && (await call('push', { op: 'ws-open', path: '/events' }) as any).ok);
  await service.closeSession('w1', 's1');
  check('путь WebSocket вне префикса — отказ', code(await call('push', { op: 'ws-open', path: '/%2e%2e/x' })) === 'TARGET');
  await service.closeSession('w1', 's1');

  // COM
  await allow('fso'); await allow('e3');
  clock += 5000;
  const fso: any = await call('fso', { op: 'com-open' });
  const base1: any = await call('fso', { op: 'com-call', handle: fso.data.handle, name: 'GetBaseName', args: ['C:\\dir\\файл.txt'] });
  check('COM: открыть объект по имени и вызвать метод с аргументами JSON', fso.ok && base1.ok && base1.data.value === 'файл');
  const e3: any = await call('e3', { op: 'com-open' });
  const job: any = await call('e3', { op: 'com-call', handle: e3.data.handle, name: 'CreateJob' });
  const ids: any = await call('e3', { op: 'com-call', handle: job.data.value.$com, name: 'GetIds', args: [{ $out: true }] });
  check('COM: объект в ответе — номер, им можно пользоваться; ref-параметр возвращает значение', job.ok && ids.ok && ids.data.value.out['0'].length === 3 && ids.data.value.ret === 3);
  const setReply: any = await call('e3', { op: 'com-set', handle: e3.data.handle, name: 'Title', value: 'новое' });
  const getReply: any = await call('e3', { op: 'com-get', handle: e3.data.handle, name: 'Title' });
  check('COM: запись и чтение свойства по имени', setReply.ok && getReply.data.value === 'новое');
  check('чужой и выдуманный объект COM — отказ; объект другого подключения тоже', code(await call('fso', { op: 'com-call', handle: 999, name: 'GetBaseName', args: ['a'] })) === 'DENIED'
    && code(await call('fso', { op: 'com-call', handle: e3.data.handle, name: 'Version' })) === 'DENIED'
    && code(await call('e3', { op: 'com-call', handle: e3.data.handle, name: 'CreateJob', args: [{ $com: fso.data.handle }] })) === 'DENIED');
  await call('fso', { op: 'com-release', handle: fso.data.handle });
  check('освобождение объекта закрывает его', com.released.includes(fso.data.handle) && code(await call('fso', { op: 'com-call', handle: fso.data.handle, name: 'GetBaseName', args: ['a'] })) === 'DENIED');
  await service.closeSession('w1', 's1');
  check('закрытие окна освобождает все объекты COM', com.released.includes(e3.data.handle));

  // Новая версия с расширенным доступом спрашивает снова
  const widened = decls.map(d => d.id === 'e3' ? { ...d, access: 'write' as const } : d);
  current = { manifest: manifestOf(widened), version: '1.1.0', author: 'Автор', verifiedAt: 2 };
  const asked: any = await call('e3', { op: 'com-open' }, 's9', '1.1.0');
  check('«читать» стало «изменять» — прежнее «всегда» не действует, спрашивается заново', asked.code === 'ASK' && asked.ask.access === 'write');
  const moved = decls.map(d => d.id === 'api' ? { ...d, url: `http://127.0.0.1:${otherPort}` } : d);
  current = { manifest: manifestOf(moved), version: '1.2.0', author: 'Автор', verifiedAt: 3 };
  check('новый адрес — тоже вопрос заново', (await call('api', { op: 'http', method: 'GET', path: '/api/ping' }, 's9', '1.2.0') as any).code === 'ASK');
  grants.setPolicy([{ moduleId: 'conn-demo', connection: 'fso' }]);
  current = { manifest: manifestOf(decls), version: '1.0.0', author: 'Автор', verifiedAt: 1 };
  check('политика администратора сильнее выбора человека', code(await call('fso', { op: 'com-open' })) === 'NOT_ALLOWED');

  // Разница разрешений и окно установки
  const lines = permissionLines(manifestOf(decls)).filter(l => l.kind === 'connect');
  check('окно установки показывает подключения словами: имя программы, доступ, что делает, адрес мелко', lines.length === decls.length && lines[0].text.includes('«Сервер расчётов»') && lines[0].text.includes('отправлять данные') && lines[0].text.includes('HTTP http://127.0.0.1'));
  const diff = diffPermissions(manifestOf(decls), manifestOf(widened));
  check('разница запроса: расширенный доступ и новый адрес — «новое», смена текста — нет', diff.widened && diff.added.connections?.length === 1
    && !diffPermissions(manifestOf(decls), manifestOf(decls.map(d => ({ ...d, does: 'Другая подробная формулировка текста' })))).widened);

  // Журнал
  const entries = journal.recent(500);
  const text = JSON.stringify(entries);
  check('журнал: записи годной формы, итоги и объём есть', entries.length > 20 && entries.every(validEntry) && entries.some(e => e.outcome === 'user-denied') && entries.some(e => e.outcome === 'limit') && entries.some(e => e.bytesIn > 0));
  check('журнал: содержимого вызовов нет — ни тела, ни аргументов, ни ответа', !text.includes('привет') && !text.includes('файл.txt') && !text.includes('эхо') && !text.includes('x-token') && !text.includes('abc'));
  const small = new ModuleJournal(path.join(dir, 'ring.json'), () => clock, 10);
  for (let i = 0; i < 40; i++) small.add({ moduleId: 'conn-demo', version: '1.0.0', userId: 'u1', category: 'log', level: 'info', event: 'message', detail: `n${i}`, outcome: '', ms: 0, bytesIn: 0, bytesOut: 0 });
  check('журнал: кольцо не растёт без предела', small.size() <= 110 && small.recent(500)[0].detail === 'n39');
  clock += 15 * 86_400_000;
  small.add({ moduleId: 'conn-demo', version: '1.0.0', userId: 'u1', category: 'log', level: 'info', event: 'message', detail: 'новая', outcome: '', ms: 0, bytesIn: 0, bytesOut: 0 });
  for (let i = 0; i < 120; i++) small.add({ moduleId: 'conn-demo', version: '1.0.0', userId: 'u1', category: 'log', level: 'info', event: 'message', detail: 'x', outcome: '', ms: 0, bytesIn: 0, bytesOut: 0 });
  check('журнал: записи старше срока уходят при ротации', !small.recent(500).some(e => e.detail.startsWith('n')));
  const windowed = new ModuleJournal(path.join(dir, 'win.json'), () => clock);
  let accepted = 0;
  for (let i = 0; i < 80; i++) if (windowed.add({ moduleId: 'conn-demo', version: '1.0.0', userId: 'u1', category: 'log', level: 'info', event: 'message', detail: 'a', outcome: '', ms: 0, bytesIn: 0, bytesOut: 0 }, 'window')) accepted++;
  check('журнал: частота записей от окна на подпрограмму ограничена', accepted === 50);
  const longLine = new ModuleJournal(path.join(dir, 'long.json'), () => clock);
  longLine.add({ moduleId: 'conn-demo', version: '1.0.0', userId: 'u1', category: 'log', level: 'warn', event: 'message', detail: 'я'.repeat(5000), outcome: '', ms: 0, bytesIn: 0, bytesOut: 0 });
  check('журнал: длинная строка обрезается', longLine.recent(1)[0].detail.length === 200);
  longLine.ack(1); longLine.add({ moduleId: 'conn-demo', version: '1.0.0', userId: 'u1', category: 'log', level: 'info', event: 'message', detail: 'b', outcome: '', ms: 0, bytesIn: 0, bytesOut: 0 });
  check('журнал: подтверждённое сервером не отправляется повторно', longLine.pending().length === 1 && longLine.pending()[0].detail === 'b');

  await service.shutdown();
  api.close(); other.close(); wss.close();
  console.log(`\nПройдено проверок: ${passed}`);
  completed = true;
  process.exit(0);
}
void main();
