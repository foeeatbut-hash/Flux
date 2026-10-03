import assert from 'node:assert/strict';
import { companyDatabaseUri, databaseSummary, probeCompanyDatabase } from '../electron/databaseConnection';

const uri = 'mysql://fixture_user:fixture%40only%24pass@db.example.test:3306/flux_fixture';
async function main() {
  assert.equal(companyDatabaseUri(uri), uri);
  assert.ok(companyDatabaseUri(uri.replace('mysql:', 'mariadb:')));
  for (const bad of ['https://db.example.test', 'postgresql://u:p@db.example.test/fixture', '', 'mysql://u@db.example.test/fixture', `${uri}?initSql=DELETE`, `${uri}?permitLocalInfile=true`, `${uri}?socketPath=%2Ftmp%2Fmysql`, `${uri}?ssl=false&rejectUnauthorized=false`, `${uri}#fragment`]) {
    assert.equal(companyDatabaseUri(bad), null);
  }
  assert.deepEqual(databaseSummary(uri), { configured: true, provider: 'mysql', host: 'db.example.test:3306', database: 'flux_fixture' });
  assert.ok(!JSON.stringify(databaseSummary(uri)).includes('fixture_user'));
  let queries: string[] = [], closed = 0, options: any;
  const connect = async (opts: any) => {
    options = opts;
    return { query: async (sql: string) => { queries.push(sql); return []; }, end: async () => { closed++; } };
  };
  assert.equal((await probeCompanyDatabase(uri, connect)).success, true);
  assert.deepEqual(queries, ['SELECT DATABASE() AS databaseName']);
  assert.equal(closed, 1);
  assert.equal(options.password, 'fixture@only$pass');
  assert.equal(options.permitLocalInfile, false);
  assert.equal(options.permitRedirect, false);
  await probeCompanyDatabase(`${uri}?ssl=true`, connect);
  assert.deepEqual(options.ssl, { rejectUnauthorized: true });
  assert.equal((await probeCompanyDatabase('https://foreign.test', async () => { throw Error('must not connect'); })).success, false);
  const denied = await probeCompanyDatabase(uri, async () => { throw Object.assign(Error(uri), { code: 'ER_ACCESS_DENIED_ERROR' }); });
  assert.equal(denied.success, false);
  assert.ok(!JSON.stringify(denied).includes('fixture_user') && !JSON.stringify(denied).includes('fixture%40'));
  const failed = await probeCompanyDatabase(uri, async () => ({ query: async () => { throw Error(uri); }, end: async () => { closed++; } }));
  assert.equal(failed.success, false);
  assert.equal(closed, 3);
  console.log('✓ company DB: MySQL only, readonly probe, bounded driver options, close on failure, redacted errors');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
