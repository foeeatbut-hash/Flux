/** Экспорт реальных записей API/БД: связь, приватность и последние события. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readSource } from '../diagnostics/node/read';
import { collectServerSources } from '../server/feedback/collect';
import { closeServerDiagnostics, serverDiagnostics, recordServerError, traceRequest } from '../server/diagnostics';
import { registerSessionRoutes } from '../server/authSessions';

let checks = 0;
const check = (name: string, condition: unknown) => {
  assert.ok(condition, name); checks++; console.log('✓', name);
};
const events = (text: string) => text.trim() ? text.trim().split('\n').map(line => JSON.parse(line)) : [];
async function main() {
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-export-'));
const previousDir = process.env.FLUX_DIAGNOSTICS_DIR;
const mine = randomUUID(), other = randomUUID();
const mineTrace = randomUUID(), otherTrace = randomUUID(), unownedTrace = randomUUID();
try {
  process.env.FLUX_DIAGNOSTICS_DIR = root;
  const sink = serverDiagnostics();
  sink.record('http.end', { trace: mineTrace, actor: mine, method: 'POST', route: '/api/logout', status: '503', outcome: 'error' });
  sink.record('db.op', { trace: mineTrace, model: 'AppSetting', operation: 'upsert', ok: false, outcome: 'error', code: 'P2003' });
  sink.record('http.end', { trace: otherTrace, actor: other, method: 'GET', route: '/api/projects', status: '200' });
  sink.record('db.op', { trace: otherTrace, model: 'Project', operation: 'findMany', ok: true });
  sink.record('db.op', { trace: unownedTrace, model: 'User', operation: 'findMany', ok: true });
  const window = { from: Date.now() - 60_000, to: Date.now() + 60_000 };
  // Не сбрасываем очередь сами: сборщик обязан включать последние события.
  const bundle = await collectServerSources({ ...window, actorId: mine });
  check('API попадает в пакет по полю trace', events(bundle.serverText).some(e => e.data.trace === mineTrace && e.event === 'http.end'));
  check('ошибка БД с кодом и операцией связана с API', events(bundle.databaseText).some(e => e.data.trace === mineTrace && e.data.code === 'P2003' && e.data.operation === 'upsert'));
  check('оба источника доступны после сброса очереди сборщиком', bundle.reports.every(r => r.state === 'available' && r.events > 0));
  check('запросы другого сотрудника исключены', !`${bundle.serverText}${bundle.databaseText}`.includes(otherTrace));
  check('операция без доказанного владельца исключена', !bundle.databaseText.includes(unownedTrace));
  for (const report of bundle.reports) {
    const text = report.source === 'server' ? bundle.serverText : bundle.databaseText;
    check(`размер источника ${report.source} совпадает с UTF-8`, report.bytes === Buffer.byteLength(text));
    check(`контрольная сумма источника ${report.source} относится к его файлу`, report.sha256 === createHash('sha256').update(text).digest('hex'));
  }
  const anonymous = await collectServerSources({ ...window, actorId: '' });
  check('без автора общий журнал не выдаётся', !anonymous.serverText && !anonymous.databaseText);
  const absent = await collectServerSources({ ...window, actorId: randomUUID() });
  check('без собственных запросов чужие записи не выдаются', !absent.serverText && !absent.databaseText);
  const selected = await readSource(root, 'server', { ...window, traceIds: [mineTrace], maxBytes: 100_000 });
  check('чтение по trace возвращает API и БД', events(selected.text).length === 2);
  const empty = await readSource(root, 'server', { ...window, traceIds: [], maxBytes: 100_000 });
  check('пустой список trace не означает весь журнал', !empty.text);
  const outside = await readSource(root, 'server', { from: window.to + 1000, to: window.to + 2000, maxBytes: 100_000 });
  check('события за пределами интервала не выдаются', !outside.text);

  // Сообщение драйвера с секретом не должно попадать даже в error-событие.
  const failure = Object.assign(new Error('password=NEVER_LOG_THIS SQL values NEVER_LOG_THIS'), { code: 'P2003' });
  recordServerError('auth.logout', failure);
  await sink.flush();
  const errors = await readSource(root, 'server', { ...window, maxBytes: 100_000 });
  check('серверная ошибка содержит место и код', events(errors.text).some(e => e.event === 'log.error' && e.data.context === 'auth.logout' && e.data.code === 'P2003'));
  check('сообщение драйвера и SQL не попадают в журнал', !errors.text.includes('NEVER_LOG_THIS'));

  // Проходим настоящий обработчик выхода и middleware без сети и рабочей БД.
  let logout: any;
  registerSessionRoutes({ get() {}, post(_path: string, handler: any) { logout = handler; } } as any, {
    verify: () => mine, revoke: async () => { throw failure; },
  } as any);
  const routeTrace = randomUUID();
  const req: any = {
    path: '/api/logout', originalUrl: '/api/logout', baseUrl: '', route: { path: '/api/logout' }, method: 'POST',
    authUser: { id: mine }, headers: { authorization: 'Bearer NEVER_LOG_THIS' },
    get: (name: string) => name === 'X-Flux-Trace' ? routeTrace : '',
  };
  const res: any = new EventEmitter();
  res.statusCode = 200;
  res.setHeader = () => undefined; res.getHeader = () => undefined;
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = () => { res.writableFinished = true; res.emit('finish'); return res; };
  await new Promise<void>((resolve, reject) => traceRequest(req, res, () => {
    Promise.resolve(logout(req, res)).then(() => resolve(), reject);
  }));
  const logoutBundle = await collectServerSources({ ...window, actorId: mine });
  const logoutEvents = events(logoutBundle.serverText).filter(e => e.data.trace === routeTrace);
  check('отказ выхода сохраняет прежний HTTP 503', res.statusCode === 503);
  check('пакет выхода связывает класс и код ошибки с запросом', logoutEvents.some(e => e.event === 'log.error' && e.data.context === 'auth.logout' && e.data.error === 'Error' && e.data.code === 'P2003'));
  check('HTTP 503 и серверная ошибка имеют одну метку', logoutEvents.some(e => e.event === 'http.end' && e.data.status === '503'));
  check('токен выхода и сообщение ошибки отсутствуют в пакете', !logoutBundle.serverText.includes('NEVER_LOG_THIS'));

  const utfDir = path.join(root, 'utf8');
  await fs.mkdir(utfDir);
  const utfEvent = { v: 1, time: new Date().toISOString(), session: randomUUID(), seq: 1, source: 'server', event: 'http.end', data: { trace: mineTrace, route: '/api/оборудование/:id', status: '200' } };
  await fs.writeFile(path.join(utfDir, `server-${utfEvent.session}-000000.jsonl`), `${JSON.stringify(utfEvent)}\n`);
  const utf = await readSource(utfDir, 'server', { ...window, maxBytes: 100_000 });
  check('байты кириллицы считаются по UTF-8', utf.report.bytes === Buffer.byteLength(utf.text) && utf.report.bytes > utf.text.length);
  const tooSmall = await readSource(utfDir, 'server', { ...window, maxBytes: utf.report.bytes - 1 });
  check('предел в байтах не пропускает слишком большую строку', !tooSmall.text && tooSmall.report.state === 'truncated');
  console.log(`${checks} проверок пройдено`);
} finally {
  await closeServerDiagnostics();
  if (previousDir === undefined) delete process.env.FLUX_DIAGNOSTICS_DIR;
  else process.env.FLUX_DIAGNOSTICS_DIR = previousDir;
  await fs.rm(root, { recursive: true, force: true });
}
}
main().catch(error => { console.error(error); process.exitCode = 1; });
