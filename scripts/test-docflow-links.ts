/**
 * Связь файла со строкой ВДР на сервере (docs/docflow-program.md, 4, 7.3, 10):
 * проверка имени по маске на сервере, назначения папок, «файл уже связан»,
 * история отвязок, замечания к файлу ревизии, слежение за переименованием.
 *
 * Настоящая SQLite-база и настоящий express.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import express from 'express';
import { registerVdrRoutes } from '../server/routes/vdr.js';
import { registerDocflowRoutes } from '../server/routes/docflow.js';
import { registerDocflowLinkRoutes } from '../server/routes/docflowLinks.js';
import { registerProjectFolderBindingRoutes } from '../server/routes/projectFolderBindings.js';
import { entityRefsOfRequest } from '../server/projectEntityAccess.js';
import { vdrPermissionFor } from '../server/vdrPermissions.js';
import { bootstrapLocalDatabase } from '../server/databaseBootstrap.js';
import { setPrisma, setBroadcaster } from '../server/context.js';
import { linkLookupKey, relativeInBinding, relativePathProblem } from '../shared/docflow/links.js';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('../prisma-clients/client-sqlite');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-docflow-links-'));
const dbPath = path.join(temp, 'fixture.sqlite');
const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${dbPath}` }) });
let passed = 0;
const check = (label: string, condition: unknown, detail?: unknown) => {
  assert.ok(condition, `${label}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
  passed++;
};
const key = (c: string) => c.repeat(64);
const WORK = key('a'); const RETURNS = key('b'); const INCOMING = key('c'); const PLAIN = key('d'); const FOREIGN = key('e');

async function main() {
  // ── Чистые правила пути ──
  check('путь внутри привязанной папки — последние depth сегментов', relativeInBinding('Проект/E02/3700_B.pdf', 2) === 'E02/3700_B.pdf' && relativeInBinding('a.pdf', 1) === 'a.pdf');
  check('путь за пределами цепочки — пусто', relativeInBinding('a.pdf', 3) === '' && relativeInBinding('a.pdf', 0) === '');
  check('ключ поиска не зависит от регистра и вида слэша', linkLookupKey(WORK, 'E02\\X.PDF') === linkLookupKey(WORK, 'e02/x.pdf'));
  check('«..» и абсолютный путь отвергаются', !!relativePathProblem('../x.pdf', 'x.pdf') && !!relativePathProblem('C:/x.pdf', 'x.pdf') && !!relativePathProblem('/x.pdf', 'x.pdf'));
  for (const segment of ['CON', 'prn.txt', 'AUX', 'nul.log', 'COM1', 'com9.pdf', 'LPT1', 'lpt9.txt', 'папка.', 'папка ']) {
    check(`Windows не принимает сегмент «${segment}»`, !!relativePathProblem(`${segment}/x.pdf`, 'x.pdf') && !!relativePathProblem(segment, segment));
  }
  check('похожие допустимые имена не блокируются', relativePathProblem('console/COM10.txt', 'COM10.txt') === null);
  check('имя должно быть концом пути', !!relativePathProblem('a/b.pdf', 'c.pdf') && relativePathProblem('a/B.PDF', 'b.pdf') === null);

  // ── Права и общий страж проекта ──
  check('чтение связей — просмотр', vdrPermissionFor('GET', '/api/docflow/links')?.perm === 'docflow.view');
  for (const [m, p] of [['POST', '/api/docflow/links'], ['POST', '/api/docflow/links/plan'], ['POST', '/api/docflow/links/unlink'], ['POST', '/api/docflow/links/track']] as const) {
    check(`${m} ${p} — право назначения файлов`, vdrPermissionFor(m, p)?.perm === 'docflow.files', p);
  }
  check('страж проекта видит строку в теле запроса', entityRefsOfRequest('/api/docflow/links', { itemId: 'i1' }, {}).some((r) => r.kind === 'vdrItem' && r.id === 'i1'));

  const app = express();
  app.use(express.json());
  let actor: any = { id: 'admin', role: 'ADMIN' };
  app.use((req, _res, next) => { (req as any).authUser = actor; next(); });
  registerVdrRoutes(app as any, { chunkBytes: async () => 1024 });
  registerDocflowRoutes(app as any);
  registerDocflowLinkRoutes(app as any);
  registerProjectFolderBindingRoutes(app as any, { mayManage: async () => true });
  const server = createServer(app);
  try {
    const schema = fs.readFileSync(path.join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    await bootstrapLocalDatabase(dbPath, prisma, schema, () => {});
    setPrisma(prisma);
    setBroadcaster(() => {});
    await prisma.project.create({ data: { id: 'p-a', name: 'ЗапСиб PDH2' } });
    await prisma.project.create({ data: { id: 'p-b', name: 'Азот' } });
    await prisma.docRegister.create({ data: { id: 'reg-a', projectId: 'p-a', name: 'ВДР', poNumber: '3700' } });
    const mkItem = (id: string, no: string, code = 'E02', revision = 'B') => prisma.docRegisterItem.create({ data: { id, registerId: 'reg-a', projectId: 'p-a', contractorNo: no, vdrCode: code, revision, titleRu: `Документ ${id}` } });
    await mkItem('i1', '3700-B01-E02-001');
    await mkItem('i2', '3700-B01-E02-002');
    await mkItem('i3', '3700-B01-C32-001', 'C32', 'A');
    await mkItem('i4', '3700-B01-E02-001'); // дубль шифра: имя подходит обеим строкам
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    const send = async (method: string, url: string, body?: any) => {
      const r = await fetch(`${base}${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, body: await r.json().catch(() => ({})) as any };
    };
    const settings = (await send('GET', '/api/docflow/settings?projectId=p-a')).body;
    const saved = await send('PUT', '/api/docflow/settings', { projectId: 'p-a', config: { ...settings.config, vdrTypes: [{ code: 'E02', titleRu: 'Общий вид', titleEn: '' }, { code: 'C32', titleRu: 'Опросный лист', titleEn: '' }] }, expectedUpdatedAt: null });
    check('настройки проекта сохранены', saved.status === 200);

    // ── Назначения папок: в журнале привязок ──
    const ledger = async () => (await send('GET', '/api/explorer/project-bindings')).body;
    const upsert = async (binding: any) => send('POST', '/api/explorer/project-bindings', { expectedRevision: (await ledger()).revision, operation: { kind: 'upsert', binding } });
    const locator = (k: string) => ({ folderKey: k, anchors: [{ key: k, relativePath: '' }] });
    check('рабочая папка назначается', (await upsert({ locationKey: WORK, projectId: 'p-a', label: 'Рабочая', purpose: 'work', locator: locator(WORK) })).status === 200);
    check('папка возвратов назначается', (await upsert({ locationKey: RETURNS, projectId: 'p-a', label: 'Возвраты', purpose: 'returns' })).status === 200);
    check('входящие и папка без назначения', (await upsert({ locationKey: INCOMING, projectId: 'p-a', label: 'Входящие', purpose: 'incoming' })).status === 200 && (await upsert({ locationKey: PLAIN, projectId: 'p-a', label: 'Просто' })).status === 200);
    const second = await upsert({ locationKey: FOREIGN, projectId: 'p-a', label: 'Вторая рабочая', purpose: 'work' });
    check('вторая рабочая папка проекта — отказ с названием первой', second.status === 409 && /Рабочая/.test(second.body.error), second.body);
    check('назначение другого проекта свободно', (await upsert({ locationKey: FOREIGN, projectId: 'p-b', label: 'Чужая рабочая', purpose: 'work' })).status === 200);
    check('неизвестное назначение — отказ', (await upsert({ locationKey: key('f'), projectId: 'p-a', label: 'X', purpose: 'archive' })).status === 400);
    check('место папки от другого ключа — отказ', (await upsert({ locationKey: key('1'), projectId: 'p-a', label: 'X', locator: locator(key('2')) })).status === 400);
    const stored = (await ledger()).bindings.find((b: any) => b.locationKey === WORK);
    check('назначение и место сохранены в журнале', stored.purpose === 'work' && stored.locator.folderKey === WORK, stored);

    // ── Проверка имени до записи ──
    const plan = await send('POST', '/api/docflow/links/plan', { itemId: 'i1', fileName: '3700-B01-C32-001_B.pdf' });
    check('план: другой тип блокирует и объясняет', plan.body.blocked && /в имени тип C32, в строке E02/.test(plan.body.reason) && plan.body.expectedName === '3700-B01-E02-001_B.pdf', plan.body);
    const planOk = await send('POST', '/api/docflow/links/plan', { itemId: 'i1', fileName: '3700-B01-E02-001_B.pdf' });
    check('план: подходящее имя не блокирует', !planOk.body.blocked && planOk.body.check.revision === 'B');

    // ── Создание связи: сервер проверяет сам ──
    const body = (over: any = {}) => ({ itemId: 'i1', role: 'file', folderKey: WORK, relativePath: 'E02/3700-B01-E02-001_B.pdf', fileName: '3700-B01-E02-001_B.pdf', sha256: 'f'.repeat(64), size: 1234, ...over });
    const wrong = await send('POST', '/api/docflow/links', body({ relativePath: 'E02/3700-B01-C32-001_B.pdf', fileName: '3700-B01-C32-001_B.pdf' }));
    check('несходящееся имя не связывается: 422 и расхождения', wrong.status === 422 && wrong.body.check?.blocking?.some((f: any) => f.field === 'тип'), wrong.body);
    check('отказ ничего не записал', (await prisma.docFileLink.count()) === 0);
    const noRev = await send('POST', '/api/docflow/links', body({ relativePath: 'bad.pdf', fileName: 'bad.pdf' }));
    check('имя не по маске — 422', noRev.status === 422 && !noRev.body.check.parsed.ok, noRev.body);
    const badRev = await send('POST', '/api/docflow/links', body({ relativePath: 'E02/3700-B01-E02-001_%.pdf', fileName: '3700-B01-E02-001_%.pdf' }));
    check('ревизия не по схеме — 422', badRev.status === 422);
    const outside = await send('POST', '/api/docflow/links', body({ folderKey: key('9') }));
    check('папка не привязана к проекту — 422', outside.status === 422 && /не привязана/.test(outside.body.error), outside.body);
    const foreign = await send('POST', '/api/docflow/links', body({ folderKey: FOREIGN }));
    check('папка другого проекта не подходит', foreign.status === 422);
    const inReturns = await send('POST', '/api/docflow/links', body({ folderKey: RETURNS }));
    check('файл документа в папке возвратов — 422', inReturns.status === 422 && /Возвраты/.test(inReturns.body.error), inReturns.body);
    check('путь с «..» — 400', (await send('POST', '/api/docflow/links', body({ relativePath: '../3700-B01-E02-001_B.pdf' }))).status === 400);

    const made = await send('POST', '/api/docflow/links', body());
    check('подходящий файл связывается', made.status === 200 && made.body.link.revision === 'B' && made.body.link.role === 'file' && made.body.link.sha256 === 'f'.repeat(64), made.body);
    const dup = await send('POST', '/api/docflow/links', body({ itemId: 'i4', relativePath: 'e02\\3700-B01-E02-001_B.pdf' }));
    check('тот же файл со второй строкой — «уже связан с …»', dup.status === 409 && /уже связан с 3700-B01-E02-001/.test(dup.body.error), dup.body);
    const raceItems = ['i2', 'i3'];
    const race = (await Promise.all(raceItems.map((id) => send('POST', '/api/docflow/links', {
      itemId: id, role: 'file', folderKey: WORK, relativePath: `E02/${id === 'i2' ? '3700-B01-E02-002_B.pdf' : '3700-B01-C32-001_A.pdf'}`, fileName: id === 'i2' ? '3700-B01-E02-002_B.pdf' : '3700-B01-C32-001_A.pdf',
    })))).map((r) => r.status).sort();
    check('разные файлы разных строк связываются независимо', race[0] === 200 && race[1] === 200, race);
    const same = ['i1', 'i2'];
    // Один путь, две строки одновременно: проходит одна. Имя подходит обеим — у i2 шифр такой же, как у i1 не бывает,
    // поэтому проверяем гонку на одной строке и двух ревизиях одного файла
    const racing = (await Promise.all(same.map(() => send('POST', '/api/docflow/links', { itemId: 'i1', role: 'file', folderKey: WORK, relativePath: 'E02/3700-B01-E02-001_C.pdf', fileName: '3700-B01-E02-001_C.pdf' })))).map((r) => r.status).sort();
    check('одновременная связь одного файла: проходит один запрос', racing[0] === 200 && racing[1] === 409, racing);

    // ── Ревизии ──
    const rows = (await send('GET', '/api/docflow/links?projectId=p-a')).body;
    const c = rows.links.find((l: any) => l.fileName.endsWith('_C.pdf'));
    check('имя с новой ревизией — файл этой ревизии, строка не тронута', c.revision === 'C' && (await prisma.docRegisterItem.findUnique({ where: { id: 'i1' } })).revision === 'B');
    const second2 = await send('POST', '/api/docflow/links', body({ relativePath: 'E02/Copy/3700-B01-E02-001_B.pdf' }));
    check('второй файл той же ревизии — 409 с предложением заменить', second2.status === 409 && second2.body.replaceable, second2.body);
    const replaced = await send('POST', '/api/docflow/links', body({ relativePath: 'E02/Copy/3700-B01-E02-001_B.pdf', replace: true }));
    check('замена уводит прежнюю связь в историю', replaced.status === 200 && replaced.body.replaced.fileName === '3700-B01-E02-001_B.pdf' && !!replaced.body.replaced.unlinkedAt, replaced.body);
    const hist = (await send('GET', '/api/docflow/links?itemId=i1&history=1')).body;
    check('история хранит замену', hist.links.some((l: any) => l.unlinkedAt && /заменён/.test(l.unlinkReason)));
    check('прежний путь освободился для связи', (await send('POST', '/api/docflow/links', body({ itemId: 'i1', replace: true }))).status === 200);

    // ── Замечания (возврат) ──
    const file = (await send('GET', '/api/docflow/links?itemId=i1')).body.links.find((l: any) => l.revision === 'B' && l.role === 'file');
    const remarks = (over: any = {}) => ({ itemId: 'i1', role: 'remarks', toLinkId: file.id, folderKey: RETURNS, relativePath: 'E02/3700-B01-E02-001/B/Замечания.pdf', fileName: 'Замечания.pdf', reviewCode: '2', receivedAt: '2026-11-05', timeZone: 'Europe/Moscow', ...over });
    check('возврат к невыпущенной ревизии — 422 (выпуск проверяет scripts/test-docflow-issue.ts)', (await send('POST', '/api/docflow/links', remarks())).status === 422);
    await prisma.docRegisterItemRevision.create({ data: { itemId: 'i1', revision: 'B', reason: 'IFR', linkId: file.id, issuedKey: 'seed-i1-B', sha256: 'a'.repeat(64) } });
    check('замечания без файла ревизии — 422', (await send('POST', '/api/docflow/links', remarks({ toLinkId: undefined }))).status === 422);
    check('замечания вне папки возвратов — 422', (await send('POST', '/api/docflow/links', remarks({ folderKey: INCOMING }))).status === 422);
    check('замечания к файлу чужой строки — 422', (await send('POST', '/api/docflow/links', remarks({ itemId: 'i2' }))).status === 422);
    const rem = await send('POST', '/api/docflow/links', remarks());
    check('замечания привязаны к файлу ревизии, имя не проверяется по маске', rem.status === 200 && rem.body.link.toLinkId === file.id && rem.body.link.revision === 'B' && rem.body.link.reviewCode === '2' && rem.body.check === null, rem.body);
    check('выпущенный файл не отвязывается и не заменяется', (await send('POST', '/api/docflow/links/unlink', { itemId: 'i1', linkId: file.id })).status === 409
      && (await send('POST', '/api/docflow/links', body({ relativePath: 'E02/Copy2/3700-B01-E02-001_B.pdf', replace: true }))).status === 409);
    await prisma.docRegisterItemRevision.update({ where: { issuedKey: 'seed-i1-B' }, data: { issuedKey: null, undoneAt: new Date() } });
    const unl = await send('POST', '/api/docflow/links/unlink', { itemId: 'i1', linkId: file.id, reason: 'файл заменит новая версия' });
    check('отвязка файла уводит в историю и его замечания', unl.status === 200 && unl.body.links.length === 2 && unl.body.links.every((l: any) => !!l.unlinkedAt), unl.body);
    const after = (await send('GET', '/api/docflow/links?itemId=i1&history=1')).body.links;
    check('история не удаляется', after.filter((l: any) => l.unlinkedAt).length >= 3 && after.some((l: any) => l.unlinkReason === 'файл заменит новая версия'));
    check('повторная отвязка — 409, чужая строка — 404', (await send('POST', '/api/docflow/links/unlink', { itemId: 'i1', linkId: file.id })).status === 409 && (await send('POST', '/api/docflow/links/unlink', { itemId: 'i2', linkId: file.id })).status === 404);

    // ── Слежение: переименование, пропажа ──
    const tracked = (await send('GET', '/api/docflow/links?itemId=i2')).body.links[0];
    const renamed = await send('POST', '/api/docflow/links/track', { updates: [{ itemId: 'i2', linkId: tracked.id, relativePath: 'E02/Черновик.pdf', fileName: 'Черновик.pdf', sha256: tracked.sha256 || 'a'.repeat(64) }] });
    check('переименование: связь держится, путь обновлён', renamed.status === 200 && renamed.body.links[0].fileName === 'Черновик.pdf');
    const listed = (await send('GET', '/api/docflow/links?projectId=p-a')).body;
    const mism = listed.links.find((l: any) => l.id === tracked.id);
    check('новое имя не сходится — строка видит расхождение', mism.mismatch?.length > 0 && !listed.links.find((l: any) => l.itemId === 'i3').mismatch, mism);
    check('краткие сведения о строках идут вместе со связями', listed.items.i2.cipher === '3700-B01-E02-002' && listed.items.i2.vdrCode === 'E02');
    const back = await send('POST', '/api/docflow/links/track', { updates: [{ itemId: 'i2', linkId: tracked.id, relativePath: 'E02/3700-B01-E02-002_B.pdf', fileName: '3700-B01-E02-002_B.pdf' }] });
    check('возврат имени снимает расхождение', back.status === 200 && !(await send('GET', '/api/docflow/links?projectId=p-a')).body.links.find((l: any) => l.id === tracked.id).mismatch);
    const onTaken = await send('POST', '/api/docflow/links/track', { updates: [{ itemId: 'i2', linkId: tracked.id, relativePath: 'E02/3700-B01-E02-001_C.pdf', fileName: '3700-B01-E02-001_C.pdf' }] });
    check('перенос на место чужого файла — 409', onTaken.status === 409);
    const lost = await send('POST', '/api/docflow/links/track', { updates: [{ itemId: 'i2', linkId: tracked.id, lost: true }] });
    check('пропажа помечается, связь остаётся', lost.body.links[0].lostAt && !lost.body.links[0].unlinkedAt);
    const found = await send('POST', '/api/docflow/links/track', { updates: [{ itemId: 'i2', linkId: tracked.id, sha256: 'b'.repeat(64), size: 77 }] });
    check('найденный файл снимает пометку и обновляет отпечаток', !found.body.links[0].lostAt && found.body.links[0].sha256 === 'b'.repeat(64) && found.body.links[0].size === 77);
    await prisma.projectMember.create({ data: { projectId: 'p-a', userId: 'someone' } }); // проект закрыт для остальных
    actor = { id: 'eng', role: 'USER' };
    const hidden = await send('POST', '/api/docflow/links/track', { updates: [{ itemId: 'i2', linkId: tracked.id, lost: true }] });
    check('пачка слежения проверяет доступ к проекту строки', hidden.status === 403, hidden);
    actor = { id: 'admin', role: 'ADMIN' };
    console.log(`docflow-links: ${passed} проверок прошли`);
  } finally {
    server.close();
    await prisma.$disconnect();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
