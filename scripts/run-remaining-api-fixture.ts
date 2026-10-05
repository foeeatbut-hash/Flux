import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadRegistry } from '../verification/registry.js';
import { runSuite } from '../verification/runner.js';

const repo = process.cwd();
const helper = path.join(repo, 'scripts/fixtures/remaining-live/remaining-live.mjs');
const mailSeeder = path.join(repo, 'scripts/fixtures/remaining-collaboration/seed-mail.mjs');
const targets = [
  'collab-chat-privacy',
  'collab-mail-shared-api',
  'collab-feedback-privacy-api',
  'collab-feedback-read-api',
  'collab-assistant-privacy-api',
  'files-office-files-live',
  'eng-remaining-engineering-api-live',
  'eng-builder-live-regressions',
  'eng-equipment-composition-live',
  'eng-equipment-multi-import-live',
  'eng-equipment-position-add-live',
  'files-remaining-explorer-api',
  'shell-play-mariadb-two-api-live',
  'shell-play-two-clients-api-db',
] as const;
const maxPrivateLogBytes = 2 * 1024 * 1024;
const preparationTimeoutMs = 240_000;
const helperStartTimeoutMs = 240_000;

function fail(message: string): never { throw new Error(message); }

function parseDatabaseUrl(raw: string | undefined): URL {
  if (!raw) fail('FLUX_REMAINING_LIVE_DATABASE_URL is required explicitly.');
  let url: URL;
  try { url = new URL(raw); } catch { fail('The explicit fixture database URL is invalid.'); }
  if (!['mysql:', 'mariadb:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase()) || url.search !== '' || url.hash !== '') {
    fail('The fixture database URL must point to loopback MariaDB.');
  }
  if (!url.username || !url.password || decodeURIComponent(url.pathname.slice(1)) !== 'flux_remaining_fixture') {
    fail('The fixture URL must select the dedicated flux_remaining_fixture database and include its fixture credentials.');
  }
  return url;
}

function createPrivateDirectory(directory: string): void {
  const base = path.resolve(os.tmpdir());
  if (path.dirname(directory) !== base || !/^flux-remaining-live-ci(?:-[A-Za-z0-9_-]+)?$/.test(path.basename(directory))) {
    fail('Fixture metadata must use a direct, specifically named temporary directory.');
  }
  if (existsSync(directory)) {
    const info = lstatSync(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) fail('The requested metadata directory is not a real directory.');
    fail('The requested metadata directory already exists; refusing to reuse or remove it.');
  }
  mkdirSync(directory, { mode: 0o700 });
  privateWorkDirOwned = true;
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    rmSync(directory, { recursive: true, force: true });
    privateWorkDirOwned = false;
    fail('The private fixture directory is not a real mode-0700 directory.');
  }
}

function validateStateDirectory(raw: string): string {
  const expectedBase = path.resolve(os.tmpdir());
  const candidate = path.resolve(raw);
  if (path.dirname(candidate) !== expectedBase || !/^flux-remaining-live-[A-Za-z0-9_-]+$/.test(path.basename(candidate))) {
    fail('The helper returned a state directory outside the expected temporary fixture prefix.');
  }
  const info = lstatSync(candidate);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) fail('The helper state directory is not private.');
  const stateFile = path.join(candidate, 'state.json');
  const stateInfo = lstatSync(stateFile);
  if (!stateInfo.isFile() || stateInfo.isSymbolicLink() || (stateInfo.mode & 0o077) !== 0) fail('The helper state file is not private.');
  const state = JSON.parse(readFileSync(stateFile, 'utf8')) as any;
  if (state.kind !== 'flux-remaining-live' || state.databaseName !== 'flux_remaining_fixture' || state.servers?.length !== 2) fail('The helper state does not describe the expected two-server fixture.');
  for (const [index, port] of [4300, 4301].entries()) {
    const server = state.servers[index];
    if (server.index !== index + 1 || server.port !== port || server.origin !== `http://127.0.0.1:${port}`) fail('The helper state has an unexpected server address.');
    if (path.resolve(server.dataDir) !== path.join(candidate, `server-${index + 1}`) || path.resolve(server.logPath) !== path.join(candidate, `server-${index + 1}.log`)) fail('The helper state contains paths outside its private fixture directory.');
  }
  return candidate;
}

function terminateProcessTree(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
      killer.unref();
    } else process.kill(-child.pid, 'SIGTERM');
  } catch { try { child.kill('SIGTERM'); } catch { /* already exited */ } }
}

async function runPrivateCommand(args: string[], logFd: number, timeoutMs: number, env: NodeJS.ProcessEnv): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, ['--import', 'tsx', ...args], { cwd: repo, env, detached: process.platform !== 'win32', stdio: ['ignore', logFd, logFd], windowsHide: true });
    } catch { reject(new Error('Could not start a fixture preparation command.')); return; }
    let done = false;
    let excessive = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(monitor);
      error ? reject(error) : resolve();
    };
    const timer = setTimeout(() => {
      terminateProcessTree(child);
      finish(new Error('A fixture preparation command timed out.'));
    }, timeoutMs);
    const monitor = setInterval(() => {
      try { if (statSync(privateLogPath).size > maxPrivateLogBytes) { excessive = true; terminateProcessTree(child); finish(new Error('A fixture preparation command exceeded its private log limit.')); } }
      catch { terminateProcessTree(child); finish(new Error('A fixture preparation command log could not be read.')); }
    }, 100);
    child.once('error', () => finish(new Error('Could not start a fixture preparation command.')));
    child.once('close', code => finish(excessive ? new Error('A fixture preparation command exceeded its private log limit.') : code === 0 ? undefined : new Error('A fixture preparation command failed.')));
  });
}

let privateLogPath = '';

async function waitForState(child: ChildProcess, logPath: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const stateLine = /^Fixture state: (.+)$/m;
  while (Date.now() < deadline) {
    const size = statSync(logPath).size;
    if (size > maxPrivateLogBytes) fail('Fixture startup exceeded its private log limit.');
    const content = readFileSync(logPath, 'utf8');
    const match = stateLine.exec(content);
    if (match) return validateStateDirectory(match[1].trim());
    if (child.exitCode !== null || child.signalCode !== null) fail('Fixture server startup ended before reporting a validated state directory.');
    await delay(200);
  }
  fail('Fixture server startup timed out before reporting a validated state directory.');
}

function readFixtureMetadata(file: string, stateDir: string): any {
  const resolved = path.resolve(file);
  if (path.basename(resolved) !== 'metadata.json' || !resolved.startsWith(`${privateWorkDir}${path.sep}`)) fail('Fixture metadata path is outside the private work directory.');
  const info = lstatSync(resolved);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) fail('Fixture metadata is not a private regular file.');
  const metadata = JSON.parse(readFileSync(resolved, 'utf8'));
  if (metadata.kind !== 'flux-remaining-live-fixture' || metadata.databaseName !== 'flux_remaining_fixture' || metadata.servers?.length !== 2) fail('Fixture metadata does not match the disposable MariaDB fixture.');
  for (const [index, port] of [4300, 4301].entries()) if (metadata.servers[index]?.origin !== `http://127.0.0.1:${port}`) fail('Fixture metadata has an unexpected API origin.');
  if (path.resolve(stateDir) !== fixtureStateDir) fail('Fixture state changed during setup.');
  return metadata;
}

let privateWorkDir = '';
let privateWorkDirOwned = false;
let fixtureStateDir = '';

async function main(): Promise<number> {
  if (process.env.FLUX_TEST_FIXTURE !== '1') fail('Set FLUX_TEST_FIXTURE=1 only for this disposable API fixture workflow.');
  parseDatabaseUrl(process.env.FLUX_REMAINING_LIVE_DATABASE_URL);
  const requestedMetadata = process.env.FLUX_REMAINING_LIVE_METADATA;
  if (!requestedMetadata || !path.isAbsolute(requestedMetadata) || path.basename(requestedMetadata) !== 'metadata.json') fail('Set FLUX_REMAINING_LIVE_METADATA explicitly to a private metadata.json path.');
  privateWorkDir = path.dirname(path.resolve(requestedMetadata));
  createPrivateDirectory(privateWorkDir);
  if (existsSync(requestedMetadata)) fail('Fixture metadata already exists; refusing to reuse prior fixture credentials.');
  privateLogPath = path.join(privateWorkDir, 'orchestrator.log');
  const logFd = openSync(privateLogPath, 'wx', 0o600);
  chmodSync(privateLogPath, 0o600);
  let helperChild: ChildProcess | undefined;
  let fixtureState: string | undefined;
  let fixtureStopped = false;
  let results: Array<{ id: string; status: string; reason?: string; failedChecks?: string[] }> = [];
  let failure: string | undefined;
  try {
    helperChild = spawn(process.execPath, ['--import', 'tsx', helper, 'start', '--keepalive'], {
      cwd: repo,
      env: { ...process.env, FLUX_TEST_FIXTURE: '1', FLUX_REMAINING_LIVE_API_ONLY: '1' },
      detached: process.platform !== 'win32',
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
    });
    fixtureState = await waitForState(helperChild, privateLogPath, helperStartTimeoutMs);
    fixtureStateDir = fixtureState;
    await runPrivateCommand([helper, 'seed', fixtureState], logFd, preparationTimeoutMs, process.env);
    await runPrivateCommand([helper, 'preflight', fixtureState], logFd, preparationTimeoutMs, process.env);
    await runPrivateCommand([mailSeeder, fixtureState], logFd, preparationTimeoutMs, process.env);
    const metadataPath = path.resolve(requestedMetadata);
    const metadata = readFixtureMetadata(metadataPath, fixtureState);
    const admin = metadata.accounts.find((account: any) => account.role === 'ADMIN');
    const players = metadata.accounts.filter((account: any) => account.role === 'ENGINEER_VENT' && account.group === 'play');
    if (!admin?.symbol || !admin?.password || players.length < 2 || players.some((account: any) => !account.symbol || !account.password)) fail('Synthetic ADMIN and two Play fixture accounts are required.');
    const registry = loadRegistry(repo);
    const suites = new Map<string, any>();
    for (const manifest of registry.manifests) for (const suite of manifest.suites) suites.set(suite.id, suite);
    const missing = targets.filter(id => !suites.has(id));
    if (missing.length) fail(`Registered API suites are missing: ${missing.join(', ')}.`);
    const baseEnv = { ...process.env, FLUX_TEST_FIXTURE: '1', FLUX_REMAINING_LIVE_DATABASE_URL: process.env.FLUX_REMAINING_LIVE_DATABASE_URL!, FLUX_DB_FIXTURE_URL: process.env.FLUX_REMAINING_LIVE_DATABASE_URL!, FLUX_REMAINING_LIVE_METADATA: metadataPath, FLUX_API: 'http://127.0.0.1:4300', FLUX_API2: 'http://127.0.0.1:4301', FLUX_USER: admin.symbol, FLUX_PASS: admin.password };
    for (const id of targets) {
      const env = id === 'shell-play-two-clients-api-db'
        ? { ...baseEnv, FLUX_USER: players[0].symbol, FLUX_PASS: players[0].password, FLUX_USER2: players[1].symbol, FLUX_PASS2: players[1].password }
        : baseEnv;
      const saved = process.env;
      process.env = env;
      let result;
      try { result = await runSuite(suites.get(id), repo, { captureParentDir: privateWorkDir }); }
      finally { process.env = saved; }
      // Только названия проваленных проверок из уже очищенного вывода; ответы API и значения не печатаем.
      const failedChecks = result.output?.split(/\r?\n/).filter(line => /^\s*✗ /.test(line)).map(line => line.trim().slice(2, 242)).slice(0, 12);
      results.push({ id, status: result.status, ...(result.reason ? { reason: result.reason } : {}), ...(failedChecks?.length ? { failedChecks } : {}) });
    }
  } catch (error) {
    // Error messages here are our fixed messages; suite output and helper logs remain private.
    failure = error instanceof Error ? error.message : 'Fixture orchestration failed.';
  } finally {
    if (fixtureState) {
      try {
        await runPrivateCommand([helper, 'stop', fixtureState], logFd, 30_000, process.env);
        fixtureStopped = true;
      }
      catch { failure ||= 'Fixture cleanup command failed; no report data was emitted.'; }
    } else if (helperChild && helperChild.exitCode === null && helperChild.signalCode === null) {
      // Before validating a state path, only signal the exact child handle we started.
      try { helperChild.kill('SIGTERM'); } catch { /* process already exited */ }
    }
    try { closeSync(logFd); } catch { /* already closed */ }
    if (fixtureStopped && fixtureState) rmSync(fixtureState, { recursive: true, force: true });
    if (privateWorkDirOwned) rmSync(privateWorkDir, { recursive: true, force: true });
  }
  const counts = results.reduce<Record<string, number>>((acc, item) => { acc[item.status] = (acc[item.status] || 0) + 1; return acc; }, {});
  process.stdout.write(`Remaining API fixture suites: ${results.length} total; ${counts.PASS || 0} PASS, ${counts.FAIL || 0} FAIL, ${counts.BLOCKED || 0} BLOCKED, ${counts.SKIP || 0} SKIP.\n`);
  const failed = results.filter(item => item.status !== 'PASS');
  for (const result of failed) process.stdout.write(`FAIL ${result.id}: ${result.status}${result.reason ? ` (${result.reason})` : ''}${result.failedChecks?.length ? ` — ${result.failedChecks.join('; ')}` : ''}\n`);
  if (failure) process.stdout.write(`FAIL fixture orchestration: ${failure}\n`);
  return failure || failed.length ? 1 : 0;
}

void main().then(code => { process.exitCode = code; }).catch(() => {
  if (privateWorkDirOwned && privateWorkDir) {
    rmSync(privateWorkDir, { recursive: true, force: true });
    privateWorkDirOwned = false;
  }
  process.stdout.write('FAIL fixture orchestration: setup or cleanup failed; private details were suppressed.\n');
  process.exitCode = 1;
});
