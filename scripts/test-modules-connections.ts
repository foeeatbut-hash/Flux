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
import { addressClass, pickAddress } from '../modules/connections/address';
import { validManifest, validMessage } from '../modules/schemas';
import { diffPermissions } from '../modules/trust/diff';
import { permissionLines } from '../modules/store/model';
import { CONNECTION_LIMITS } from '../modules/connections/model';
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
      if (q.url!.startsWith('/api/slow')) { setTimeout(() => r.end('{"answer":1}'), 400); return; }
      if (q.url!.startsWith('/api/drip')) { r.writeHead(200); const tick = setInterval(() => r.write('x'), 150); setTimeout(() => { clearInterval(tick); r.end(); }, 3000); r.on('close', () => clearInterval(tick)); return; }
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
    { id: 'fso', kind: 'com', progId: 'Scripting.FileSystemObject', allowDangerous: true, app: 'Файловые имена Windows', does: 'Разбирает имена файлов без чтения диска', access: 'read' },
    { id: 'e3', kind: 'com', progId: 'CT.Application', app: 'E3.series', does: 'Читает схемы открытого проекта E3', access: 'read' },
    { id: 'evil', kind: 'http', url: 'http://evil.test:80', pathPrefix: '/', ...base },
    { id: 'corp', kind: 'http', url: 'http://corp.test:80', pathPrefix: '/', internal: true, ...base },
    { id: 'mixed', kind: 'http', url: 'http://mixed.test:80', pathPrefix: '/', ...base },
    { id: 'pin', kind: 'http', url: `http://pin.test:${apiPort}`, pathPrefix: '/api', internal: true, ...base },
  ])!;
  // Вторая подпрограмма: свои объявления (в манифесте не больше восьми) и свой помощник COM
  const otherDecls = [decls.find(d => d.id === 'e3')!, ...parseConnections([
    { id: 'meta', kind: 'http', url: 'http://meta.test:80', pathPrefix: '/', internal: true, ...base },
    { id: 'hang', kind: 'http', url: 'http://hang.test:80', pathPrefix: '/', ...base },
  ])!];
  const manifestOf = (connections: ConnectionDecl[]) => ({ id: 'conn-demo', name: 'Пример подключений', version: '1.0.0', author: 'Автор', contractVersion: 1, entries: ['start'], reads: [], logic: 'logic/main.ts', connections }) as any;
  let current: VerifiedModule | null = { manifest: manifestOf(decls), version: '1.0.0', author: 'Автор', verifiedAt: 1 };
  const grants = new ModuleGrants(path.join(dir, 'grants.json'));
  const journal = new ModuleJournal(path.join(dir, 'journal.json'));
  const com = new FakeCom();
  const otherCom = new FakeCom();
  let clock = 1_000_000;
  const answers: Record<string, string[]> = { 'evil.test': ['127.0.0.1'], 'corp.test': ['10.1.2.3'], 'meta.test': ['169.254.169.254'], 'mixed.test': ['8.8.8.8', '127.0.0.1'], 'pin.test': ['127.0.0.1'] };
  const lookup = async (host: string) => host === 'hang.test' ? new Promise<string[]>(() => {}) : answers[host] ?? ['8.8.8.8'];
  const service = new ModuleConnections({ resolve: async (id, version) => (id === 'conn-other' && version === '1.0.0' ? { manifest: { ...manifestOf(otherDecls), id: 'conn-other' }, version, author: 'Автор', verifiedAt: 1 } : current && id === 'conn-demo' && version === current.version ? current : null), userId: () => 'u1', grants, journal, comFor: id => id === 'conn-other' ? otherCom : com, lookup, now: () => clock });
  const call = (connection: string, body: unknown, session = 's1', version = '1.0.0') => service.call('w1', { moduleId: 'conn-demo', version, session, connection, call: body });
  const code = (r: any) => (r.ok ? 'ok' : r.code);
  const callOther = (connection: string, body: unknown) => service.call('w1', { moduleId: 'conn-other', version: '1.0.0', session: 'o1', connection, call: body });
  const allowOther = (id: string) => grants.decide('u1', 'conn-other', id, grantKey(otherDecls.find(d => d.id === id)!), 'w1:o1', 'always');
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
  await allow('evil'); await allow('corp'); await allowOther('meta');
  clock += 2000;
  check('имя, которое разрешилось в 127.0.0.1, без явного объявления внутреннего — отказ', code(await call('evil', { op: 'http', method: 'GET', path: '/' })) === 'TARGET');
  check('адрес облачных метаданных закрыт даже при флаге internal', code(await callOther('meta', { op: 'http', method: 'GET', path: '/' })) === 'TARGET');
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


  grants.setPolicy([]);
  // ── Приёмка: белый список COM, поколения помощника, пределы, адреса ──
  const dangerous = (progId: string, extra: object = {}) => parseConnections([{ id: 'x', kind: 'com', progId, app: 'Программа', does: 'Делает что-то полезное для человека', access: 'read', ...extra }]);
  check('опасные COM-объекты закрыты и в версионных именах, и в других семействах', ['WScript.Shell.1', 'Shell.Application.1', 'Scripting.FileSystemObject', 'Scripting.FileSystemObject.2', 'ADODB.Connection', 'ADODB.Stream.6.0',
    'CDO.Message', 'Excel.Application.16', 'Outlook.Application', 'Access.Application', 'PowerPoint.Application', 'Visio.Application', 'WbemScripting.SWbemLocator', 'Microsoft.XMLHTTP.1', 'MSXML2.XMLHTTP.6.0'].every(p => dangerous(p) === null));
  check('опасный объект открывается только флагом владельца, обычный — без флага', dangerous('Scripting.FileSystemObject', { allowDangerous: true })?.length === 1 && dangerous('Scripting.Dictionary')?.length === 1 && dangerous('CT.Application')?.length === 1
    && describeConnection(dangerous('Scripting.FileSystemObject', { allowDangerous: true })![0]).includes('опасный'));
  const forged = { ...manifestOf(decls), connections: [{ id: 'fso', kind: 'com', progId: 'WScript.Shell.1', app: 'Программа', does: 'Делает что-то полезное для человека', access: 'read' }] };
  current = { manifest: forged, version: '1.0.0', author: 'Автор', verifiedAt: 1 };
  await grants.decide('u1', 'conn-demo', 'fso', 'x', 'w1:s1', 'always');
  check('главный процесс отказывает на каждом вызове, если в проверенном манифесте оказался опасный COM без флага', code(await call('fso', { op: 'com-open' })) === 'DENIED');
  current = { manifest: manifestOf(decls), version: '1.0.0', author: 'Автор', verifiedAt: 1 };
  await allow('fso');

  // Вложенные опасные объекты
  const e3b: any = await call('e3', { op: 'com-open' });
  const shell: any = await call('e3', { op: 'com-call', handle: e3b.data.handle, name: 'CreateShell' });
  check('объект опасного типа в ответе не выдаётся без флага: ошибка, номер не зарегистрирован', code(shell) === 'FAILED' && com.denySeen.at(-1)!.length > 0);
  const fsoOpen: any = await call('fso', { op: 'com-open' });
  await call('fso', { op: 'com-call', handle: fsoOpen.data.handle, name: 'GetBaseName', args: ['a.b'] });
  check('при флаге владельца список опасных типов не передаётся', com.denySeen.at(-1)!.length === 0);

  // Пакет вызовов
  const batch: any = await call('fso', { op: 'com-batch', calls: [{ kind: 'call', handle: fsoOpen.data.handle, name: 'GetBaseName', args: ['C:\\a\\b.txt'] }, { kind: 'call', handle: fsoOpen.data.handle, name: 'NoSuchMethod' }, { kind: 'call', handle: fsoOpen.data.handle, name: 'BuildPath', args: ['a', 'b'] }] });
  check('com-batch: вызовы за один обход, на первой ошибке остановка', batch.ok && batch.data.results.length === 2 && batch.data.results[0].value === 'b' && 'error' in batch.data.results[1]);
  check('в пакете не больше 200 вызовов; чужой номер в пакете — отказ', code(await call('fso', { op: 'com-batch', calls: Array.from({ length: 201 }, () => ({ kind: 'get', handle: fsoOpen.data.handle, name: 'X' })) })) === 'DENIED'
    && code(await call('fso', { op: 'com-batch', calls: [{ kind: 'get', handle: 99999, name: 'X' }] })) === 'DENIED');
  check('аргументы COM больше предела — LIMIT', code(await call('fso', { op: 'com-call', handle: fsoOpen.data.handle, name: 'GetBaseName', args: ['я'.repeat(70000)] })) === 'LIMIT');
  // Частота COM: 300 вызовов в одну секунду проходят (HTTP-предел 20/с на COM не распространяется)
  clock += 5000;
  let comLimited = 0;
  for (let i = 0; i < 300; i++) if (code(await call('fso', { op: 'com-call', handle: fsoOpen.data.handle, name: 'GetBaseName', args: ['a.b'] })) === 'LIMIT') comLimited++;
  check('COM: сотни вызовов в секунду не упираются в предел HTTP', comLimited === 0);
  // Очередь: одновременные вызовы идут по одному, сверх очереди — LIMIT
  const slowCom = new FakeCom(); (slowCom as any).delay = 30;
  const slowInvoke = com.invoke.bind(com);
  (com as any).invoke = async (...a: any[]) => { await new Promise(r => setTimeout(r, 30)); return (slowInvoke as any)(...a); };
  const wave = await Promise.all(Array.from({ length: 14 }, () => call('fso', { op: 'com-call', handle: fsoOpen.data.handle, name: 'GetBaseName', args: ['a.b'] })));
  (com as any).invoke = slowInvoke;
  check('COM: одновременные вызовы стоят в очереди помощника (не больше 8), остальные — LIMIT', wave.filter(r => r.ok).length >= 8 && wave.some(r => code(r) === 'LIMIT'));
  clock += 5000;

  // Помощник перезапустился: старые номера — чужие или выдуманные, учёт обнулён, другая подпрограмма не задета
  const otherGrant = grantKey(decls.find(d => d.id === 'e3')!);
  await grants.decide('u1', 'conn-other', 'e3', otherGrant, 'w1:o1', 'always');
  const otherOpen: any = await service.call('w1', { moduleId: 'conn-other', version: '1.0.0', session: 'o1', connection: 'e3', call: { op: 'com-open' } });
  const stale = e3b.data.handle;
  com.crash();
  check('после перезапуска помощника старый номер объекта не действует', code(await call('e3', { op: 'com-get', handle: stale, name: 'Version' })) === 'DENIED');
  check('перезапуск помощника одной подпрограммы не трогает объекты другой', (await service.call('w1', { moduleId: 'conn-other', version: '1.0.0', session: 'o1', connection: 'e3', call: { op: 'com-get', handle: otherOpen.data.handle, name: 'Version' } }) as any).data?.value === '2023');
  const reopened: any = await call('e3', { op: 'com-open' });
  check('после перезапуска учёт открытых подключений обнулён, новые номера не повторяют старые', reopened.ok && reopened.data.handle !== stale);

  // Предел объектов: лишние освобождаются, а не висят
  const savedHandles = CONNECTION_LIMITS.comHandles;
  (CONNECTION_LIMITS as any).comHandles = 4;
  const releasedBefore = com.released.length;
  let overflow = '';
  for (let i = 0; i < 6; i++) { const r: any = await call('e3', { op: 'com-call', handle: reopened.data.handle, name: 'CreateJob' }); if (!r.ok) { overflow = r.code; break; } }
  (CONNECTION_LIMITS as any).comHandles = savedHandles;
  check('сверх предела объектов — LIMIT, и созданный лишний объект освобождён', overflow === 'LIMIT' && com.released.length > releasedBefore);
  check('предел объектов COM поднят для E3', savedHandles >= 4096);
  await service.closeSession('w1', 's1');

  // Адреса и DNS
  check('новые закрытые диапазоны: 6to4, Teredo, ::/96; внутренние: 192.0.0.0/24, 198.18.0.0/15; петля IPv6 осталась петлёй', addressClass('2002:808:808::1') === 'blocked' && addressClass('2001::1') === 'blocked'
    && addressClass('::2') === 'blocked' && addressClass('::1') === 'loopback' && addressClass('192.0.0.5') === 'private' && addressClass('198.19.0.1') === 'private');
  await allow('mixed'); await allow('pin'); await allowOther('hang'); await allow('api');
  check('набор адресов [публичный, 127.0.0.1] отвергается целиком: все адреса имени обязаны быть допустимыми', code(await call('mixed', { op: 'http', method: 'GET', path: '/' })) === 'TARGET');
  const rebind = { kind: 'http' as const, id: 'r', app: 'Сервер', does: 'Делает что-то полезное', access: 'read' as const, url: 'http://rebind.test:80', pathPrefix: '/' };
  let answer = ['8.8.8.8'];
  const firstPick = await pickAddress(rebind, async () => answer);
  answer = ['127.0.0.1'];
  const secondPick = await pickAddress(rebind, async () => answer);
  check('подмена ответа DNS между вызовами: каждый вызов проверяет свой ответ (публичный — да, затем 127.0.0.1 — нет)', firstPick?.address === '8.8.8.8' && secondPick === null);
  const hitsBefore = hits;
  const pinned: any = await call('pin', { op: 'http', method: 'GET', path: '/api/ping' });
  check('соединение идёт на проверенный адрес, а не на заново разрешённое имя (имя pin.test системой не разрешается)', pinned.ok && hits === hitsBefore + 1);
  const dnsStarted = Date.now();
  const hung = code(await callOther('hang', { op: 'http', method: 'GET', path: '/' }));
  check('зависший DNS: отказ за ~5 с, а не вечное ожидание', hung === 'TARGET' && Date.now() - dnsStarted < 8000);

  // Одновременные вызовы и общий срок
  clock += 5000;
  const parallel = await Promise.all(Array.from({ length: 5 }, () => call('api', { op: 'http', method: 'GET', path: '/api/slow' })));
  check('пять одновременных вызовов против предела четырёх: ровно один LIMIT', parallel.filter(r => r.ok).length === 4 && parallel.filter(r => code(r) === 'LIMIT').length === 1);
  clock += 5000;
  const savedMs = CONNECTION_LIMITS.callMs;
  (CONNECTION_LIMITS as any).callMs = 700;
  const dripStarted = Date.now();
  const dripped = code(await call('api', { op: 'http', method: 'GET', path: '/api/drip' }));
  (CONNECTION_LIMITS as any).callMs = savedMs;
  check('медленный ответ по капле обрывается общим сроком вызова, а не только простоем сокета', dripped === 'TIMEOUT' && Date.now() - dripStarted < 2000);
  clock += 5000;

  // Разница разрешений и окно установки
  const lines = permissionLines(manifestOf(decls)).filter(l => l.kind === 'connect');
  check('окно установки показывает подключения словами: имя программы, доступ, что делает, адрес мелко', lines.length === decls.length && lines[0].text.includes('«Сервер расчётов»') && lines[0].text.includes('отправлять данные') && lines[0].text.includes('HTTP http://127.0.0.1'));
  const diff = diffPermissions(manifestOf(decls), manifestOf(widened));
  check('разница запроса: расширенный доступ, новый адрес и смена текста для человека — «новое»', diff.widened && diff.added.connections?.length === 1
    && diffPermissions(manifestOf(decls), manifestOf(decls.map(d => ({ ...d, does: 'Другая подробная формулировка текста' })))).widened);

  // Журнал
  const entries = journal.recent(500);
  const text = JSON.stringify(entries);
  check('журнал: записи годной формы, итоги и объём есть', entries.length > 20 && entries.every(validEntry) && entries.some(e => e.outcome === 'user-denied') && entries.some(e => e.outcome === 'limit') && entries.some(e => e.bytesIn > 0));
  check('журнал: содержимого вызовов нет — ни тела, ни аргументов, ни ответа', !text.includes('привет') && !text.includes('файл.txt') && !text.includes('эхо') && !text.includes('x-token') && !text.includes('Bearer abc'));
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
