import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, existsSync, ftruncateSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { isIP } from 'node:net';
import os from 'node:os';
import type { VerificationManifest, VerificationReport, VerificationSuite, SuiteResult, SuiteStatus, VerificationCheck, ManualCheck } from './contracts.js';
import { loadRegistry, type Registry } from './registry.js';

export interface RunOptions { root?: string; manifestDir?: string; group?: string; concurrency?: number }
export interface RunSuiteOptions { captureParentDir?: string }
interface RunOutcome { status: SuiteStatus; durationMs: number; exitCode: number | null; reason?: string; output?: string }
interface Job { key: string; aliases: Array<{ manifest: VerificationManifest; suite: VerificationSuite }> ; suite: VerificationSuite }
const platform = process.platform;
const MAX_CAPTURE_BYTES = 256 * 1024;
const CAPTURE_POLL_MS = 10;
const TEST_DATABASE_PREFIX = /^(?:(?:test|tests|flux[_-]test|flux[_-]tests)[_-]|flux_[a-z0-9_]+_fixture(?:_|$))/i;
const VERIFICATION_EVIDENCE_FILES = [
  'package.json', 'package-lock.json',
  'verification/contracts.ts', 'verification/registry.ts', 'verification/runner.ts',
  'verification/coverage.ts', 'verification/sourceInventory.ts',
  'scripts/verify-programs.ts', 'scripts/test-verification-runner.ts',
];

function redact(text: string): string {
  let value = text;
  // Remove values from env variables conventionally used for credentials or connection strings.
  for (const [name, secret] of Object.entries(process.env)) {
    if (secret && secret.length >= 4 && /(?:PASS|TOKEN|SECRET|KEY|CREDENTIAL|DATABASE_URL|CONNECTION|COOKIE|AUTH|URL|URI)/i.test(name)) {
      value = value.split(secret).join('[REDACTED]');
    }
  }
  value = value.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@');
  value = value.replace(/\b(mysql|mariadb|postgres(?:ql)?|redis):\/\/[^\s"'<>]+/gi, '$1://[REDACTED]');
  value = value.replace(/("[^"]*(?:password|passwd|token|secret|api[_-]?key)[^"]*"\s*:\s*")((?:\\.|[^"\\])*)(")/gi, '$1[REDACTED]$3');
  value = value.replace(/('[^']*(?:password|passwd|token|secret|api[_-]?key)[^']*'\s*:\s*')((?:\\.|[^'\\])*)(')/gi, '$1[REDACTED]$3');
  value = value.replace(/((?:password|passwd|token|secret|api[_-]?key)\s*[:=]\s*)(?!["'])[^\s,;}]+/gi, '$1[REDACTED]');
  value = value.replace(/\b(Authorization\s*:\s*Bearer\s+)[^\s,;"']+/gi, '$1[REDACTED]');
  value = value.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[REDACTED]');
  return value;
}
function prereqFailure(s: VerificationSuite, root: string): string | undefined {
  for (const p of s.prerequisites) {
    if (p.kind === 'env' && (p.value === undefined ? !process.env[p.name] : process.env[p.name] !== p.value)) return `missing prerequisite environment marker ${p.name}`;
    if (p.kind === 'file' && !existsSync(path.resolve(root, p.path))) return `missing prerequisite file ${p.path}`;
  }
  return;
}
function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true;
  return isIP(host) === 4 && Number(host.split('.')[0]) === 127;
}
function declaredUrlFailure(s: VerificationSuite): string | undefined {
  const declared = new Set(s.prerequisites.filter((p) => p.kind === 'env').map((p) => p.name));
  for (const name of Object.keys(process.env)) {
    if (/^FLUX_API\d*$/i.test(name) || /^FLUX_PG_URL$/i.test(name) || /(?:DATABASE|DB)(?:_?URL|_?URI)$/i.test(name) || /^FLUX_.*_FIXTURE_URL$/i.test(name)) declared.add(name);
  }
  for (const name of declared) {
    const raw = process.env[name];
    const nameSuggestsUrl = /(?:_URL|_URI)$/i.test(name) || /^FLUX_API\d*$/i.test(name);
    const valueLooksUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw ?? '') || /^file:/i.test(raw ?? '');
    if (!raw || (!nameSuggestsUrl && !valueLooksUrl)) continue;
    let parsed: URL;
    try { parsed = new URL(raw); }
    catch { return `declared ${name === 'FLUX_API' || /API/i.test(name) ? 'API' : 'database'} endpoint is not a valid URL`; }
    const isApi = /API/i.test(name) || /^https?:$/i.test(parsed.protocol) || /^wss?:$/i.test(parsed.protocol);
    const localFileDb = !isApi && parsed.protocol === 'file:' && !parsed.hostname;
    if (!localFileDb && !isLoopback(parsed.hostname)) return `declared ${isApi ? 'API' : 'database'} endpoint must use loopback`;
    if (!isApi) {
      let dbName = parsed.pathname.replace(/^\/+/, '').split('/')[0] ?? '';
      try { dbName = decodeURIComponent(dbName); } catch { return 'declared database name is not a valid URL path'; }
      const nameToCheck = parsed.protocol === 'file:' ? path.basename(parsed.pathname) : dbName;
      if (!nameToCheck || !TEST_DATABASE_PREFIX.test(nameToCheck)) return 'declared database name must start with test_, tests_, flux_test_, or flux_tests_';
    }
  }
  return;
}
const skipLines = (output: string) => output.split(/\r?\n/).map((x) => x.trim()).filter((x) => /^FLUX_VERIFY_SKIP: [^\r\n]+$/.test(x));
export function classifySuiteExit(code: number | null, signal: string | null, output: string, timedOut: boolean, timeoutMs: number, durationMs: number, captureExceeded = false): RunOutcome {
  const safeFullOutput = redact(output);
  const safeOutput = safeFullOutput.slice(-20_000);
  const skips = skipLines(safeFullOutput);
  if (captureExceeded) return { status: 'FAIL', durationMs, exitCode: code, reason: `output exceeded the ${MAX_CAPTURE_BYTES}-byte capture limit`, output: safeOutput };
  if (timedOut) return { status: 'FAIL', durationMs, exitCode: code, reason: `timed out after ${timeoutMs}ms`, output: safeOutput };
  if (code === 0 && skips.length) return { status: 'SKIP', durationMs, exitCode: code, reason: skips[0].slice('FLUX_VERIFY_SKIP: '.length), output: safeOutput };
  if (code === 0) return { status: 'PASS', durationMs, exitCode: 0, output: safeOutput };
  return { status: 'FAIL', durationMs, exitCode: code, reason: signal ? `process ended by ${signal}` : `process exited with code ${code ?? 'unknown'}`, output: safeOutput };
}

export async function runSuite(suite: VerificationSuite, root = process.cwd(), options: RunSuiteOptions = {}): Promise<RunOutcome> {
  if (suite.platform !== 'any' && suite.platform !== platform) return { status: 'SKIP', durationMs: 0, exitCode: null, reason: `requires ${suite.platform}; current platform is ${platform}` };
  const blocked = prereqFailure(suite, root);
  if (blocked) return { status: 'BLOCKED', durationMs: 0, exitCode: null, reason: blocked };
  const unsafeEndpoint = declaredUrlFailure(suite);
  if (unsafeEndpoint) return { status: 'BLOCKED', durationMs: 0, exitCode: null, reason: unsafeEndpoint };
  const ext = path.extname(suite.path).toLowerCase();
  if (!['.ts', '.cjs'].includes(ext)) return { status: 'FAIL', durationMs: 0, exitCode: null, reason: `unsupported suite extension ${ext}` };
  const file = path.resolve(root, suite.path);
  const args = ext === '.ts' ? ['--import', 'tsx', file] : [file];
  const started = Date.now();
  let captureDir: string | undefined, logPath: string, logFd: number;
  try {
    captureDir = mkdtempSync(path.join(options.captureParentDir ?? os.tmpdir(), 'flux-verification-capture-'));
    chmodSync(captureDir, 0o700);
    logPath = path.join(captureDir, 'suite.log');
    logFd = openSync(logPath, 'wx', 0o600);
  } catch (e) {
    if (captureDir) rmSync(captureDir, { recursive: true, force: true });
    return { status: 'FAIL', durationMs: Date.now() - started, exitCode: null, reason: `could not create private capture file: ${redact(e instanceof Error ? e.message : String(e))}` };
  }
  return await new Promise<RunOutcome>((resolve) => {
    let child;
    try { child = spawn(process.execPath, args, { cwd: root, shell: false, stdio: ['ignore', logFd, logFd], windowsHide: true, detached: process.platform !== 'win32' }); }
    catch (e) {
      try { closeSync(logFd); } catch { /* already closed */ }
      rmSync(captureDir, { recursive: true, force: true });
      resolve({ status: 'FAIL', durationMs: Date.now() - started, exitCode: null, reason: `could not start suite: ${redact(e instanceof Error ? e.message : String(e))}` }); return;
    }
    let timedOut = false, captureExceeded = false, settled = false, termination: Promise<void> | undefined;
    const terminateTree = async () => {
      if (child.pid === undefined) return;
      if (process.platform === 'win32') {
        await new Promise<void>((done) => {
          let killer;
          try { killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { shell: false, stdio: 'ignore', windowsHide: true }); }
          catch { child.kill('SIGKILL'); done(); return; }
          killer.once('error', () => { child.kill('SIGKILL'); done(); });
          killer.once('close', () => done());
        });
        return;
      }
      try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
      await new Promise<void>((done) => { setTimeout(done, 200); });
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    };
    const stop = () => { if (!termination) termination = terminateTree(); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, suite.timeoutMs);
    const monitor = setInterval(() => {
      try {
        if (statSync(logPath).size > MAX_CAPTURE_BYTES && !captureExceeded) { captureExceeded = true; stop(); }
      } catch { captureExceeded = true; stop(); }
    }, CAPTURE_POLL_MS);
    const finish = async (code: number | null, signal: NodeJS.Signals | null, spawnError?: Error) => {
      if (settled) return; settled = true;
      clearTimeout(timer); clearInterval(monitor);
      if (termination) await termination;
      let captured = '';
      try {
        const size = statSync(logPath).size;
        if (size > MAX_CAPTURE_BYTES) { captureExceeded = true; ftruncateSync(logFd, MAX_CAPTURE_BYTES); }
        closeSync(logFd);
        captured = readFileSync(logPath).subarray(0, MAX_CAPTURE_BYTES).toString('utf8');
      } catch { captureExceeded = true; try { closeSync(logFd); } catch { /* already closed */ } }
      rmSync(captureDir, { recursive: true, force: true });
      const durationMs = Date.now() - started;
      if (spawnError) resolve({ status: 'FAIL', durationMs, exitCode: null, reason: `could not start suite: ${redact(spawnError.message)}`, output: redact(captured).slice(-20_000) });
      else resolve(classifySuiteExit(code, signal, captured, timedOut, suite.timeoutMs, durationMs, captureExceeded));
    };
    child.once('error', (e) => { void finish(null, null, e); });
    child.once('close', (code, signal) => { void finish(code, signal); });
  });
}

function keyOf(s: VerificationSuite): string {
  // Identical scripts in separate domain manifests run once; their resource locks are unioned.
  return JSON.stringify([s.path, s.layer, s.platform, s.prerequisites, Boolean(s.external)]);
}
function collectJobs(registry: Registry, group?: string): Job[] {
  const selected = registry.manifests.filter((m) => !group || m.group === group);
  const grouped = new Map<string, Job>();
  for (const m of selected) for (const s of m.suites) {
    const key = keyOf(s), current = grouped.get(key);
    if (current) {
      current.aliases.push({ manifest: m, suite: s });
      current.suite.resources = [...new Set([...current.suite.resources, ...s.resources])];
      current.suite.timeoutMs = Math.min(current.suite.timeoutMs, s.timeoutMs);
    } else grouped.set(key, { key, aliases: [{ manifest: m, suite: s }], suite: { ...s, resources: [...s.resources] } });
  }
  return [...grouped.values()];
}
function conflicts(resources: string[], active: Set<string>, activeExclusive: boolean, running: number): boolean {
  const wantsExclusive = resources.includes('exclusive') || resources.some((r) => r.startsWith('exclusive:'));
  if (wantsExclusive && running > 0) return true;
  if (activeExclusive) return true;
  const normalized = resources.filter((r) => r !== 'exclusive' && !r.startsWith('exclusive:')).map((r) => r.startsWith('exclusive:') ? r.slice(10) : r);
  return normalized.some((r) => active.has(r));
}

async function runJobs(jobs: Job[], root: string, limit: number): Promise<Map<string, RunOutcome>> {
  const outcomes = new Map<string, RunOutcome>(), pending = [...jobs], active = new Set<string>();
  let exclusiveActive = false, running = 0;
  await new Promise<void>((resolve) => {
    const pump = () => {
      while (running < limit) {
        const i = pending.findIndex((j) => !conflicts(j.suite.resources, active, exclusiveActive, running));
        if (i < 0) break;
        const [job] = pending.splice(i, 1); const exclusive = job.suite.resources.includes('exclusive') || job.suite.resources.some((r) => r.startsWith('exclusive:'));
        for (const resource of job.suite.resources) if (resource !== 'exclusive' && !resource.startsWith('exclusive:')) active.add(resource);
        if (exclusive) exclusiveActive = true;
        running++;
        void runSuite(job.suite, root).then((result) => {
          outcomes.set(job.key, result);
        }).catch((e) => {
          outcomes.set(job.key, { status: 'FAIL', durationMs: 0, exitCode: null, reason: redact(e instanceof Error ? e.message : String(e)) });
        }).finally(() => {
          for (const resource of job.suite.resources) if (resource !== 'exclusive' && !resource.startsWith('exclusive:')) active.delete(resource);
          if (exclusive) exclusiveActive = false;
          running--; if (!pending.length && !running) resolve(); else pump();
        });
      }
      if (!pending.length && !running) resolve();
    };
    pump();
  });
  return outcomes;
}

function claimRows(checks: VerificationCheck[], results: Map<string, SuiteResult>): Array<{ claim: string; suite: string; layer: VerificationCheck['layer']; status: SuiteStatus }> {
  return checks.flatMap((check) => check.claims.map((claim) => ({ claim, suite: check.suite, layer: check.layer, status: results.get(check.suite)?.status ?? 'BLOCKED' })));
}
function manualRows(items: ManualCheck[]) { return items.map((m) => ({ ...m, status: 'NOT_RUN' as const })); }

function evidenceFiles(registry: Registry, root: string): string[] {
  const files = new Set<string>(registry.manifestFiles);
  for (const manifest of registry.manifests) {
    for (const program of manifest.programs) for (const source of program.sources) files.add(source);
    for (const suite of manifest.suites) {
      files.add(suite.path);
      for (const prerequisite of suite.prerequisites) if (prerequisite.kind === 'file') files.add(prerequisite.path);
    }
    for (const action of manifest.actions) for (const source of action.sources) files.add(source);
    for (const connection of manifest.connections) for (const source of connection.sources) files.add(source);
  }
  for (const file of VERIFICATION_EVIDENCE_FILES) if (existsSync(path.join(root, file))) files.add(file);
  return [...files].map((file) => file.split(path.sep).join('/')).sort();
}

export function computeScopedSourceDigest(root: string, files: string[]): string {
  const hash = createHash('sha256');
  const repoRoot = path.resolve(root);
  const realRoot = realpathSync(repoRoot);
  for (const relative of [...new Set(files)].sort()) {
    const name = Buffer.from(relative.replace(/\\/g, '/'), 'utf8');
    hash.update(name); hash.update(Buffer.from([0]));
    try {
      const absolute = path.resolve(repoRoot, relative);
      if (!absolute.startsWith(`${repoRoot}${path.sep}`)) throw new Error('outside root');
      const realFile = realpathSync(absolute);
      if (!realFile.startsWith(`${realRoot}${path.sep}`)) throw new Error('outside root through symlink');
      const bytes = readFileSync(realFile);
      hash.update(Buffer.from([1]));
      const size = Buffer.alloc(8); size.writeBigUInt64BE(BigInt(bytes.length)); hash.update(size); hash.update(bytes);
    } catch {
      // Keep the digest deterministic while distinguishing a missing/unreadable file from an empty file.
      hash.update(Buffer.from([0]));
    }
    hash.update(Buffer.from([255]));
  }
  return hash.digest('hex');
}

function packageVersion(root: string): string {
  try {
    const realRoot = realpathSync(root), packageFile = realpathSync(path.join(root, 'package.json'));
    if (!packageFile.startsWith(`${realRoot}${path.sep}`)) return 'unknown';
    const parsed = JSON.parse(readFileSync(packageFile, 'utf8')) as { version?: unknown };
    return typeof parsed.version === 'string' && parsed.version.trim() ? parsed.version : 'unknown';
  } catch { return 'unknown'; }
}

export async function runVerification(options: RunOptions = {}): Promise<VerificationReport> {
  const started = new Date();
  const root = path.resolve(options.root ?? process.cwd());
  const registry = loadRegistry(root, options.manifestDir);
  const digestFiles = evidenceFiles(registry, root);
  const scopedSourceDigest = computeScopedSourceDigest(root, digestFiles);
  const appVersion = packageVersion(root);
  const reportPlatform = process.platform;
  const nodeVersion = process.version;
  const selected = registry.manifests.filter((m) => !options.group || m.group === options.group);
  if (options.group && !selected.length) throw new Error(`unknown verification group: ${options.group}`);
  const jobs = collectJobs(registry, options.group);
  if (!jobs.length) throw new Error(`no executable verification suites${options.group ? ` in group ${options.group}` : ''}`);
  const outcomes = await runJobs(jobs, root, Math.max(1, options.concurrency ?? Math.min(6, os.cpus().length || 1)));
  const resultById = new Map<string, SuiteResult>();
  for (const job of jobs) {
    const outcome = outcomes.get(job.key)!;
    for (const { manifest, suite } of job.aliases) resultById.set(suite.id, { id: suite.id, group: manifest.group, path: suite.path, layer: suite.layer, platform: suite.platform, ...outcome });
  }
  // Referenced suites in another, unselected group remain visible as BLOCKED and never execute out of scope.
  for (const manifest of selected) {
    for (const action of manifest.actions) for (const check of action.checks) if (!resultById.has(check.suite)) {
      const target = registry.suites.get(check.suite);
      resultById.set(check.suite, { id: check.suite, group: target?.manifest.group ?? 'unknown', path: target?.suite.path ?? '', layer: check.layer, platform: target?.suite.platform ?? 'any', status: 'BLOCKED', durationMs: 0, exitCode: null, reason: 'suite belongs to a group outside this scoped run' });
    }
    for (const connection of manifest.connections) for (const check of connection.checks) if (!resultById.has(check.suite)) {
      const target = registry.suites.get(check.suite);
      resultById.set(check.suite, { id: check.suite, group: target?.manifest.group ?? 'unknown', path: target?.suite.path ?? '', layer: check.layer, platform: target?.suite.platform ?? 'any', status: 'BLOCKED', durationMs: 0, exitCode: null, reason: 'suite belongs to a group outside this scoped run' });
    }
  }
  const suites = [...resultById.values()];
  const actions = selected.flatMap((m) => m.actions.map((a) => {
    const claims = claimRows(a.checks, resultById);
    return { id: a.id, program: a.program, claims, manual: manualRows(a.manual), status: claims.some((x) => x.status === 'PASS') ? 'PARTIAL' as const : 'UNTESTED' as const };
  }));
  const connections = selected.flatMap((m) => m.connections.map((c) => ({ id: c.id, from: c.from, to: c.to, status: c.status, claims: c.status === 'planned' ? [] : claimRows(c.checks, resultById), manual: manualRows(c.manual), coverage: c.status === 'planned' ? 'EXCLUDED_PLANNED' as const : 'IN_SCOPE' as const })));
  const finishedScopedSourceDigest = computeScopedSourceDigest(root, digestFiles);
  return {
    schemaVersion: 1, startedAt: started.toISOString(), finishedAt: new Date().toISOString(),
    ...(options.group ? { group: options.group } : {}), appVersion, platform: reportPlatform, nodeVersion,
    scopedSourceDigest, finishedScopedSourceDigest, sourceChangedDuringRun: scopedSourceDigest !== finishedScopedSourceDigest,
    suites, actions, connections,
  };
}

export function listVerification(options: Pick<RunOptions, 'root' | 'manifestDir' | 'group'> = {}): { group: string; programs: number; actions: number; connections: number; suites: number }[] {
  const registry = loadRegistry(options.root ?? process.cwd(), options.manifestDir);
  const selected = registry.manifests.filter((m) => !options.group || m.group === options.group);
  if (options.group && !selected.length) throw new Error(`unknown verification group: ${options.group}`);
  return selected.map((m) => ({ group: m.group, programs: m.programs.length, actions: m.actions.length, connections: m.connections.filter((c) => c.status !== 'planned').length, suites: m.suites.length }));
}

export function verificationExitCode(report: VerificationReport): 0 | 1 {
  return !report.suites.length || report.sourceChangedDuringRun || report.suites.some((suite) => suite.status !== 'PASS') ? 1 : 0;
}
