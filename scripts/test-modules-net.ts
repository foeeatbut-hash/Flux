/**
 * Разрешения `internet` и `lan` и вызов `flux.net.fetch(url)`: главный процесс без Electron на настоящем
 * локальном HTTP-сервере с подменённым разрешением имён.
 *
 * Как проверяется «публичный» и «частный» адрес, когда настоящий сервер один и слушает 127.0.0.1: соединения
 * Node перенаправляются на него в `net.Socket.connect`, но ПОСЛЕ того как у вызова спрошен его собственный `lookup`
 * — тот, что Flux закрепил за проверенным адресом. Так тест видит, к какому адресу Flux ПЫТАЛСЯ подключиться
 * (8.8.8.8, 10.9.9.9), и что к закрытым адресам (петля, метаданные) он не пытается вообще.
 *
 * Запуск: npx tsx scripts/test-modules-net.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import vm from 'node:vm';
import { build } from 'esbuild';
import { validMessage } from '../modules/schemas';
import { createModuleBridge } from '../modules/bridge';
import { themeKeys } from '../modules/contract';
import { CONNECTION_LIMITS } from '../modules/connections/model';
import { parseFetchUrl, netAddressAllowed } from '../modules/permissions/netAddress';
import { buildPageAssets } from '../modules/build';
import { ModuleConnections, NET_POLICY, type VerifiedModule } from '../electron/moduleConnections';
import { ModuleGrants } from '../electron/moduleGrants';
import { ModuleJournal } from '../electron/moduleJournal';
import { INVOKE_CHANNELS } from '../electron/ipcAllow';
import { FakeCom } from './fixtures/fakeCom';

let passed = 0;
const check = (name: string, condition: unknown) => { assert.ok(condition, name); passed++; console.log(`  ✓ ${name}`); };
let completed = false;
process.on('exit', () => { if (!completed) { console.error('ПРОВАЛ: проверка сети не дошла до конца'); process.exitCode = 1; } });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-net-'));

// ── Настоящий сервер и перехват соединений ──
interface Hit { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }
const hits: Hit[] = [];
const BIG = Buffer.alloc(CONNECTION_LIMITS.bodyBytes + 10, 97);
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    hits.push({ method: req.method || '', url: req.url || '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/echo?followed=1' }); res.end(); return; }
    if (req.url === '/cookie') { res.writeHead(200, { 'Set-Cookie': 'sid=1', 'X-Plain': 'yes' }); res.end('ok'); return; }
    if (req.url === '/big') { res.writeHead(200); res.end(BIG); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ method: req.method, url: req.url, host: req.headers.host, body: Buffer.concat(chunks).toString('utf8') }));
  });
});
const listening = new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)));

/** Куда Flux пытался подключиться (после закрепления адреса) */
const attempts: string[] = [];
let serverPort = 0;
const originalConnect = net.Socket.prototype.connect;
(net.Socket.prototype as any).connect = function (this: net.Socket, ...args: any[]) {
  // Node вызывает connect с уже нормализованным массивом [параметры, обратный вызов]
  const packed = Array.isArray(args[0]);
  const options = packed ? args[0][0] : args[0];
  if (options && typeof options === 'object' && typeof options.lookup === 'function' && options.host !== '127.0.0.1') {
    // Спрашиваем у вызова тот самый lookup, которым Node узнал бы адрес: он закреплён за проверенным
    options.lookup(options.host, {}, (_e: unknown, address: string) => {
      attempts.push(address);
      const redirected = { ...options, host: '127.0.0.1', port: serverPort, lookup: undefined };
      if (packed) { const again: any = [redirected, args[0][1]]; Object.getOwnPropertySymbols(args[0]).forEach(sym => { again[sym] = args[0][sym]; }); (originalConnect as any).call(this, again); }
      else (originalConnect as any).call(this, redirected, ...args.slice(1));
    });
    return this;
  }
  return (originalConnect as any).apply(this, args);
};

async function main() {
  serverPort = await listening;
  const NET = 'Показывает курсы валют и погоду из открытых сервисов';
  const LAN = 'Находит принтеры и контроллеры в сети предприятия';
  const manifestOf = (id: string, permissions?: Array<{ kind: string; does: string }>, extra: object = {}) =>
    ({ id, name: 'Сеть', version: '1.0.0', author: 'Автор', contractVersion: permissions ? 3 : 1, entries: ['start'], reads: [], logic: 'logic/main.ts', ...(permissions ? { permissions } : {}), ...extra }) as any;
  const modules: Record<string, VerifiedModule> = {};
  const add = (id: string, permissions?: Array<{ kind: string; does: string }>, extra: object = {}) => { modules[id] = { manifest: manifestOf(id, permissions, extra), version: '1.0.0', author: 'Автор', verifiedAt: 1 }; };
  add('net-internet', [{ kind: 'internet', does: NET }]);
  add('net-lan', [{ kind: 'lan', does: LAN }]);
  add('net-both', [{ kind: 'internet', does: NET }, { kind: 'lan', does: LAN }]);
  add('net-none');
  add('net-conn', undefined, { connections: [{ id: 'api', kind: 'http', app: 'Сервер расчётов', does: 'Отправляет данные на расчёт', access: 'send', url: `http://127.0.0.1:${serverPort}`, pathPrefix: '/api' }] });

  const answers: Record<string, string[]> = {
    'pub.test': ['8.8.8.8'], 'corp.test': ['10.9.9.9'], 'evil.test': ['127.0.0.1'], 'meta.test': ['169.254.169.254'], 'zero.test': ['0.0.0.0'], 'v6loop.test': ['::1'],
    'mixed.test': ['8.8.8.8', '127.0.0.1'], 'mixednet.test': ['8.8.8.8', '10.9.9.9'], 'mapped.test': ['::ffff:127.0.0.1'], 'ali.test': ['100.100.100.200'],
    'shared.test': ['100.64.1.2'], 'ula.test': ['fd12:3456::1'], 'linklocal.test': ['fe80::1'], 'multi.test': ['224.0.0.1'], 'empty.test': [],
  };
  let rebinding = 0;
  const lookup = async (host: string) => {
    if (host === 'rebind.test') return rebinding++ === 0 ? ['8.8.8.8'] : ['127.0.0.1'];
    return answers[host] ?? ['8.8.8.8'];
  };
  const grants = new ModuleGrants(path.join(dir, 'grants.json'));
  const journal = new ModuleJournal(path.join(dir, 'journal.json'));
  let clock = 5_000_000;
  const service = new ModuleConnections({ resolve: async (id, version) => (modules[id] && modules[id].version === version ? modules[id] : null), userId: () => 'u1', grants, journal, comFor: () => new FakeCom(), lookup, now: () => clock });
  // Часы идут вперёд на каждый вызов, чтобы предел «20 в секунду» не мешал проверкам по одной; в проверке самого предела вызовы идут разом
  let burst = false;
  const fetchAs = (moduleId: string, url: string, init: object = {}, version = '1.0.0') => (burst ? 0 : (clock += 1100), service.net('w1', { moduleId, version, session: 's1', call: { url, method: 'GET', ...init } }));
  const code = (r: any) => (r.ok ? 'ok' : r.code);
  /** Ответ не дошёл до сервера и к закрытому адресу соединение не открывалось */
  const untouched = async (name: string, moduleId: string, url: string, expected = 'TARGET') => {
    const h = hits.length, a = attempts.length;
    const r = await fetchAs(moduleId, url);
    check(name, code(r) === expected && hits.length === h && attempts.length === a);
  };

  console.log('1. Схема и разбор адреса');
  const env = { flux: 'module', v: 1, session: 's', id: 'n-1', type: 'net' };
  check('сообщение net: адрес и метод внутри call', validMessage('net', { ...env, call: { url: 'https://example.com/a?b=1', method: 'POST', body: 'x', encoding: 'utf8', headers: { accept: 'x' } } }));
  check('лишнее поле, чужой метод, короткий адрес — отказ', !validMessage('net', { ...env, call: { url: 'https://example.com', method: 'GET', extra: 1 } })
    && !validMessage('net', { ...env, call: { url: 'https://example.com', method: 'TRACE' } }) && !validMessage('net', { ...env, call: { url: 'x', method: 'GET' } }) && !validMessage('net', { ...env, url: 'https://example.com', method: 'GET' }));
  check('адрес разбирается: схема, имя, порт, путь с запросом', JSON.stringify(parseFetchUrl('https://Example.com:8443/a/b?c=1')) === JSON.stringify({ scheme: 'https', host: 'example.com', port: 8443, path: '/a/b?c=1' })
    && parseFetchUrl('http://example.com')?.path === '/' && parseFetchUrl('http://[::1]:81/x')?.host === '::1');
  check('не годятся: чужая схема, учётные данные, фрагмент, пробелы, обратная косая', ['file:///etc/passwd', 'ftp://example.com/', 'javascript:alert(1)', 'http://u:p@example.com/', 'http://example.com/#x', 'http://exa mple.com/', 'http://example.com\\@evil.test/', 'example.com/a', '//example.com/', 'http://example.com:99999/', '']
    .every(u => parseFetchUrl(u) === null));
  check('записи IPv4 в десятичной и шестнадцатеричной форме браузер приводит к обычному виду — класс определяет уже он', parseFetchUrl('http://2130706433/')?.host === '127.0.0.1' && parseFetchUrl('http://0x7f.1/')?.host === '127.0.0.1');
  const both = { internet: true, lan: true };
  check('классы адресов: публичный — internet, частный — lan, остальное закрыто всегда',
    netAddressAllowed('8.8.8.8', { internet: true, lan: false }) && !netAddressAllowed('8.8.8.8', { internet: false, lan: true })
    && netAddressAllowed('10.1.2.3', { internet: false, lan: true }) && !netAddressAllowed('10.1.2.3', { internet: true, lan: false })
    && ['172.16.0.1', '172.31.255.1', '192.168.0.1', '100.64.0.1', 'fd00::1', 'fc00::1'].every(a => netAddressAllowed(a, { internet: false, lan: true }) && !netAddressAllowed(a, { internet: true, lan: false }))
    && ['127.0.0.1', '127.1.2.3', '::1', '0.0.0.0', '0.1.2.3', '169.254.169.254', '169.254.1.1', '100.100.100.200', '192.0.0.192', 'fd00:ec2::254', 'fe80::1', '224.0.0.1', 'ff02::1', '255.255.255.255', '::ffff:127.0.0.1', '::ffff:7f00:1', '::', 'не адрес'].every(a => !netAddressAllowed(a, both)));
  check('172.32.x и 100.128.x — уже публичные', netAddressAllowed('172.32.0.1', { internet: true, lan: false }) && netAddressAllowed('100.128.0.1', { internet: true, lan: false }));

  console.log('\n2. Без разрешения до сервера не доходит ничего');
  await untouched('программа без permissions: DENIED', 'net-none', 'http://pub.test/echo', 'DENIED');
  await untouched('подключение http в манифесте — не разрешение на любые адреса', 'net-conn', 'http://pub.test/echo', 'DENIED');
  check('чужая версия и неизвестная программа: DENIED, до сервера не доходит', await (async () => { const h = hits.length; const a = await fetchAs('net-internet', 'http://pub.test/echo', {}, '9.9.9'), b = await fetchAs('нет-такой', 'http://pub.test/echo'); return code(a) === 'DENIED' && code(b) === 'DENIED' && hits.length === h; })());
  check('кривой вызов: DENIED', code(await service.net('w1', { moduleId: 'net-internet', version: '1.0.0', session: 's1', call: { url: 'http://pub.test/', method: 'GET', extra: 1 } })) === 'DENIED'
    && code(await service.net('w1', { moduleId: 'net-internet', version: '1.0.0', session: 's1', call: null })) === 'DENIED');
  await untouched('только internet: частный адрес закрыт (имя)', 'net-internet', 'http://corp.test/echo');
  await untouched('только internet: частный адрес закрыт (литерал)', 'net-internet', 'http://192.168.1.5/echo');
  await untouched('только lan: публичный адрес закрыт (имя)', 'net-lan', 'http://pub.test/echo');
  await untouched('только lan: публичный адрес закрыт (литерал)', 'net-lan', 'http://8.8.4.4/echo');

  console.log('\n3. Закрытые всегда адреса — даже с обоими разрешениями');
  for (const [name, url] of [
    ['петля по литералу, настоящий сервер на ней', `http://127.0.0.1:${0}/echo`], ['localhost', 'http://localhost/echo'], ['поддомен localhost', 'http://app.localhost/echo'], ['петля IPv6', 'http://[::1]/echo'], ['0.0.0.0', 'http://0.0.0.0/echo'],
    ['метаданные облака AWS/GCP', 'http://169.254.169.254/latest/meta-data/'], ['метаданные Alibaba', 'http://100.100.100.200/'], ['метаданные Oracle', 'http://192.0.0.192/'],
    ['IPv4 в обёртке IPv6', 'http://[::ffff:127.0.0.1]/'], ['десятичная запись петли', 'http://2130706433/'], ['шестнадцатеричная запись', 'http://0x7f.0.0.1/'],
    ['широковещательный', 'http://255.255.255.255/'], ['групповой', 'http://224.0.0.1/'], ['link-local IPv6', 'http://[fe80::1]/'],
    ['имя → петля', 'http://evil.test/echo'], ['имя → метаданные', 'http://meta.test/'], ['имя → 0.0.0.0', 'http://zero.test/'], ['имя → ::1', 'http://v6loop.test/'],
    ['имя → IPv4 в обёртке', 'http://mapped.test/'], ['имя → метаданные Alibaba', 'http://ali.test/'], ['имя → link-local IPv6', 'http://linklocal.test/'], ['имя → групповой', 'http://multi.test/'],
    ['имя без адресов', 'http://empty.test/'],
    ['имя: публичный и петля вперемешку', 'http://mixed.test/echo'],
  ] as const) await untouched(`закрыто: ${name}`, 'net-both', String(url).replace(':0/', `:${serverPort}/`));
  check('на настоящем сервере за петлёй за всё это время не было ни одного запроса', hits.length === 0 && attempts.length === 0);
  check('имя, сменившее ответ между проверками: соединение с проверенным адресом, повторного разрешения нет',
    code(await fetchAs('net-internet', 'http://rebind.test/echo')) === 'ok' && attempts.at(-1) === '8.8.8.8' && rebinding === 1);
  attempts.length = 0; hits.length = 0;

  console.log('\n4. Публичный и частный адреса с разрешением');
  let r: any = await fetchAs('net-internet', 'http://pub.test:8080/echo?a=1', { headers: { 'x-test': 'yes' } });
  check('internet: публичный адрес открыт, соединение — с проверенным 8.8.8.8', r.ok && attempts.at(-1) === '8.8.8.8' && r.data.status === 200);
  check('сервер получил путь, запрос и заголовок; Host — имя с портом, а не адрес', hits.at(-1)!.url === '/echo?a=1' && hits.at(-1)!.headers.host === 'pub.test:8080' && hits.at(-1)!.headers['x-test'] === 'yes');
  check('Flux не добавляет cookie и учётных данных', !hits.at(-1)!.headers.cookie && !hits.at(-1)!.headers.authorization && hits.at(-1)!.headers['user-agent'] === 'Flux-Module');
  check('ответ: код, заголовки, тело', JSON.parse(r.data.body).method === 'GET' && r.data.encoding === 'utf8');
  r = await fetchAs('net-lan', 'http://corp.test/echo');
  check('lan: частный адрес открыт (10.9.9.9)', r.ok && attempts.at(-1) === '10.9.9.9');
  r = await fetchAs('net-lan', 'http://192.168.9.9:8081/echo');
  check('lan: литерал частной сети открыт', r.ok && attempts.at(-1) === '192.168.9.9');
  check('lan: 100.64/10 и ULA IPv6 — тоже локальная сеть', code(await fetchAs('net-lan', 'http://shared.test/echo')) === 'ok' && attempts.at(-1) === '100.64.1.2' && code(await fetchAs('net-lan', 'http://ula.test/echo')) === 'ok');
  check('оба разрешения: и публичный, и частный', code(await fetchAs('net-both', 'http://pub.test/echo')) === 'ok' && code(await fetchAs('net-both', 'http://corp.test/echo')) === 'ok');
  await untouched('имя с публичным и частным адресами при одном internet — отказ целиком', 'net-internet', 'http://mixednet.test/echo');
  check('те же адреса при обоих разрешениях — можно', code(await fetchAs('net-both', 'http://mixednet.test/echo')) === 'ok');

  console.log('\n5. Запись: методы с телом, пределы, редиректы, cookie');
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    r = await fetchAs('net-internet', 'http://pub.test/echo', { method, body: `тело ${method}`, encoding: 'utf8' });
    check(`${method}: тело и метод дошли до сервера`, r.ok && hits.at(-1)!.method === method && hits.at(-1)!.body === `тело ${method}`);
  }
  check('GET с телом — отказ без обращения', await (async () => { const h = hits.length; const x = await fetchAs('net-internet', 'http://pub.test/echo', { method: 'GET', body: 'x' }); return !x.ok && hits.length === h; })());
  check('запрещённые заголовки (cookie, host, origin) — отказ без обращения', await (async () => {
    const h = hits.length; const bad = [];
    for (const name of ['cookie', 'host', 'origin', 'referer', 'proxy-authorization', 'sec-fetch-mode']) bad.push(await fetchAs('net-internet', 'http://pub.test/echo', { headers: { [name]: 'x' } }));
    return bad.every(x => code(x) === 'TARGET') && hits.length === h; })());
  r = await fetchAs('net-internet', 'http://pub.test/redirect');
  check('редирект не выполняется: 302 с Location возвращается программе, второй запрос не уходит', r.ok && r.data.status === 302 && r.data.headers.location === '/echo?followed=1' && hits.at(-1)!.url === '/redirect' && !hits.some(h => h.url.includes('followed')));
  r = await fetchAs('net-internet', 'http://pub.test/cookie');
  check('Set-Cookie программе не отдаётся, остальные заголовки — да', r.ok && r.data.headers['set-cookie'] === undefined && r.data.headers['x-plain'] === 'yes');
  check('ответ крупнее предела — LIMIT', code(await fetchAs('net-internet', 'http://pub.test/big')) === 'LIMIT');
  check('тело запроса крупнее предела — LIMIT, на сервер не уходит', await (async () => { const h = hits.length; const x = await fetchAs('net-internet', 'http://pub.test/echo', { method: 'POST', body: 'я'.repeat(CONNECTION_LIMITS.bodyBytes) }); return code(x) === 'LIMIT' && hits.length === h; })());
  check('тело в base64: двоичные данные доходят как есть', await (async () => { const x = await fetchAs('net-internet', 'http://pub.test/echo', { method: 'POST', body: Buffer.from([0xff, 0x41]).toString('base64'), encoding: 'base64' }); return x.ok && Buffer.from(hits.at(-1)!.body, 'latin1').length > 0; })());

  console.log('\n6. Политика администратора и пределы');
  grants.setPolicy([{ moduleId: 'net-both', connection: NET_POLICY.internet }]);
  await untouched('политика запретила internet: публичный адрес — NOT_ALLOWED, не доходит', 'net-both', 'http://pub.test/echo', 'TARGET');
  check('политика запретила internet: частный адрес по lan остаётся', code(await fetchAs('net-both', 'http://corp.test/echo')) === 'ok');
  grants.setPolicy([{ moduleId: 'net-both', connection: NET_POLICY.internet }, { moduleId: 'net-both', connection: NET_POLICY.lan }]);
  await untouched('запрещены оба: NOT_ALLOWED', 'net-both', 'http://corp.test/echo', 'NOT_ALLOWED');
  grants.setPolicy([{ moduleId: 'net-internet', connection: 'api' }]);
  check('правило для названного подключения «api» сеть не затрагивает', code(await fetchAs('net-internet', 'http://pub.test/echo')) === 'ok');
  grants.setPolicy([]);
  check('политика снята — снова можно', code(await fetchAs('net-both', 'http://pub.test/echo')) === 'ok');
  clock += 5000; burst = true;
  const results = await Promise.all(Array.from({ length: CONNECTION_LIMITS.callsPerSecond + 6 }, () => fetchAs('net-internet', 'http://pub.test/echo')));
  burst = false;
  check('больше 20 вызовов в секунду — LIMIT', results.some(x => code(x) === 'LIMIT') && results.some(x => x.ok));

  console.log('\n7. Журнал: к чему, но не что');
  const logged = journal.recent(2000).filter(e => e.moduleId === 'net-internet' || e.moduleId === 'net-both');
  check('записи есть, категория подключений', logged.length > 5 && logged.every(e => e.category === 'connection'));
  check('в записи метод и имя сервера', logged.some(e => e.detail.includes('GET pub.test') && e.outcome === 'ok'));
  check('в журнале нет пути, запроса, заголовков и тела', logged.every(e => !/echo|\?a=1|x-test|тело/.test(JSON.stringify(e))));
  check('отказы записаны: «адрес», «лимит»', logged.some(e => e.outcome === 'target') && logged.some(e => e.outcome === 'limit'));

  console.log('\n8. Мост');
  const sent: any[] = [];
  const frame = { postMessage: (m: unknown) => sent.push(m) } as unknown as Window;
  const theme = Object.fromEntries(themeKeys.map(k => [k, '#000'])) as never;
  const netCalls: any[] = [];
  const bridgeFor = (manifest: any) => createModuleBridge({ frame: () => frame, session: 's', manifest, context: () => ({ projectId: 'p', entry: 'start', entityId: null }), theme: () => theme, read: (async () => null) as never,
    net: async call => { netCalls.push(call); return { ok: true, data: { status: 200, headers: {}, body: 'привет', encoding: 'utf8' } }; },
    connect: async () => ({ ok: true, data: 'old-form' }) });
  const post = async (bridge: ReturnType<typeof bridgeFor>, data: object) => { sent.length = 0; await bridge.handle({ source: frame as never, origin: 'null', data: { flux: 'module', v: 1, session: 's', ...data } }); return sent[0]; };
  const open = async (manifest: any) => { const b = bridgeFor(manifest); await b.handle({ source: frame as never, origin: 'null', data: { flux: 'module', v: 1, session: 's', type: 'ready' } }); return b; };
  let bridge = await open(modules['net-internet'].manifest);
  let reply = await post(bridge, { type: 'net', id: 'n-1', call: { url: 'https://example.com/a', method: 'POST', body: 'q', encoding: 'utf8' } });
  check('net с разрешением: ответ connect-result, POST не принят за запись в данные Flux', reply.type === 'connect-result' && reply.id === 'n-1' && reply.data.body === 'привет' && netCalls.length === 1 && netCalls[0].method === 'POST');
  reply = await post(bridge, { type: 'net', id: 'n-2', call: { url: 'https://example.com/a', method: 'GET', extra: 1 } });
  check('net с лишним полем: DENIED, главный процесс не вызван', reply.type === 'connect-error' && reply.code === 'DENIED' && netCalls.length === 1);
  reply = await post(bridge, { type: 'net', id: 'n-3', url: 'https://example.com/', method: 'GET' });
  check('адрес вне call — DENIED (верхний уровень с методом мост не пропускает)', reply.type === 'connect-error' || reply.type === 'error');
  bridge = await open(modules['net-none'].manifest);
  reply = await post(bridge, { type: 'net', id: 'n-4', call: { url: 'https://example.com/a', method: 'GET' } });
  check('net без permissions в манифесте: DENIED на стороне окна', reply.type === 'connect-error' && reply.code === 'DENIED' && netCalls.length === 1);
  bridge = await open(modules['net-conn'].manifest);
  reply = await post(bridge, { type: 'net', id: 'n-5', call: { url: 'https://example.com/a', method: 'GET' } });
  check('подключение http не заменяет разрешение сети', reply.type === 'connect-error' && reply.code === 'DENIED' && netCalls.length === 1);
  reply = await post(bridge, { type: 'connect', id: 'c-1', connection: 'api', call: { op: 'http', method: 'GET', path: '/api/x' } });
  check('прежний вызов подключения работает как раньше', reply.type === 'connect-result' && reply.data === 'old-form');

  console.log('\n9. Клиент flux.net.fetch: две формы');
  const clientCode = (await buildPageAssets())['modules/_flux/flux.v1.js'] as string;
  const posted: any[] = [];
  let onMessage: ((e: any) => void) | null = null;
  const parentWin = { postMessage: (m: any) => posted.push(m) };
  const sandbox: any = {
    window: { name: 's', addEventListener: (t: string, f: any) => { if (t === 'message') onMessage = f; }, innerWidth: 800, innerHeight: 600 },
    document: { documentElement: { style: { setProperty() {} }, dataset: {} }, addEventListener() {} }, location: { hash: '#s', origin: 'null', pathname: '/' },
    parent: parentWin, setInterval: () => 0, setTimeout, clearTimeout, atob, TextEncoder, TextDecoder, Uint8Array, JSON, console,
  };
  sandbox.window.parent = parentWin; sandbox.globalThis = sandbox;
  vm.runInNewContext(clientCode, sandbox);
  const flux = sandbox.flux;
  const answer = (id: string) => onMessage!({ source: parentWin, data: { flux: 'module', session: 's', type: 'connect-result', id, data: { status: 200, headers: {}, body: '{"a":1}', encoding: 'utf8' } } });
  const p1 = flux.net.fetch('https://example.com/a?b=1', { method: 'POST', headers: { accept: 'application/json' }, body: 'q' });
  const m1 = posted.at(-1);
  check('полный адрес → сообщение net с call', m1.type === 'net' && m1.call.url === 'https://example.com/a?b=1' && m1.call.method === 'POST' && m1.call.body === 'q' && m1.call.encoding === 'utf8' && m1.call.headers.accept === 'application/json' && m1.connection === undefined && m1.call.op === undefined);
  answer(m1.id);
  const got = await p1;
  check('ответ: status, ok, json()', got.status === 200 && got.ok && got.json().a === 1);
  const p2 = flux.net.fetch('api', '/api/x', { method: 'PUT', body: 'z' });
  const m2 = posted.at(-1);
  check('прежняя форма (подключение, путь) → сообщение connect, как раньше', m2.type === 'connect' && m2.connection === 'api' && m2.call.op === 'http' && m2.call.path === '/api/x' && m2.call.method === 'PUT' && m2.call.body === 'z');
  answer(m2.id); await p2;
  flux.net.fetch('HTTP://Example.com/');
  check('схема в любом регистре, init необязателен', posted.at(-1).type === 'net' && posted.at(-1).call.method === 'GET');
  flux.net.fetch('api-http', '/p');
  check('имя подключения вроде «api-http» — не адрес', posted.at(-1).type === 'connect');

  console.log('\n10. Канал');
  check('канал modules:net разрешён окну', INVOKE_CHANNELS.has('modules:net'));

  server.close();
  completed = true;
  console.log(`\nВСЕ ТЕСТЫ ПРОЙДЕНЫ (${passed})`);
}
main().then(() => process.exit(0)).catch(e => { console.error('✗', e); process.exit(1); });
