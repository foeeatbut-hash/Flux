/** HTTP regression for first XML import: source binding is created after a successful import. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import express from 'express';
import { bootstrapLocalDatabase } from '../server/databaseBootstrap.js';
import { setBroadcaster, setPrisma } from '../server/context.js';
import { registerEquipmentSourceImportRoutes } from '../server/routes/equipmentSourceImport.js';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('../prisma-clients/client-sqlite');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-equipment-source-import-'));
const dbPath = path.join(root, 'fixture.sqlite');
const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${dbPath}` }) });
let checks = 0;
const check = (label: string, value: unknown) => { assert.ok(value, label); checks++; console.log(`✓ ${label}`); };

const makeBody = (tagIdentifier: string, fileName: string, malformed = false, value = '1200', title = 'Вентилятор') => {
  const xml = malformed ? `<root><system name="${tagIdentifier}">` :
    `<root><system name="${tagIdentifier}" title="${tagIdentifier}"><group title="Основные"><param name="Расход установки" unit="м³/ч">1200</param></group><monoblock name="M1"><block name="B1" title="${title}"><param name="Расход" unit="м³/ч">${value}</param></block></monoblock></system></root>`;
  const bytes = Buffer.from(xml, 'utf8');
  return { projectId: 'source-import-project', category: 'AHU', tagIdentifier, fileName,
    revision: 'A', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), base64: bytes.toString('base64') };
};

async function main() {
  let server: any;
  const broadcasts: Array<{ event: string; payload: any }> = [];
  try {
    const schema = fs.readFileSync(path.join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    await bootstrapLocalDatabase(dbPath, prisma, schema, () => {});
    setPrisma(prisma);
    setBroadcaster((event, payload) => broadcasts.push({ event, payload }));
    await prisma.project.create({ data: { id: 'source-import-project', name: 'Source import fixture' } });

    const app = express(); app.use(express.json({ limit: '24mb' }));
    app.use((req, _res, next) => { (req as any).authUser = { id: 'source-import-user', role: 'ADMIN', isActive: true }; next(); });
    registerEquipmentSourceImportRoutes(app);
    server = await new Promise<any>(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const post = (endpoint: string, body: unknown) => fetch(`${origin}/api/equipment/source-import/${endpoint}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const count = async (model: any) => model.count();

    const a = makeBody('3700-A01-HU-001', '3700-A01-HU-001-source-a.xml');
    const b = makeBody('4800-Z99-FN-777', '4800-Z99-FN-777-source-b.xml');
    const beforePreview = { systems: await count(prisma.equipmentSystem), tags: await count(prisma.tag), sources: await count(prisma.equipmentXmlSource) };
    const preview = await post('preview', a);
    assert.equal(preview.status, 200, (await preview.clone().text()).slice(0, 300));
    const previewBody = await preview.json();
    check('preview detects the selected root tag and plans its creation', previewBody.unitTag.identifier === a.tagIdentifier && previewBody.unitTag.action === 'create');
    check('preview writes no equipment, tags or sources', beforePreview.systems === await count(prisma.equipmentSystem)
      && beforePreview.tags === await count(prisma.tag) && beforePreview.sources === await count(prisma.equipmentXmlSource));

    const mismatch = await post('preview', { ...a, fileName: '3700-A01-HU-009-different.xml' });
    assert.equal(mismatch.status, 400); checks++; console.log('✓ filename/tag mismatch is rejected');
    const damaged = await post('preview', makeBody('3700-A01-HU-009', '3700-A01-HU-009-damaged.xml', true));
    assert.equal(damaged.status, 400); checks++; console.log('✓ damaged XML is rejected');
    assert.equal((await post('apply', { ...a, fileName: '3700-A01-HU-009-different.xml' })).status, 400); checks++; console.log('✓ apply rejects filename/tag mismatch');
    assert.equal((await post('apply', makeBody('3700-A01-HU-009', '3700-A01-HU-009-damaged.xml', true))).status, 400); checks++; console.log('✓ apply rejects damaged XML');
    check('failed previews leave equipment, tags and bindings untouched', beforePreview.systems === await count(prisma.equipmentSystem)
      && beforePreview.tags === await count(prisma.tag) && beforePreview.sources === await count(prisma.equipmentXmlSource));

    const appliedA = await post('apply', { ...a, previewToken: previewBody.previewToken });
    assert.equal(appliedA.status, 200, (await appliedA.clone().text()).slice(0, 500));
    const aBody = await appliedA.json();
    check('first import returns stable linked source, tag, system and root IDs', !!aBody.source.sourceId && !!aBody.source.tagId && !!aBody.source.systemId && !!aBody.source.elementId);
    const aSource = await prisma.equipmentXmlSource.findUnique({ where: { id: aBody.source.sourceId } });
    check('source baseline stores the original XML digest and revision', aSource?.lastImportedSha256 === a.sha256 && aSource?.lastImportedRevision === a.revision);

    const aSystem = await prisma.equipmentSystem.findUnique({ where: { id: aBody.source.systemId } });
    const aMono = await prisma.monoblock.findFirst({ where: { systemId: aSystem?.id, name: 'M1' } });
    const fan = await prisma.componentElement.findFirst({ where: { monoblockId: aMono?.id, itemCode: 'B1' } });
    assert.ok(fan);
    await prisma.componentElement.update({ where: { id: fan.id }, data: { overrides: JSON.stringify({ 'Основные||Расход': 'ручное значение' }) } });
    const missingManual = await prisma.componentElement.create({ data: { monoblockId: aMono!.id, itemCode: 'EXTRA', name: 'Ручная позиция', equipType: 'ПРОЧЕЕ', specs: JSON.stringify({ groups: [] }), manual: false } });

    const nextRevision = makeBody(a.tagIdentifier, a.fileName, false, '1300');
    const previewNext = await post('preview', nextRevision);
    assert.equal(previewNext.status, 200, (await previewNext.clone().text()).slice(0, 400));
    const nextPlan = await previewNext.json();
    const missingPlanRow = nextPlan.plan.missing.find((row: any) => row.id === missingManual.id);
    check('missing equipment is shown but defaults to keep', !!missingPlanRow && missingPlanRow.remove === false);
    const staleHistory = await count(prisma.equipmentHistory);
    await prisma.componentElement.update({ where: { id: fan.id }, data: { overrides: JSON.stringify({ 'Основные||Расход': 'изменилось после плана' }) } });
    const staleApply = await post('apply', { ...nextRevision, previewToken: nextPlan.previewToken });
    assert.equal(staleApply.status, 409); checks++; console.log('✓ stale preview is rejected after an override changes');
    check('stale preview rejection writes no history', staleHistory === await count(prisma.equipmentHistory));
    await prisma.componentElement.update({ where: { id: fan.id }, data: { overrides: JSON.stringify({ 'Основные||Расход': 'ручное значение' }) } });
    const freshNextPreview = await post('preview', nextRevision);
    assert.equal(freshNextPreview.status, 200, (await freshNextPreview.clone().text()).slice(0, 400));
    const freshNextPlan = await freshNextPreview.json();
    const raceHistory = await count(prisma.equipmentHistory);
    const realRaceTransaction = prisma.$transaction.bind(prisma);
    let raced = false;
    (prisma as any).$transaction = async (work: any, options: any) => {
      if (!raced) {
        raced = true;
        await prisma.componentElement.update({ where: { id: fan.id }, data: { overrides: JSON.stringify({ 'Основные||Расход': 'изменилось перед транзакцией' }) } });
      }
      return realRaceTransaction(work, options);
    };
    const raceResponse = await post('apply', { ...nextRevision, previewToken: freshNextPlan.previewToken });
    (prisma as any).$transaction = realRaceTransaction;
    assert.equal(raceResponse.status, 409); checks++; console.log('✓ transaction-level fingerprint catches a change after outer preflight');
    check('transaction-level stale rejection leaves history untouched', raceHistory === await count(prisma.equipmentHistory));
    await prisma.componentElement.update({ where: { id: fan.id }, data: { overrides: JSON.stringify({ 'Основные||Расход': 'ручное значение' }) } });
    const finalNextPreview = await post('preview', nextRevision);
    assert.equal(finalNextPreview.status, 200, (await finalNextPreview.clone().text()).slice(0, 400));
    const finalNextPlan = await finalNextPreview.json();
    const appliedNext = await post('apply', { ...nextRevision, previewToken: finalNextPlan.previewToken });
    assert.equal(appliedNext.status, 200, (await appliedNext.clone().text()).slice(0, 500));
    const nextBody = await appliedNext.json();
    const afterFan = await prisma.componentElement.findUnique({ where: { id: fan.id } });
    const afterMissing = await prisma.componentElement.findUnique({ where: { id: missingManual.id } });
    check('new source revision reuses the original stable binding ID', nextBody.source.sourceId === aBody.source.sourceId && nextBody.source.sha256 === nextRevision.sha256);
    check('unresolved wait conflicts do not advance the imported source baseline',
      nextBody.baselineApplied === false && (await prisma.equipmentXmlSource.findUnique({ where: { id: aBody.source.sourceId } }))?.lastImportedSha256 === a.sha256);
    check('manual override and absent position are preserved by the default wait/keep policy',
      afterFan?.overrides === JSON.stringify({ 'Основные||Расход': 'ручное значение' }) && afterMissing?.status === 'OK');

    const previewRemoval = await post('preview', nextRevision);
    assert.equal(previewRemoval.status, 200, (await previewRemoval.clone().text()).slice(0, 400));
    const removalPlan = await previewRemoval.json();
    const explicitRemoval = await post('apply', { ...nextRevision, previewToken: removalPlan.previewToken, choices: { [missingPlanRow.key]: 'remove' } });
    assert.equal(explicitRemoval.status, 200, (await explicitRemoval.clone().text()).slice(0, 500));
    check('an explicit missing-position choice is honored even for the current source digest',
      (await prisma.componentElement.findUnique({ where: { id: missingManual.id } }))?.status === 'REMOVED');

    const ambiguous = makeBody(a.tagIdentifier, a.fileName, false, '9000', 'Нагреватель');
    const historyBeforeAmbiguous = await count(prisma.equipmentHistory);
    const previewAmbiguous = await post('preview', ambiguous);
    assert.equal(previewAmbiguous.status, 200, (await previewAmbiguous.clone().text()).slice(0, 400));
    const ambiguousPlan = await previewAmbiguous.json();
    const ambiguousResponse = await post('apply', { ...ambiguous, previewToken: ambiguousPlan.previewToken });
    assert.equal(ambiguousResponse.status, 409, (await ambiguousResponse.clone().text()).slice(0, 400));
    checks++; console.log('✓ unresolved equipment match cannot be applied');
    check('unresolved match leaves history untouched', historyBeforeAmbiguous === await count(prisma.equipmentHistory));

    // Simulate a durable source update failing after equipment writes inside the
    // same transaction; rollback must happen before any socket notification.
    broadcasts.length = 0;
    const failedRevision = makeBody(a.tagIdentifier, a.fileName, false, '1400');
    const previewFailed = await post('preview', failedRevision);
    assert.equal(previewFailed.status, 200, (await previewFailed.clone().text()).slice(0, 400));
    const failedPlan = await previewFailed.json();
    const historyBeforeRollback = await count(prisma.equipmentHistory);
    const sourceBeforeRollback = await prisma.equipmentXmlSource.findUnique({ where: { id: aBody.source.sourceId } });
    const realTransaction = prisma.$transaction.bind(prisma);
    (prisma as any).$transaction = (work: any, options: any) => realTransaction((tx: any) => work(new Proxy(tx, {
      get(target, property) {
        if (property === 'equipmentXmlSource') return new Proxy(target.equipmentXmlSource, {
          get(delegate, method) {
            if (method === 'update') return async () => { throw new Error('fixture durable binding failure'); };
            const value = Reflect.get(delegate, method, delegate);
            return typeof value === 'function' ? value.bind(delegate) : value;
          },
        });
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    })), options);
    const rollback = await post('apply', { ...failedRevision, previewToken: failedPlan.previewToken });
    (prisma as any).$transaction = realTransaction;
    assert.equal(rollback.status, 500);
    check('transaction rollback emits no entity-changed notifications', broadcasts.length === 0);
    check('transaction rollback preserves binding baseline and equipment history', historyBeforeRollback === await count(prisma.equipmentHistory)
      && (await prisma.equipmentXmlSource.findUnique({ where: { id: aBody.source.sourceId } }))?.lastImportedSha256 === sourceBeforeRollback?.lastImportedSha256);

    const historyCount = await count(prisma.equipmentHistory);
    const versionBeforeDuplicate = (await prisma.componentElement.findUnique({ where: { id: aBody.source.elementId } }))?.version;
    const previewDuplicate = await post('preview', a);
    assert.equal(previewDuplicate.status, 200, (await previewDuplicate.clone().text()).slice(0, 400));
    const duplicatePlan = await previewDuplicate.json();
    const duplicate = await post('apply', { ...a, previewToken: duplicatePlan.previewToken });
    assert.equal(duplicate.status, 200, (await duplicate.clone().text()).slice(0, 300));
    check('duplicate exact source is idempotent', (await duplicate.json()).duplicate === true);
    check('duplicate import creates no history or root version bump', historyCount === await count(prisma.equipmentHistory)
      && versionBeforeDuplicate === (await prisma.componentElement.findUnique({ where: { id: aBody.source.elementId } }))?.version);

    const previewB = await post('preview', b);
    assert.equal(previewB.status, 200, (await previewB.clone().text()).slice(0, 300));
    const bPlan = await previewB.json();
    const bChoices = Object.fromEntries([...(bPlan.plan.matches || []), ...(bPlan.plan.systemRows || [])]
      .map((row: any) => [row.key, row.default || row.options?.[0]?.value]));
    const appliedB = await post('apply', { ...b, choices: bChoices, previewToken: bPlan.previewToken });
    assert.equal(appliedB.status, 200, (await appliedB.clone().text()).slice(0, 500));
    const bBody = await appliedB.json();
    check('second source in a different folder resolves its own IDs', !!bBody.source.sourceId && bBody.source.sourceId !== aBody.source.sourceId
      && bBody.source.tagId !== aBody.source.tagId && bBody.source.systemId !== aBody.source.systemId);
    check('both source IDs remain bound to their exact project tags',
      (await prisma.equipmentXmlSource.count({ where: { projectId: 'source-import-project', deletedAt: null } })) === 2
      && (await prisma.equipmentXmlSource.findUnique({ where: { id: bBody.source.sourceId } }))?.tagIdentifier === b.tagIdentifier);
    console.log(`Equipment source import HTTP checks: ${checks} passed.`);
  } finally {
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    setPrisma(null); setBroadcaster(() => undefined);
    await prisma.$disconnect();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(err => { console.error(err); process.exitCode = 1; });
