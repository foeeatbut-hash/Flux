/**
 * Выпуск ревизий и возвраты на сервере (docs/docflow-program.md, 7.1 и 7.3):
 * проверки окна повторяются на сервере, пачка пишется одной транзакцией,
 * повтор не плодит ревизий, второй одновременный выпуск получает 409, отмена,
 * возврат к выданной ревизии с кодом, статусом и сроком в часовом поясе
 * пользователя. Настоящая SQLite-база и настоящий express.
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
import { registerDocflowIssueRoutes } from '../server/routes/docflowIssue.js';
import { registerProjectFolderBindingRoutes } from '../server/routes/projectFolderBindings.js';
import { vdrPermissionFor } from '../server/vdrPermissions.js';
import { bootstrapLocalDatabase } from '../server/databaseBootstrap.js';
import { setPrisma, setBroadcaster } from '../server/context.js';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('../prisma-clients/client-sqlite');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-docflow-issue-'));
const dbPath = path.join(temp, 'fixture.sqlite');
const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${dbPath}` }) });
let passed = 0;
const check = (label: string, condition: unknown, detail?: unknown) => {
  assert.ok(condition, `${label}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
  passed++;
};
const key = (c: string) => c.repeat(64);
const WORK = key('a'); const RETURNS = key('b');
const sha = (c: string) => c.repeat(64);

async function main() {
  check('выпуск — отдельное право, а чтение состояния — просмотр', vdrPermissionFor('POST', '/api/docflow/issue/plan')?.perm === 'docflow.issue' && vdrPermissionFor('POST', '/api/docflow/issue/apply')?.perm === 'docflow.issue'
    && vdrPermissionFor('POST', '/api/docflow/issue/undo')?.perm === 'docflow.issue' && vdrPermissionFor('GET', '/api/docflow/issue/last')?.perm === 'docflow.view');

  const app = express();
  app.use(express.json());
  let actor: any = { id: 'admin', role: 'ADMIN' };
  app.use((req, _res, next) => { (req as any).authUser = actor; next(); });
  registerVdrRoutes(app as any, { chunkBytes: async () => 1024 });
  registerDocflowRoutes(app as any);
  registerDocflowLinkRoutes(app as any);
  registerDocflowIssueRoutes(app as any);
  registerProjectFolderBindingRoutes(app as any, { mayManage: async () => true });
  const server = createServer(app);
  try {
    const schema = fs.readFileSync(path.join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    await bootstrapLocalDatabase(dbPath, prisma, schema, () => {});
    setPrisma(prisma);
    setBroadcaster(() => {});
    await prisma.project.create({ data: { id: 'p-a', name: 'A' } });
    await prisma.project.create({ data: { id: 'p-b', name: 'B' } });
    await prisma.docRegister.create({ data: { id: 'reg-a', projectId: 'p-a', name: 'ВДР', poNumber: '3700' } });
    await prisma.docRegister.create({ data: { id: 'reg-b', projectId: 'p-b', name: 'ВДР', poNumber: '3700' } });
    const mk = (id: string, no: string, extra: any = {}) => prisma.docRegisterItem.create({ data: { id, registerId: 'reg-a', projectId: 'p-a', contractorNo: no, vdrCode: 'E02', revision: 'A', status: 'READY', titleRu: id, ...extra } });
    await mk('i1', '3700-B01-E02-001'); await mk('i2', '3700-B01-E02-002'); await mk('i3', '3700-B01-E02-003', { status: 'DRAFT' });
    await mk('i4', '3700-B01-E02-004'); await mk('i5', '3700-B01-E02-005');
    await prisma.docRegisterItem.create({ data: { id: 'x1', registerId: 'reg-b', projectId: 'p-b', contractorNo: '3700-B01-E02-001', vdrCode: 'E02', revision: 'A', status: 'READY' } });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as any;
    const base = `http://127.0.0.1:${address.port}`;
    const send = async (method: string, url: string, body?: any) => {
      const r = await fetch(`${base}${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, body: await r.json().catch(() => ({})) as any };
    };
    const settings = (await send('GET', '/api/docflow/settings?projectId=p-a')).body;
    check('настройки сохранены', (await send('PUT', '/api/docflow/settings', { projectId: 'p-a', config: { ...settings.config, vdrTypes: [{ code: 'E02', titleRu: 'Общий вид', titleEn: '' }] }, expectedUpdatedAt: null })).status === 200);
    const ledger = async () => (await send('GET', '/api/explorer/project-bindings')).body;
    const upsert = async (binding: any) => send('POST', '/api/explorer/project-bindings', { expectedRevision: (await ledger()).revision, operation: { kind: 'upsert', binding } });
    const locator = (k: string) => ({ folderKey: k, anchors: [{ key: k, relativePath: '' }] });
    await upsert({ locationKey: WORK, projectId: 'p-a', label: 'Рабочая', purpose: 'work', locator: locator(WORK) });
    await upsert({ locationKey: RETURNS, projectId: 'p-a', label: 'Возвраты', purpose: 'returns' });
    const link = async (itemId: string, name: string, over: any = {}) =>
      (await send('POST', '/api/docflow/links', { itemId, role: 'file', folderKey: WORK, relativePath: `E02/${name}`, fileName: name, sha256: sha('1'), size: 10, ...over })).body.link;
    const l1 = await link('i1', '3700-B01-E02-001_A.pdf');
    const l2 = await link('i2', '3700-B01-E02-002_A.pdf');
    const l3 = await link('i3', '3700-B01-E02-003_A.pdf');
    const l4 = await link('i4', '3700-B01-E02-004_A.pdf');
    check('файлы связаны', !!(l1 && l2 && l3 && l4));
    const today = new Date().toISOString().slice(0, 10);
    const row = (itemId: string, linkId: string, over: any = {}) => ({ itemId, linkId, reason: 'IFR', date: today, sha256: sha('1'), ...over });
    const plan = (rows: any[], projectId = 'p-a') => send('POST', '/api/docflow/issue/plan', { projectId, rows });
    const apply = (planId: string, hashes: any, projectId = 'p-a') => send('POST', '/api/docflow/issue/apply', { projectId, planId, hashes });
    const count = () => prisma.docRegisterItemRevision.count({ where: { issuedKey: { not: null } } });

    // ── План не пишет; каждая проверка окна — и на сервере ──
    const bad = await plan([row('i3', l3.id), row('i1', l1.id, { reason: 'XXX' }), row('i2', l2.id, { date: '2026-02-31' }), row('i4', l4.id, { sha256: 'нет' })]);
    check('план возвращает построчные причины, не 500', bad.status === 200 && !bad.body.ok);
    const by = (id: string) => bad.body.rows.find((r: any) => r.itemId === id).problems.join(' | ');
    check('статус «В работе» не разрешает выпуск', /не разрешает выпуск/.test(by('i3')));
    check('причина вне настроек проекта', /причину выпуска/.test(by('i1')));
    check('несуществующая дата', /дату выпуска/.test(by('i2')));
    check('без отпечатка выпуска нет', /Отпечаток/.test(by('i4')));
    check('план ничего не записал и не тронул строки', await count() === 0 && (await prisma.docRegisterItem.findUnique({ where: { id: 'i1' } })).status === 'READY');
    const busy = await plan([row('i1', l1.id, { busy: true })]);
    check('файл, открытый на запись, блокирует выпуск', /открыт на запись/.test(busy.body.rows[0].problems.join()));
    const badApply = await apply(bad.body.id, { i3: sha('1'), i1: sha('1'), i2: sha('1'), i4: 'x' });
    check('план с проблемами не применяется', badApply.status >= 400 && await count() === 0, badApply.body);
    // имя не совпадает со строкой: файл i2 привязан по маске, но строку потом поменяли
    await prisma.docRegisterItem.update({ where: { id: 'i5' }, data: { contractorNo: '3700-B01-E02-005' } });
    const l5 = await link('i5', '3700-B01-E02-005_A.pdf');
    await prisma.docRegisterItem.update({ where: { id: 'i5' }, data: { contractorNo: '3700-B01-E02-099' } });
    const renamedRow = await plan([row('i5', l5.id)]);
    check('имя файла перестало совпадать со строкой', /не по маске или не совпадает/.test(renamedRow.body.rows[0].problems.join()));
    await prisma.docRegisterItem.update({ where: { id: 'i5' }, data: { contractorNo: '3700-B01-E02-005' } });
    await prisma.docFileLink.update({ where: { id: l4.id }, data: { lostAt: new Date() } });
    check('потерянный файл ревизии не выпускается', /не найден на месте/.test((await plan([row('i4', l4.id)])).body.rows[0].problems.join()));
    await prisma.docFileLink.update({ where: { id: l4.id }, data: { lostAt: null } });

    // ── Ссылки: чужой проект, чужая связь ──
    check('строка другого проекта — 403', (await plan([row('x1', l1.id)])).status === 403);
    check('чужая связь строки — 403', (await plan([row('i1', l2.id)])).status === 403);
    check('проект не тот, что у строки — 403', (await plan([row('i1', l1.id)], 'p-b')).status === 403);
    check('неизвестный проект — 404, пустая пачка и больше 100 — 400', (await plan([row('i1', l1.id)], 'нет')).status === 404 && (await send('POST', '/api/docflow/issue/plan', { projectId: 'p-a', rows: [] })).status === 400
      && (await send('POST', '/api/docflow/issue/plan', { projectId: 'p-a', rows: Array.from({ length: 101 }, (_, i) => row(`s${i}`, `l${i}`)) })).status === 400);
    check('одна строка дважды — 400', (await plan([row('i1', l1.id), row('i1', l1.id)])).status === 400);

    // ── Пачка одной транзакцией: падение на второй строке откатывает первую ──
    const pair = await plan([row('i1', l1.id), row('i2', l2.id)]);
    check('чистый план готов к выпуску', pair.body.ok === true, pair.body.rows.map((r: any) => r.problems));
    const hashes = { i1: sha('1'), i2: sha('1') };
    const mismatch = await apply(pair.body.id, { ...hashes, i2: sha('2') });
    check('отпечаток при подтверждении отличается от предпросмотра — 409, ничего не записано', mismatch.status === 409 && await count() === 0 && (await prisma.docRegisterItem.findUnique({ where: { id: 'i1' } })).status === 'READY', mismatch.body);
    await prisma.docRegisterItemRevision.create({ data: { itemId: 'i2', revision: 'A', reason: 'IFR', issuedKey: 'foreign-key-probe' } });
    const rolled = await apply(pair.body.id, hashes);
    check('проигрыш по второй строке откатывает всю пачку', rolled.status === 409 && (await prisma.docRegisterItem.findUnique({ where: { id: 'i1' } })).status === 'READY'
      && await prisma.docRegisterItemRevision.count({ where: { itemId: 'i1' } }) === 0, rolled.body);
    await prisma.docRegisterItemRevision.delete({ where: { issuedKey: 'foreign-key-probe' } });

    // ── Запись, повтор и конкуренция ──
    const fresh = await plan([row('i1', l1.id), row('i2', l2.id)]);
    const rival = await plan([row('i1', l1.id), row('i2', l2.id)]);
    const [one, two] = await Promise.all([apply(fresh.body.id, hashes), apply(rival.body.id, hashes)]);
    check('два одновременных выпуска одних документов: 200 и 409', [one.status, two.status].sort().join() === '200,409', [one.body, two.body]);
    check('выпущено по одной ревизии на документ', await count() === 2);
    const winner = one.status === 200 ? fresh : rival; const win = one.status === 200 ? one : two;
    const again = await apply(winner.body.id, hashes);
    check('двойное нажатие возвращает прежний итог без новых ревизий', again.status === 200 && again.body.repeated === true && again.body.count === 2 && await count() === 2, again.body);
    const issued = await prisma.docRegisterItem.findUnique({ where: { id: 'i1' } });
    const record = await prisma.docRegisterItemRevision.findFirst({ where: { itemId: 'i1', issuedKey: { not: null } } });
    check('строка получила статус «Выдан», дату и причину; ревизия хранит отпечаток и файл', issued.status === 'ISSUED' && issued.reasonForIssue === 'IFR' && issued.issueDate.toISOString().slice(0, 10) === today
      && record.sha256 === sha('1') && record.linkId === l1.id && record.revision === 'A' && record.authorId === 'admin');
    check('повторный выпуск той же ревизии отклоняется планом', /не разрешает выпуск|уже выпущена/.test((await plan([row('i1', l1.id)])).body.rows[0].problems.join()));
    const listed = (await send('GET', '/api/docflow/links?projectId=p-a')).body;
    check('Реестр получает выпущенные ревизии без признака правки', listed.issues.length === 2 && listed.issues.every((i: any) => i.changed === false && i.date === today));
    await prisma.docFileLink.update({ where: { id: l1.id }, data: { sha256: sha('9') } });
    const changed = (await send('GET', '/api/docflow/links?projectId=p-a')).body.issues.find((i: any) => i.itemId === 'i1');
    check('правка файла после выпуска помечается; отпечаток выпуска не меняется', changed.changed === true && changed.sha256 === sha('1')
      && (await prisma.docRegisterItemRevision.findUnique({ where: { id: record.id } })).sha256 === sha('1'));
    await prisma.docFileLink.update({ where: { id: l1.id }, data: { sha256: sha('1') } });

    // ── Следующая ревизия по схеме ──
    check('выпущенный файл не заменяется и не отвязывается', (await send('POST', '/api/docflow/links/unlink', { itemId: 'i1', linkId: l1.id })).status === 409
      && (await send('POST', '/api/docflow/links', { itemId: 'i1', role: 'file', folderKey: WORK, relativePath: 'E02/Copy/3700-B01-E02-001_A.pdf', fileName: '3700-B01-E02-001_A.pdf', replace: true })).status === 409);
    const next = await send('POST', '/api/vdr/items/i1/issue-revision', { kind: 'next' });
    check('следующая рабочая ревизия открывается по схеме и не пишет историю', next.status === 200 && next.body.item.revision === 'B' && next.body.item.status === 'DRAFT'
      && await prisma.docRegisterItemRevision.count({ where: { itemId: 'i1' } }) === 1);
    await prisma.docRegisterItem.update({ where: { id: 'i1' }, data: { revision: 'C', status: 'READY' } });
    const l1c = await link('i1', '3700-B01-E02-001_C.pdf');
    check('пропуск ревизии отвергается', /следующей должна быть B/.test((await plan([row('i1', l1c.id)])).body.rows[0].problems.join()));

    // ── Возвраты ──
    const rem = (over: any = {}) => ({ itemId: 'i2', role: 'remarks', toLinkId: l2.id, folderKey: RETURNS, relativePath: 'E02/i2/A/Замечания.pdf', fileName: 'Замечания.pdf', reviewCode: '2', receivedAt: '2026-11-05', timeZone: 'Asia/Novosibirsk', sha256: sha('3'), ...over });
    check('возврат к невыпущенной ревизии — 422', (await send('POST', '/api/docflow/links', rem({ itemId: 'i4', toLinkId: l4.id }))).status === 422);
    check('нет даты или часового пояса — 400, неизвестный код — 400', (await send('POST', '/api/docflow/links', rem({ receivedAt: '' }))).status === 400
      && (await send('POST', '/api/docflow/links', rem({ timeZone: 'Нигде/Никак' }))).status === 400 && (await send('POST', '/api/docflow/links', rem({ reviewCode: 'ZZ' }))).status === 400);
    const r1 = await send('POST', '/api/docflow/links', rem());
    const afterReturn = await prisma.docRegisterItem.findUnique({ where: { id: 'i2' } });
    check('код 2 из настроек ставит «Замечания» и срок от даты получения в поясе пользователя', r1.status === 200 && afterReturn.status === 'REMARKS' && afterReturn.reviewCode === '2'
      && afterReturn.dueDate.toISOString() === '2026-11-15T16:59:59.000Z' && r1.body.link.receivedAt.startsWith('2026-11-05'), afterReturn);
    const r2 = await send('POST', '/api/docflow/links', rem({ relativePath: 'E02/i2/A/Письмо.pdf', fileName: 'Письмо.pdf', reviewCode: '1', receivedAt: '2026-11-01' }));
    check('старый по дате возврат, назначенный позже, статус и срок не откатывает', r2.status === 200 && (await prisma.docRegisterItem.findUnique({ where: { id: 'i2' } })).status === 'REMARKS');
    const r3 = await send('POST', '/api/docflow/links', rem({ relativePath: 'E02/i2/A/Принято.pdf', fileName: 'Принято.pdf', reviewCode: '1', receivedAt: '2026-11-06' }));
    const accepted = await prisma.docRegisterItem.findUnique({ where: { id: 'i2' } });
    check('несколько возвратов у ревизии, свежий код «принято» меняет статус и снимает срок', r3.status === 200 && accepted.status === 'ACCEPTED' && accepted.dueDate === null
      && (await send('GET', '/api/docflow/links?projectId=p-a')).body.links.filter((l: any) => l.role === 'remarks' && l.toLinkId === l2.id).length === 3);
    check('возврат с чужого проекта — отказ', (await send('POST', '/api/docflow/links', rem({ itemId: 'x1' }))).status >= 400);

    // ── Отмена выпуска ──
    const undoPlan = await plan([row('i4', l4.id)]);
    check('выпуск i4', (await apply(undoPlan.body.id, { i4: sha('1') })).status === 200);
    const last = await send('GET', '/api/docflow/issue/last?projectId=p-a');
    check('последний собственный выпуск виден после закрытия окна', last.body?.id === undoPlan.body.id && last.body.state === 'applied');
    check('отмена чужого плана — 403, выпуск с возвратом отменить нельзя', (await send('POST', '/api/docflow/issue/undo', { projectId: 'p-a', planId: winner.body.id })).status === 409);
    actor = { id: 'other', role: 'ADMIN' };
    check('чужой автор не видит и не отменяет план — 403', (await send('POST', '/api/docflow/issue/undo', { projectId: 'p-a', planId: undoPlan.body.id })).status === 403
      && (await send('GET', `/api/docflow/issue/state?projectId=p-a&planId=${undoPlan.body.id}`)).status === 403);
    actor = { id: 'admin', role: 'ADMIN' };
    // Возврат без кода рассмотрения строку не меняет, но выпуск всё равно уже использован
    const plainReturn = await send('POST', '/api/docflow/links', rem({ itemId: 'i4', toLinkId: l4.id, relativePath: 'E02/i4/A/Письмо.pdf', fileName: 'Письмо.pdf', reviewCode: '' }));
    check('возврат без кода принят и не трогает строку', plainReturn.status === 200 && (await prisma.docRegisterItem.findUnique({ where: { id: 'i4' } })).status === 'ISSUED');
    check('по выпуску есть возврат — отмена отказана, строка осталась выданной', (await send('POST', '/api/docflow/issue/undo', { projectId: 'p-a', planId: undoPlan.body.id })).status === 409
      && (await prisma.docRegisterItem.findUnique({ where: { id: 'i4' } })).status === 'ISSUED');
    await send('POST', '/api/docflow/links/unlink', { itemId: 'i4', linkId: plainReturn.body.link.id });
    const undone = await send('POST', '/api/docflow/issue/undo', { projectId: 'p-a', planId: undoPlan.body.id });
    const restored = await prisma.docRegisterItem.findUnique({ where: { id: 'i4' } });
    check('отмена возвращает строку и освобождает ревизию, история помечена', undone.status === 200 && restored.status === 'READY' && restored.issueDate === null
      && (await prisma.docRegisterItemRevision.findFirst({ where: { itemId: 'i4' } })).undoneAt !== null && (await prisma.docRegisterItemRevision.findFirst({ where: { itemId: 'i4' } })).issuedKey === null);
    check('повторная отмена безопасна, ревизию можно выпустить заново', (await send('POST', '/api/docflow/issue/undo', { projectId: 'p-a', planId: undoPlan.body.id })).status === 200
      && (await plan([row('i4', l4.id)])).body.ok === true);

    // ── Права: пользователь без docflow.issue ──
    await prisma.role.create({ data: { id: 'role-plain', code: 'PLAIN', name: 'Инженер', permissions: JSON.stringify({ 'docflow.issue': { enabled: false, until: null } }) } });
    await prisma.user.create({ data: { id: 'plain', symbol: 'plain', name: 'Без выпуска', password: 'x', role: 'PLAIN' } });
    await prisma.projectMember.create({ data: { projectId: 'p-a', userId: 'plain' } });
    actor = { id: 'plain', role: 'PLAIN' };
    check('без права выпуска план, подтверждение и отмена — 403', (await plan([row('i4', l4.id)])).status === 403
      && (await apply('x', {})).status === 403 && (await send('POST', '/api/docflow/issue/undo', { projectId: 'p-a', planId: 'x' })).status === 403);
    actor = { id: 'admin', role: 'ADMIN' };
    const before = await count();
    check('итог: проверки не оставили лишних ревизий', before === 2, before);
  } finally { await new Promise((r) => server.close(r)); await prisma.$disconnect(); fs.rmSync(temp, { recursive: true, force: true }); }
  console.log(`docflow-issue: ${passed} проверок прошли`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
