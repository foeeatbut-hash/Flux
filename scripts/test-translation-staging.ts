import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimStagedOfficeTranslation, stageOfficeTranslation } from '../server/officeTranslationStaging.js';

const requireFromRepo = createRequire(join(process.cwd(), 'package.json'));
const Database = requireFromRepo('better-sqlite3');
const { PrismaClient } = requireFromRepo('@prisma/client-sqlite');
const { PrismaBetterSqlite3 } = requireFromRepo('@prisma/adapter-better-sqlite3');
const directory = mkdtempSync(join(tmpdir(), 'flux-translation-stage-'));
const databasePath = join(directory, 'shared.sqlite');
let clients: any[] = [];

function sqliteClients() {
  const sql = new Database(databasePath);
  sql.exec(`CREATE TABLE AppSetting (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL,
    userId TEXT,
    value TEXT NOT NULL,
    updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(key, userId)
  )`);
  sql.close();
  return [0, 1].map(() => new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${databasePath}`, timeout: 15000 }) }));
}

const delta = { records: [{ key: 'p:1', sourceId: 'p:1', destination: 'ru', revision: 'r1', time: 't1', source: 'hello', target: 'привет' }] } as any;

void (async () => {
  try {
    clients = sqliteClients();
    const [first, second] = clients;
    const token = await stageOfficeTranslation(first, { fileId: 'file-a', userId: 'user-a', baseSha: 'sha-a', delta });

    assert.equal(await claimStagedOfficeTranslation(second, token, 'file-a', 'user-b', 'sha-a'), null, 'wrong actor cannot claim a stage');
    assert.equal(await claimStagedOfficeTranslation(second, token, 'file-a', 'user-a', 'sha-b'), null, 'wrong base SHA cannot claim a stage');
    const claims = await Promise.all([
      claimStagedOfficeTranslation(first, token, 'file-a', 'user-a', 'sha-a'),
      claimStagedOfficeTranslation(second, token, 'file-a', 'user-a', 'sha-a'),
    ]);
    assert.equal(claims.filter(Boolean).length, 1, 'two Prisma instances sharing SQLite produce one CAS winner');
    const winner = claims.find(Boolean)!;
    assert.deepEqual(winner.delta, delta, 'the winning instance reads the complete staged delta');

    await winner.finish(false);
    const retry = await claimStagedOfficeTranslation(second, token, 'file-a', 'user-a', 'sha-a');
    assert.ok(retry, 'failed save releases the token for retry');
    await retry!.finish(true);
    assert.equal(await claimStagedOfficeTranslation(first, token, 'file-a', 'user-a', 'sha-a'), null, 'successful save consumes the token');

    const cleanupToken = await stageOfficeTranslation(first, { fileId: 'file-a', userId: 'user-a', baseSha: 'sha-a', delta });
    const cleanupClaim = await claimStagedOfficeTranslation(second, cleanupToken, 'file-a', 'user-a', 'sha-a');
    assert.ok(cleanupClaim);
    const deleteMany = second.appSetting.deleteMany.bind(second.appSetting);
    second.appSetting.deleteMany = async () => { throw new Error('simulated cleanup failure'); };
    await assert.doesNotReject(() => cleanupClaim!.finish(true), 'cleanup failure cannot turn an already committed save into failure');
    second.appSetting.deleteMany = deleteMany;
    const stranded = await first.appSetting.findUnique({ where: { id: `office_translation_stage:${cleanupToken}` } });
    assert.ok(stranded, 'cleanup failure leaves the stage row intact');
    assert.equal(JSON.parse(stranded.value).state, 'inFlight', 'a committed token remains quarantined instead of replayable');
    assert.equal(await claimStagedOfficeTranslation(second, cleanupToken, 'file-a', 'user-a', 'sha-a'), null, 'cleanup failure cannot replay a committed delta');

    const expiryToken = await stageOfficeTranslation(first, { fileId: 'file-a', userId: 'user-a', baseSha: 'sha-a', delta });
    const originalNow = Date.now;
    try {
      Date.now = () => originalNow() + 6 * 60_000;
      assert.equal(await claimStagedOfficeTranslation(second, expiryToken, 'file-a', 'user-a', 'sha-a'), null, 'expired stage cannot be claimed');
    } finally { Date.now = originalNow; }

    console.log('office translation staging: shared SQLite, actor/base guards, racing CAS, retry, cleanup failure, and expiry passed');
  } finally {
    await Promise.all(clients.map(client => client.$disconnect().catch(() => undefined)));
    rmSync(directory, { recursive: true, force: true });
  }
})();
