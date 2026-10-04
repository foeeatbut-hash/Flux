import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRegistry, ManifestError } from '../verification/registry.js';
import { computeScopedSourceDigest, runSuite as runSuiteCore, runVerification, verificationExitCode } from '../verification/runner.js';
import type { VerificationManifest } from '../verification/contracts.js';

const root = mkdtempSync(path.join(os.tmpdir(), 'flux-verify-test-'));
const captureParent = path.join(root, 'capture-parent');
mkdirSync(captureParent, { recursive: true });
const manifests = path.join(root, 'verification', 'manifests');
mkdirSync(manifests, { recursive: true });
const write = (rel: string, content: string) => {
  const full = path.join(root, rel); mkdirSync(path.dirname(full), { recursive: true }); writeFileSync(full, content); return rel;
};
const js = (body: string) => `"use strict";\n${body}\n`;
function manifest(group: string, extras: Partial<VerificationManifest> = {}): VerificationManifest {
  const source = write(`src/${group}.txt`, 'source');
  return { version: 1, group, programs: [{ id: group, label: group, routes: [], sources: [source] }], suites: [], actions: [], connections: [], ...extras };
}
const save = (m: VerificationManifest, name = `${m.group}.json`) => writeFileSync(path.join(manifests, name), JSON.stringify(m));
const suite = (id: string, rel: string, opts: Partial<VerificationManifest['suites'][number]> = {}) => ({ id, path: rel, layer: 'unit' as const, platform: 'any' as const, resources: [], prerequisites: [], timeoutMs: 2_000, ...opts });
const captureDirs = () => readdirSync(captureParent).filter((x) => x.startsWith('flux-verification-capture-')).sort();
const runSuite = (s: ReturnType<typeof suite>, fixtureRoot = root) => runSuiteCore(s, fixtureRoot, { captureParentDir: captureParent });
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>) {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { await fn(); } finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

async function main() {
  const initialCaptureDirs = captureDirs();
  try {
    const passPath = write('scripts/pass.cjs', js('process.stdout.write("STDOUT_CAPTURE_MARK\\n"); process.stderr.write("STDERR_CAPTURE_MARK\\n");'));
    const failPath = write('scripts/fail.cjs', js('process.stderr.write("VERIFY_CAPTURE_5F9D\\n"); process.exitCode = 7;'));
    const skipPath = write('scripts/skip.cjs', js('process.stdout.write("FLUX_VERIFY_SKIP: fixture condition not met\\n");'));
    const lateSkipPath = write('scripts/late-skip.cjs', js('process.stdout.write("FLUX_VERIFY_SKIP: late marker\\n" + "x".repeat(30000));'));
    const overflowPath = write('scripts/overflow.cjs', js('process.stdout.write("x".repeat(300000));'));
    const blockedPath = write('scripts/blocked.cjs', js('process.exit(0);'));
    const platformPath = write('scripts/platform.cjs', js('process.exit(0);'));
    const captured = await runSuite(suite('pass', passPath), root);
    assert.equal(captured.status, 'PASS', 'zero exit is PASS');
    assert.match(captured.output ?? '', /STDOUT_CAPTURE_MARK/, 'stdout is captured through the private log file');
    assert.match(captured.output ?? '', /STDERR_CAPTURE_MARK/, 'stderr is captured through the private log file');
    assert((captured.output?.indexOf('STDOUT_CAPTURE_MARK') ?? -1) < (captured.output?.indexOf('STDERR_CAPTURE_MARK') ?? -1), 'stdout and stderr retain shared-fd write order');
    const failed = await runSuite(suite('fail', failPath), root);
    assert.equal(failed.status, 'FAIL', 'nonzero exit is FAIL');
    assert.match(failed.output ?? '', /VERIFY_CAPTURE_5F9D/, 'failed process output is included');
    const skipped = await runSuite(suite('skip', skipPath), root);
    assert.equal(skipped.status, 'SKIP', 'structured subprocess skip is never green');
    assert.match(skipped.reason ?? '', /fixture condition not met/);
    assert.equal((await runSuite(suite('late-skip', lateSkipPath), root)).status, 'SKIP', 'skip markers are detected across the full capture, not just the report tail');
    assert.equal((await runSuite(suite('overflow', overflowPath), root)).status, 'FAIL', 'oversized capture fails closed');
    assert.equal((await runSuite(suite('blocked', blockedPath, { prerequisites: [{ kind: 'env', name: 'FLUX_TEST_FIXTURE', value: 'yes' }] }), root)).status, 'BLOCKED', 'missing explicit prerequisite is blocked');
    assert.equal((await runSuite(suite('missing-file', blockedPath, { prerequisites: [{ kind: 'file', path: 'generated/not-built.js' }] }), root)).status, 'BLOCKED', 'missing file prerequisite blocks execution instead of invalidating the registry');
    const otherPlatform = process.platform === 'win32' ? 'linux' : 'win32';
    assert.equal((await runSuite(suite('platform', platformPath, { platform: otherPlatform }), root)).status, 'SKIP', 'unsupported platform is a skip');

    const descendantMarker = path.join(root, 'surviving-descendant.txt');
    const descendantCode = `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(descendantMarker)},'survived'),700)`;
    const descendantPath = write('scripts/timeout-descendant.cjs', js(`const {spawn}=require('node:child_process'); spawn(process.execPath,['-e',${JSON.stringify(descendantCode)}],{stdio:'ignore'}); setInterval(()=>{},1000);`));
    const beforeTimeoutDirs = captureDirs();
    assert.equal((await runSuite(suite('timeout', descendantPath, { timeoutMs: 100 }), root)).status, 'FAIL', 'timeout is a failure');
    await delay(850);
    assert.equal(existsSync(descendantMarker), false, 'timeout terminates descendant processes');
    assert.deepEqual(captureDirs(), beforeTimeoutDirs, 'timeout removes its private capture directory');

    const fakeSecret = 'VERIFY_SECRET_7ca044e5';
    await withEnv({ FLUX_VERIFY_TEST_SECRET: fakeSecret }, async () => {
      const secretText = `${fakeSecret} mysql://user:db-password@127.0.0.1/company {"token":"JSON_TOKEN_6baf","password":"JSON_PASSWORD_31f2","ownerPassword":"two word phrase","refresh_token":"MULTI TOKEN PHRASE"} Authorization: Bearer AUTH_TOKEN_9bb1`;
      const secretPath = write('scripts/secret.cjs', js(`process.stdout.write(${JSON.stringify(secretText)});`));
      const secretResult = await runSuite(suite('secret', secretPath), root);
      assert.equal(secretResult.status, 'PASS');
      assert(!secretResult.output?.includes(fakeSecret), 'environment secret is redacted before report construction');
      assert(!secretResult.output?.includes('db-password'), 'connection URL credentials are redacted');
      assert(!secretResult.output?.includes('JSON_TOKEN_6baf') && !secretResult.output?.includes('JSON_PASSWORD_31f2'), 'JSON token and password values are redacted');
      assert(!secretResult.output?.includes('two word phrase') && !secretResult.output?.includes('MULTI TOKEN PHRASE'), 'multiword JSON secrets are fully redacted');
      assert(!secretResult.output?.includes('AUTH_TOKEN_9bb1'), 'Authorization bearer values are redacted');
    });

    await withEnv({ FLUX_API: 'https://company.invalid/api', DATABASE_URL: undefined }, async () => {
      assert.equal((await runSuite(suite('remote-api', passPath, { layer: 'api-db' }), root)).status, 'BLOCKED', 'non-loopback FLUX_API cannot reach a company host');
    });
    await withEnv({ FLUX_API: undefined, FLUX_API2: 'https://company.invalid/second-client', FLUX_PG_URL: undefined, DATABASE_URL: undefined }, async () => {
      assert.equal((await runSuite(suite('remote-api2', passPath, { layer: 'api-db' }), root)).status, 'BLOCKED', 'non-loopback FLUX_API2 cannot reach a company host');
    });
    await withEnv({ FLUX_API: undefined, FLUX_API2: undefined, FLUX_PG_URL: 'postgres://user:pw@database.company.invalid/company', DATABASE_URL: undefined }, async () => {
      assert.equal((await runSuite(suite('remote-pg', passPath, { layer: 'api-db' }), root)).status, 'BLOCKED', 'non-loopback FLUX_PG_URL cannot reach a company database');
    });
    await withEnv({ FLUX_TEST_FIXTURE_URL: 'https://company.invalid/fixture', FLUX_API: undefined, FLUX_API2: undefined, FLUX_PG_URL: undefined, DATABASE_URL: undefined }, async () => {
      assert.equal((await runSuite(suite('remote-fixture-url', passPath, { prerequisites: [{ kind: 'env', name: 'FLUX_TEST_FIXTURE_URL' }] }), root)).status, 'BLOCKED', 'all declared URL variables are checked, including fixture URLs');
    });
    const forbiddenTarget = path.join(root, 'unsafe-suite-executed.txt');
    const unsafeSentinel = write('scripts/unsafe-sentinel.cjs', js(`require('node:fs').writeFileSync(${JSON.stringify(forbiddenTarget)},'executed');`));
    await withEnv({ DATABASE_URL: 'mysql://user:pw@database.company.invalid/company', FLUX_API: undefined, FLUX_API2: undefined, FLUX_PG_URL: undefined }, async () => {
      assert.equal((await runSuite(suite('unit-remote-db', unsafeSentinel, { layer: 'unit' }), root)).status, 'BLOCKED', 'unit suites inherit the remote database guard');
      assert.equal(existsSync(forbiddenTarget), false, 'unit suite is blocked before its child process starts');
    });
    await withEnv({ DATABASE_URL: undefined, FLUX_API: undefined, FLUX_API2: 'https://company.invalid/component', FLUX_PG_URL: undefined }, async () => {
      assert.equal((await runSuite(suite('component-remote-api', unsafeSentinel, { layer: 'component' }), root)).status, 'BLOCKED', 'component suites inherit the FLUX_API2 guard');
      assert.equal(existsSync(forbiddenTarget), false, 'component suite is blocked before its child process starts');
    });
    await withEnv({ FLUX_API: undefined, DATABASE_URL: 'mysql://user:pw@database.company.invalid/company' }, async () => {
      assert.equal((await runSuite(suite('remote-db', passPath, { layer: 'api-db' }), root)).status, 'BLOCKED', 'API/DB suites cannot fall back to a non-loopback database URL');
    });
    await withEnv({ FLUX_API: undefined, DATABASE_URL: 'mysql://user:pw@127.0.0.1/flux_test_selfcontained' }, async () => {
      assert.equal((await runSuite(suite('self-contained-db', passPath, { layer: 'api-db' }), root)).status, 'PASS', 'local test-prefixed DB suites need no external-safety flags');
    });
    await withEnv({ FLUX_API: undefined, DATABASE_URL: 'mysql://user:pw@127.0.0.1/flux_update_fixture', FLUX_PG_URL: undefined }, async () => {
      assert.equal((await runSuite(suite('update-fixture-db', passPath, { layer: 'api-db' }), root)).status, 'PASS', 'documented flux_update_fixture database names are allowed');
    });
    await withEnv({ FLUX_API: undefined, DATABASE_URL: 'mysql://user:pw@127.0.0.1/flux_catalog_fixture_http', FLUX_PG_URL: undefined }, async () => {
      assert.equal((await runSuite(suite('catalog-fixture-db', passPath, { layer: 'api-db' }), root)).status, 'PASS', 'documented flux_catalog_fixture_http database names are allowed');
    });
    await withEnv({ FLUX_API: undefined, FLUX_TEST_FIXTURE: '1', FLUX_TEST_DB: 'mysql://user:pw@127.0.0.1/company', FLUX_TEST_DATABASE_URL: undefined, DATABASE_URL: undefined }, async () => {
      const external = suite('external-db', passPath, { external: true, prerequisites: [{ kind: 'env', name: 'FLUX_TEST_FIXTURE', value: '1' }, { kind: 'env', name: 'FLUX_TEST_DB' }] });
      assert.equal((await runSuite(external, root)).status, 'BLOCKED', 'fixture marker cannot authorize a non-test database name');
    });
    await withEnv({ FLUX_API: undefined, FLUX_TEST_FIXTURE: '1', FLUX_TEST_DATABASE_URL: 'mysql://user:pw@127.0.0.1/flux_test_verification', DATABASE_URL: undefined }, async () => {
      const external = suite('external-fixture-db', passPath, { external: true, prerequisites: [{ kind: 'env', name: 'FLUX_TEST_FIXTURE', value: '1' }, { kind: 'env', name: 'FLUX_TEST_DATABASE_URL' }] });
      assert.equal((await runSuite(external, root)).status, 'PASS', 'explicit local test database is allowed');
    });

    // Two different suite IDs for one path/configuration share one execution, and locks serialize distinct scripts.
    const lockPath = path.join(root, 'one-at-a-time'), countA = path.join(root, 'count-a'), countB = path.join(root, 'count-b');
    const lockSource = (count: string) => `const fs=require('node:fs'); const p=${JSON.stringify(lockPath)}, c=${JSON.stringify(count)}; try { fs.mkdirSync(p); } catch { process.exit(31); } fs.writeFileSync(c, String(Number(fs.readFileSync(c,'utf8')||'0')+1)); setTimeout(()=>{fs.rmdirSync(p);},60);`;
    write('count-a', '0'); write('count-b', '0');
    const lockA = write('scripts/lock-a.cjs', js(lockSource(countA))), lockB = write('scripts/lock-b.cjs', js(lockSource(countB)));
    const groupA = manifest('alpha', { suites: [suite('alpha.lock', lockA, { resources: ['shared-db'] })], actions: [{ id: 'alpha.action', program: 'alpha', label: 'a', sources: [`src/alpha.txt`], triggers: ['button'], risk: 'normal', expected: ['state'], checks: [{ suite: 'alpha.lock', layer: 'unit', claims: ['one scoped claim'] }], manual: [{ layer: 'portable', scenario: 'manual fixture', expected: ['result'] }] }] });
    const groupB = manifest('beta', { suites: [suite('beta.lock', lockB, { resources: ['shared-db'] })] });
    // Same file/config under an alias is deduplicated and both IDs receive the same result.
    groupB.suites.push(suite('beta.alias', lockB, { resources: ['shared-db'] }));
    save(groupA); save(groupB);
    const actualRegistry = loadRegistry(root);
    assert.equal(actualRegistry.suites.size, 3, 'registry accepts empty arrays and distinct suite IDs');
    const report = await runVerification({ root, concurrency: 3 });
    assert(report.suites.every((x) => x.status === 'PASS'), 'same resource is serialized and duplicate suite config executes successfully');
    assert.equal(Number(readFileSync(countB, 'utf8')), 1, 'identical suite aliases execute once');
    assert.equal(report.suites.find((x) => x.id === 'beta.lock')?.durationMs, report.suites.find((x) => x.id === 'beta.alias')?.durationMs, 'aliases receive identical outcome');
    assert.equal(report.actions[0].status, 'PARTIAL', 'suite success is a scoped claim, not an action-wide pass');
    assert.equal(report.actions[0].manual[0].status, 'NOT_RUN', 'manual scenario remains visibly unrun');

    write('package.json', JSON.stringify({ name: 'verification-fixture', version: '3.4.5' }));
    write('package-lock.json', JSON.stringify({ name: 'verification-fixture', lockfileVersion: 3 }));
    const digestSource = write('src/digest-source.ts', 'export const value = 1;');
    const digestNameOne = write('src/digest-name-one.ts', 'same bytes');
    const digestNameTwo = write('src/digest-name-two.ts', 'same bytes');
    assert.equal(computeScopedSourceDigest(root, [digestSource, digestNameOne]), computeScopedSourceDigest(root, [digestNameOne, digestSource]), 'digest input order is normalized by sorted filenames');
    assert.notEqual(computeScopedSourceDigest(root, [digestSource, digestNameOne]), computeScopedSourceDigest(root, [digestSource, digestNameTwo]), 'filenames contribute to the scoped digest even when bytes match');
    const digestGroup = manifest('digest-case', { programs: [{ id: 'digest-case', label: 'digest', routes: [], sources: [digestSource] }], suites: [suite('digest-case.stable', passPath)] });
    save(digestGroup);
    const digestFirst = await runVerification({ root, group: 'digest-case' });
    const digestSecond = await runVerification({ root, group: 'digest-case' });
    assert.equal(digestFirst.appVersion, '3.4.5', 'report reads application version from the scoped package manifest');
    assert.equal(digestFirst.platform, process.platform, 'report records the current platform');
    assert.equal(digestFirst.nodeVersion, process.version, 'report records the Node runtime version');
    assert.equal(digestFirst.scopedSourceDigest, digestSecond.scopedSourceDigest, 'identical sorted source file sets produce identical digests');
    assert.equal(digestSecond.sourceChangedDuringRun, false, 'unchanged fixture sources retain one start and end digest');
    assert.equal(verificationExitCode(digestSecond), 0, 'a stable all-pass run exits successfully');

    const mutator = write('scripts/mutate-source.cjs', js(`require('node:fs').writeFileSync(${JSON.stringify(path.join(root, digestSource))},'export const value = 2;');`));
    digestGroup.suites = [suite('digest-case.mutate', mutator)];
    save(digestGroup);
    const digestDuring = await runVerification({ root, group: 'digest-case' });
    assert.equal(digestDuring.sourceChangedDuringRun, true, 'a source edit during a run changes the finished digest');
    assert.notEqual(digestDuring.scopedSourceDigest, digestDuring.finishedScopedSourceDigest, 'start and finish digests expose an in-run source edit');
    assert.equal(verificationExitCode(digestDuring), 1, 'a changed source snapshot cannot exit green');
    const digestAfter = await runVerification({ root, group: 'digest-case' });
    assert.equal(digestAfter.scopedSourceDigest, digestDuring.finishedScopedSourceDigest, 'the changed source becomes the next run start snapshot');
    assert.equal(digestAfter.sourceChangedDuringRun, false, 'repeating an idempotent fixture edit is stable');

    const freeStarted = path.join(root, 'free-started'), freeFinished = path.join(root, 'free-finished'), exclusiveObserved = path.join(root, 'exclusive-observed-free-finished');
    const freeScript = write('scripts/free-resource.cjs', js(`const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(freeStarted)},'started'); setTimeout(()=>fs.writeFileSync(${JSON.stringify(freeFinished)},'finished'),180);`));
    const exclusiveScript = write('scripts/exclusive-resource.cjs', js(`const fs=require('node:fs'); if(fs.existsSync(${JSON.stringify(freeFinished)})) fs.writeFileSync(${JSON.stringify(exclusiveObserved)},'yes');`));
    const lockGroup = manifest('exclusive-case', { suites: [suite('exclusive-case.free', freeScript), suite('exclusive-case.measure', exclusiveScript, { resources: ['exclusive'] })] });
    save(lockGroup);
    const exclusiveReport = await runVerification({ root, group: 'exclusive-case', concurrency: 2 });
    assert(exclusiveReport.suites.every((x) => x.status === 'PASS'), 'exclusive fixtures complete successfully');
    assert(existsSync(freeStarted) && existsSync(exclusiveObserved), 'exclusive suite waits for a running suite that declared no resources');

    // Cross-group references are valid globally but remain blocked outside the requested group.
    groupA.actions[0].checks.push({ suite: 'beta.lock', layer: 'unit', claims: ['cross-group claim'] });
    save(groupA); save(groupB);
    const scoped = await runVerification({ root, group: 'alpha' });
    assert.equal(scoped.suites.find((x) => x.id === 'beta.lock')?.status, 'BLOCKED', 'cross-group suite is not secretly run in a scoped invocation');
    assert.equal(scoped.actions[0].claims.find((x) => x.suite === 'beta.lock')?.status, 'BLOCKED', 'cross-group claim remains uncovered');

    // Registry rejects traversal, unknown program/suite references, layer mismatches, and duplicate IDs.
    rmSync(manifests, { recursive: true, force: true }); mkdirSync(manifests, { recursive: true });
    const bad = manifest('bad', { suites: [suite('bad.suite', passPath)], actions: [{ id: 'bad.action', program: 'missing', label: 'bad', sources: ['../escape'], triggers: ['button'], risk: 'normal', expected: ['x'], checks: [{ suite: 'bad.suite', layer: 'component', claims: ['false green'] }, { suite: 'gone', layer: 'unit', claims: ['dangling'] }], manual: [] }] });
    save(bad);
    assert.throws(() => loadRegistry(root), (e: unknown) => e instanceof ManifestError && /unknown program/.test(e.message) && /unknown suite/.test(e.message) && /layer mismatch/.test(e.message) && /safe repository-relative/.test(e.message), 'invalid references and traversal are rejected');
    const duplicate = manifest('dup', { suites: [suite('dup.id', passPath)] });
    duplicate.actions.push({ id: 'dup.action', program: 'dup', label: 'one', sources: ['src/dup.txt'], triggers: ['button'], risk: 'normal', expected: ['x'], checks: [], manual: [] });
    duplicate.actions.push({ id: 'dup.action', program: 'dup', label: 'two', sources: ['src/dup.txt'], triggers: ['button'], risk: 'normal', expected: ['x'], checks: [], manual: [] });
    save(duplicate, 'duplicate.json');
    assert.throws(() => loadRegistry(root), /duplicate action ID/);

    rmSync(manifests, { recursive: true, force: true }); mkdirSync(manifests, { recursive: true });
    const duplicateRoute = manifest('duplicate-route', { programs: [
      { id: 'program-a', label: 'a', routes: ['/shared', '/alias'], sources: ['src/duplicate-route.txt'] },
      { id: 'program-b', label: 'b', routes: ['/shared'], sources: ['src/duplicate-route.txt'] },
    ] });
    save(duplicateRoute);
    assert.throws(() => loadRegistry(root), /route \/shared: owned by more than one program/);

    rmSync(manifests, { recursive: true, force: true }); mkdirSync(manifests, { recursive: true });
    const unsafeExternal = manifest('external', { suites: [suite('external.db', passPath, { external: true, prerequisites: [{ kind: 'env', name: 'FLUX_TEST_DB', value: '1' }] })] });
    save(unsafeExternal);
    assert.throws(() => loadRegistry(root), /requires an explicit FLUX_TEST_\* safety-marker/);

    rmSync(manifests, { recursive: true, force: true }); mkdirSync(manifests, { recursive: true });
    const absentPrerequisite = manifest('absent-file', { suites: [suite('absent-file.suite', passPath, { prerequisites: [{ kind: 'file', path: 'generated/not-built.js' }] })] });
    save(absentPrerequisite);
    assert.equal(loadRegistry(root).suites.size, 1, 'missing file prerequisites are runtime BLOCKED conditions, not malformed manifests');

    rmSync(manifests, { recursive: true, force: true }); mkdirSync(manifests, { recursive: true });
    assert.throws(() => loadRegistry(root), /no verification manifests found/, 'an empty manifest directory is a configuration error');
    const manualOnly = manifest('manual-only', { actions: [{ id: 'manual-only.action', program: 'manual-only', label: 'manual', sources: ['src/manual-only.txt'], triggers: ['button'], risk: 'normal', expected: ['result'], checks: [], manual: [{ layer: 'windows-native', scenario: 'manual-only fixture', expected: ['visible result'] }] }] });
    save(manualOnly);
    await assert.rejects(runVerification({ root, group: 'manual-only' }), /no executable verification suites/);

    assert.deepEqual(captureDirs(), initialCaptureDirs, 'all subprocess runs remove private capture directories');
    console.log('verification runner: fixtures passed');
  } finally { rmSync(root, { recursive: true, force: true }); }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
