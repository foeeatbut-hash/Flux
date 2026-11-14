/**
 * Office: ключ номеров ревизий и гонки выпуска (docs/roadmap/offline-work.md, 0.2).
 *
 * Настоящая SQLite и настоящий express: гонку заглушкой не сыграть. Что держим:
 *  • ключ [documentId, revision, status] стоит в базе ровно один раз: его завела автомиграция,
 *    наша догоняющая миграция его не удваивает под другим именем;
 *  • два одновременных выпуска и два одновременных черновика одного файла — один 201,
 *    остальные отказ; двух строк с одним ключом в базе нет;
 *  • черновики разных файлов одного документа считают номер внутри транзакции — не совпадают;
 *  • проигравший за номер получает 409 с кодом OFFICE_REVISION_CONFLICT и текущей ревизией,
 *    а не 400/500, и черновик откатывается целиком (нет файла-сироты);
 *  • база с повторами: ключ не создаётся, старт не падает, строки не тронуты, отчёт видит группы.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import express from 'express';
import { registerOfficeRevisionRoutes } from '../server/routes/officeRevisions.js';
import { bootstrapLocalDatabase } from '../server/databaseBootstrap.js';
import { setPrisma, setBroadcaster } from '../server/context.js';
import { ensureOfficeRevisionKey, findOfficeRevisionDuplicates, officeSha256, reportOfficeRevisionDuplicates } from '../server/officeRevisions.js';
import { resetSchemaPreparations } from '../server/schemaRuntime.js';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('../prisma-clients/client-sqlite');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-office-revision-key-'));
const dbPath = path.join(temp, 'fixture.sqlite');
const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${dbPath}` }) });
const check = (label: string, condition: unknown, detail?: unknown) => {
  assert.ok(condition, `${label}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
  console.log(`✓ ${label}`);
};
const KEY = 'OfficeDocumentRevision_documentId_revision_status_key';
const bytes = Buffer.from('office revision fixture');
const sha = officeSha256(bytes);

/** Уникальные индексы таблицы ревизий на этих трёх колонках — по любому имени */
const keyIndexes = async (): Promise<string[]> => {
  const out: string[] = [];
  const list: any[] = await prisma.$queryRawUnsafe(`PRAGMA index_list("OfficeDocumentRevision")`);
  for (const row of list.filter((r) => Number(r.unique))) {
    const cols: any[] = await prisma.$queryRawUnsafe(`PRAGMA index_info("${row.name}")`);
    if ([...cols.map((c) => c.name)].sort().join(',') === 'documentId,revision,status') out.push(String(row.name));
  }
  return out;
};
const dupGroups = async () => (await prisma.$queryRawUnsafe(
  `SELECT documentId, revision, status, COUNT(*) AS n FROM "OfficeDocumentRevision" GROUP BY documentId, revision, status HAVING COUNT(*) > 1`)) as any[];

async function main() {
  const schema = fs.readFileSync(path.join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
  const bootLog: string[] = [];
  await bootstrapLocalDatabase(dbPath, prisma, schema, (m) => bootLog.push(m));
  await prisma.user.create({ data: { id: 'u-office', symbol: 'office', password: 'x', name: 'Office Tester', role: 'ADMIN' } });
  await prisma.project.create({ data: { id: 'office-project', name: 'Office test' } });

  // Подмена клиента: «устаревшее чтение внутри транзакции» — то, что на PostgreSQL и MariaDB
  // делает соседняя ещё не завершённая транзакция. На SQLite транзакции идут по очереди.
  let staleMax: number | null = null;
  const staleTx = (tx: any) => new Proxy(tx, { get: (target, prop) => {
    const model = target[prop];
    if (prop !== 'officeDocumentRevision' || staleMax === null) return model;
    return new Proxy(model, { get: (m, name) => name === 'findFirst'
      ? (args: any) => (args?.select?.revision && args?.orderBy?.revision === 'desc' ? Promise.resolve({ revision: staleMax }) : m.findFirst(args))
      : m[name].bind(m) });
  } });
  // Затвор: пока в транзакцию не дошли все n запросов, ни один её не начинает. Без него на SQLite
  // запросы идут почти по очереди, и настоящей гонки (общее чтение до чужой записи) не получается.
  let gate: { need: number; waiting: Array<() => void> } | null = null;
  const passGate = () => new Promise<void>((resolve) => {
    if (!gate) return resolve();
    const g = gate;
    g.waiting.push(resolve);
    if (g.waiting.length >= g.need) g.waiting.splice(0).forEach((release) => release());
    else setTimeout(resolve, 3000); // запрос, ушедший без транзакции, не должен вешать набор
  });
  const race = async <T>(calls: Array<() => Promise<T>>): Promise<T[]> => {
    gate = { need: calls.length, waiting: [] };
    try { return await Promise.all(calls.map((call) => call())); } finally { gate = null; }
  };
  const client: any = new Proxy(prisma, { get: (target, prop) => prop === '$transaction'
    ? async (fn: any, options: any) => { await passGate(); return target.$transaction((tx: any) => fn(staleTx(tx)), options); }
    : typeof target[prop] === 'function' ? target[prop].bind(target) : target[prop] });
  setPrisma(client);
  setBroadcaster(() => {});

  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.authUser = { id: 'u-office', role: 'ADMIN' }; next(); });
  registerOfficeRevisionRoutes(app as any, { chunkBytes: async () => 1024, holderOf: async () => null });
  const server = createServer(app);
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    const send = async (method: string, url: string, body?: any) => {
      const r = await fetch(`${base}${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, body: await r.json().catch(() => ({})) as any };
    };
    let seq = 0;
    const newFile = async () => {
      const name = `doc-${++seq}.docx`;
      const file = await prisma.fileNode.create({ data: { name, filePath: `/personal/${name}`, size: bytes.length, type: 'FILE', scope: 'PERSONAL', ownerId: 'u-office', createdById: 'u-office' } });
      await prisma.fileChunk.create({ data: { fileId: file.id, idx: 0, data: bytes } });
      return file.id as string;
    };
    const issue = (fileId: string) => send('POST', `/api/office/revisions/${fileId}/issue`, { sourceSha: sha });
    const draft = (fileId: string, revisionId: string) => send('POST', `/api/office/revisions/${fileId}/draft`, { revisionId, sourceSha: sha });
    const rows = (documentId: string) => prisma.officeDocumentRevision.findMany({ where: { documentId }, select: { revision: true, status: true, fileId: true, id: true }, orderBy: [{ revision: 'asc' }, { status: 'asc' }] });

    // ── Ключ в базе ──
    check('автомиграция завела ключ [documentId, revision, status]', (await keyIndexes()).includes(KEY), await keyIndexes());
    resetSchemaPreparations();
    const first = await send('GET', `/api/office/revisions/${await newFile()}`);
    check('первый заход в ревизии (догоняющая миграция) отвечает 200', first.status === 200, first.body);
    check('ключ в базе один: догоняющая миграция не завела второй под другим именем', (await keyIndexes()).length === 1, await keyIndexes());
    await assert.rejects(
      () => prisma.officeDocumentRevision.createMany({ data: ['a', 'b'].map((id) => ({ id: `dup-${id}`, documentId: 'dup-doc', fileId: `f-${id}`, revision: 1, status: 'DRAFT', sha256: 's', sourceSha: 's', data: bytes })) }),
      (error: any) => error?.code === 'P2002' || /unique/i.test(String(error?.message)));
    check('база сама не пускает две строки с одним [документ, номер, статус]', (await prisma.officeDocumentRevision.count({ where: { documentId: 'dup-doc' } })) === 0);

    // ── Обычный путь одного пользователя ──
    const f1 = await newFile();
    const r1 = await issue(f1);
    check('выпуск: 201, ревизия 1', r1.status === 201 && r1.body.revision.revision === 1 && r1.body.revision.documentId === f1, r1.body);
    const again = await issue(f1);
    check('повторный выпуск неизменного документа — прежняя ревизия, без новой записи', again.status === 200 && again.body.unchanged === true && (await rows(f1)).length === 1, again.body);
    const d2 = await draft(f1, r1.body.revision.id);
    check('черновик: 201, номер 2, статус DRAFT', d2.status === 201 && d2.body.revision.revision === 2 && d2.body.revision.status === 'DRAFT', d2.body);
    const r2 = await issue(d2.body.fileId);
    check('выпуск черновика берёт его номер 2 (ISSUED рядом с DRAFT того же номера — штатно)', r2.status === 201 && r2.body.revision.revision === 2 && r2.body.revision.documentId === f1, r2.body);
    check('в журнале документа: R1 ISSUED, R2 DRAFT, R2 ISSUED', (await rows(f1)).map((r: any) => `${r.revision}${r.status[0]}`).join() === '1I,2D,2I', await rows(f1));

    // ── Гонка одного файла: расчёт захвата документа ──
    for (let round = 1; round <= 4; round++) {
      const file = await newFile();
      const results = await race([() => issue(file), () => issue(file), () => issue(file)]);
      const created = results.filter((r) => r.status === 201);
      check(`выпуск, гонка ${round}: ровно один 201, остальные 409`, created.length === 1 && results.filter((r) => r.status === 409).length === 2, results.map((r) => [r.status, r.body.error]));
      check(`выпуск, гонка ${round}: в базе одна строка, повторов нет`, (await rows(file)).length === 1 && (await dupGroups()).length === 0);
    }
    for (let round = 1; round <= 4; round++) {
      const file = await newFile();
      const issued = await issue(file);
      const filesBefore = await prisma.fileNode.count();
      const results = await race([() => draft(file, issued.body.revision.id), () => draft(file, issued.body.revision.id), () => draft(file, issued.body.revision.id)]);
      const created = results.filter((r) => r.status === 201);
      check(`черновик, гонка ${round}: ровно один 201, остальные 409`, created.length === 1 && results.filter((r) => r.status === 409).length === 2, results.map((r) => [r.status, r.body.error]));
      check(`черновик, гонка ${round}: один черновик в базе и один новый файл`, (await rows(file)).filter((r: any) => r.status === 'DRAFT').length === 1
        && (await prisma.fileNode.count()) === filesBefore + 1);
    }

    // ── Гонка черновиков РАЗНЫХ файлов одного документа: номер считается внутри транзакции ──
    for (let round = 1; round <= 4; round++) {
      const file = await newFile();
      const issued1 = await issue(file);
      const d = await draft(file, issued1.body.revision.id);
      const issued2 = await issue(d.body.fileId);
      assert.equal(issued2.status, 201);
      // R1 лежит в файле-оригинале, R2 — в файле-черновике: захваты у них разные, а номер общий
      const results = await race([() => draft(file, issued1.body.revision.id), () => draft(d.body.fileId, issued2.body.revision.id)]);
      const numbers = (await rows(file)).filter((r: any) => r.status === 'DRAFT').map((r: any) => r.revision).sort();
      check(`черновики разных файлов, гонка ${round}: оба 201, номера разные`, results.every((r) => r.status === 201) && numbers.length === 3 && new Set(numbers).size === 3, { st: results.map((r) => r.status), numbers });
      check(`черновики разных файлов, гонка ${round}: повторов нет`, (await dupGroups()).length === 0);
    }

    // ── Проигравший за номер: 409 с кодом и текущей ревизией, откат без сирот ──
    {
      const file = await newFile();
      const issued1 = await issue(file);
      const rival = await prisma.officeDocumentRevision.create({ data: { id: 'rival-draft', documentId: file, fileId: 'rival-file', parentRevisionId: issued1.body.revision.id, revision: 2, status: 'DRAFT', sha256: sha, sourceSha: sha, data: bytes } });
      staleMax = 1; // тихая гонка: чтение номера внутри транзакции не увидело соперника
      const filesBefore = await prisma.fileNode.count();
      const lost = await draft(file, issued1.body.revision.id);
      staleMax = null;
      check('проигравший черновик: 409', lost.status === 409, lost.body);
      check('код отказа — отдельное поле OFFICE_REVISION_CONFLICT, текущая ревизия 2 — в ответе', lost.body.code === 'OFFICE_REVISION_CONFLICT' && lost.body.currentRevision === 2 && /занят/.test(lost.body.error), lost.body);
      check('проигравший откатился целиком: ни файла-черновика, ни строки журнала', (await prisma.fileNode.count()) === filesBefore && (await rows(file)).length === 2, await rows(file));
      await prisma.officeDocumentRevision.delete({ where: { id: rival.id } });
    }
    {
      // Выпуск: соперник уже занял ISSUED с тем же номером, который держит черновик
      const file = await newFile();
      const issued1 = await issue(file);
      const d = await draft(file, issued1.body.revision.id);
      await prisma.officeDocumentRevision.create({ data: { id: 'rival-issued', documentId: file, fileId: 'rival-issued-file', revision: 2, status: 'ISSUED', sha256: sha, sourceSha: sha, data: bytes } });
      const lost = await issue(d.body.fileId);
      check('проигравший выпуск: 409 с кодом OFFICE_REVISION_CONFLICT и текущей ревизией', lost.status === 409 && lost.body.code === 'OFFICE_REVISION_CONFLICT' && lost.body.currentRevision === 2, lost.body);
      check('проигравший выпуск ничего не записал', (await rows(file)).filter((r: any) => r.status === 'ISSUED').length === 2);
      await prisma.officeDocumentRevision.delete({ where: { id: 'rival-issued' } });
    }

    // ── База с повторами: ключ не создаётся, старт не падает, строки целы ──
    await prisma.$executeRawUnsafe(`DROP INDEX "${KEY}"`);
    await prisma.$executeRawUnsafe(`CREATE INDEX "OfficeDocumentRevision_document_revision_idx" ON "OfficeDocumentRevision" ("documentId", "revision")`);
    for (const id of ['old-a', 'old-b']) {
      await prisma.officeDocumentRevision.create({ data: { id, documentId: 'old-doc', fileId: `old-${id}`, revision: 3, status: 'ISSUED', sha256: 's', sourceSha: 's', data: bytes } });
    }
    const before = JSON.stringify(await prisma.officeDocumentRevision.findMany({ select: { id: true, documentId: true, revision: true, status: true, fileId: true }, orderBy: { id: 'asc' } }));
    const log: string[] = [];
    resetSchemaPreparations();
    check('на базе с повторами миграция не падает и ключ не создаёт', (await ensureOfficeRevisionKey(prisma, (m) => log.push(m))) === false && (await keyIndexes()).length === 0, log);
    check('в журнал записана причина (повторы), данные не тронуты', log.some((m) => /повтор/i.test(m)) && JSON.stringify(await prisma.officeDocumentRevision.findMany({ select: { id: true, documentId: true, revision: true, status: true, fileId: true }, orderBy: { id: 'asc' } })) === before);
    const startLog: string[] = [];
    await bootstrapLocalDatabase(dbPath, prisma, schema, (m) => startLog.push(m));
    check('старт (автомиграция схемы) на базе с повторами не падает, ключ пропущен с записью в журнал', startLog.some((m) => m.includes(KEY)) && (await keyIndexes()).length === 0, startLog);
    const groups = await findOfficeRevisionDuplicates(prisma);
    check('отчёт о повторах: одна группа old-doc R3 ISSUED из двух строк', groups.length === 1 && groups[0].documentId === 'old-doc' && groups[0].revision === 3 && groups[0].status === 'ISSUED' && groups[0].rows === 2, groups);
    const reportLog: string[] = [];
    check('отчёт при старте пишет число групп', (await reportOfficeRevisionDuplicates(prisma, (m) => reportLog.push(m))) === 1 && /1 групп/.test(reportLog.join()), reportLog);
    check('отчёт и миграция ничего не удалили', (await prisma.officeDocumentRevision.count({ where: { documentId: 'old-doc' } })) === 2);

    // Человек разобрал повторы — следующий старт создаёт ключ один раз
    await prisma.officeDocumentRevision.delete({ where: { id: 'old-b' } });
    resetSchemaPreparations();
    check('после ручной чистки повторов ключ создаётся', (await ensureOfficeRevisionKey(prisma, () => {})) === true && (await keyIndexes()).length === 1);
    await ensureOfficeRevisionKey(prisma, () => {});
    await bootstrapLocalDatabase(dbPath, prisma, schema, () => {});
    check('повторные миграция и автомиграция не удваивают ключ', (await keyIndexes()).length === 1, await keyIndexes());
    const emptyLog: string[] = [];
    check('без повторов отчёт пишет «0 групп»', (await reportOfficeRevisionDuplicates(prisma, (m) => emptyLog.push(m))) === 0 && /0 групп/.test(emptyLog.join()), emptyLog);

    console.log('\nOffice: ключ номеров ревизий и гонки — все проверки пройдены');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await prisma.$disconnect().catch(() => {});
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
