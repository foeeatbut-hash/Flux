import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { CONNECTION_STATUSES, LAYERS, PLATFORMS, type ConnectionStatus, type Layer, type Platform, type Prerequisite, type VerificationManifest, type VerificationSuite } from './contracts.js';

export interface Registry { manifests: VerificationManifest[]; manifestFiles: string[]; suites: Map<string, { manifest: VerificationManifest; suite: VerificationSuite }> }
export class ManifestError extends Error {
  constructor(readonly issues: string[]) { super(`Invalid verification manifests:\n${issues.map((x) => `- ${x}`).join('\n')}`); this.name = 'ManifestError'; }
}
const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const str = (x: unknown): x is string => typeof x === 'string' && x.trim().length > 0;
const arr = (x: unknown): x is unknown[] => Array.isArray(x);
const idOk = (x: unknown) => str(x) && /^[a-z0-9][a-z0-9._-]*$/.test(x);

function safeRepoFile(root: string, rel: unknown, label: string, issues: string[], mustExist = true): void {
  if (!str(rel) || path.isAbsolute(rel) || rel.split(/[\\/]/).some((part) => part === '..' || part === '.')) {
    issues.push(`${label}: path must be a safe repository-relative path`); return;
  }
  const full = path.resolve(root, rel);
  if (!full.startsWith(`${path.resolve(root)}${path.sep}`)) { issues.push(`${label}: path escapes repository`); return; }
  try {
    const realRoot = realpathSync(root);
    let existing = full;
    while (!existsSync(existing) && path.dirname(existing) !== existing) existing = path.dirname(existing);
    const realExisting = realpathSync(existing);
    if (!realExisting.startsWith(`${realRoot}${path.sep}`) && realExisting !== realRoot) { issues.push(`${label}: path escapes repository through a symlink`); return; }
    if (mustExist) {
      const realFile = realpathSync(full);
      if (!realFile.startsWith(`${realRoot}${path.sep}`) || !statSync(realFile).isFile()) issues.push(`${label}: must resolve to a repository file`);
    }
  } catch { if (mustExist) issues.push(`${label}: file does not exist (${rel})`); }
}
function stringArray(x: unknown, label: string, issues: string[], nonempty = true): x is string[] {
  if (!arr(x) || (nonempty && !x.length) || x.some((v) => !str(v))) { issues.push(`${label}: expected ${nonempty ? 'a non-empty' : 'a'} string array`); return false; }
  return true;
}
function checkPrerequisite(p: unknown, prefix: string, root: string, issues: string[]): p is Prerequisite {
  if (!record(p)) { issues.push(`${prefix}: expected prerequisite object`); return false; }
  if (p.kind === 'env') {
    if (!str(p.name) || !/^[A-Z_][A-Z0-9_]*$/.test(p.name) || (p.value !== undefined && typeof p.value !== 'string')) { issues.push(`${prefix}: env prerequisite requires a valid name and optional exact value`); return false; }
    return true;
  }
  if (p.kind === 'file') { safeRepoFile(root, p.path, `${prefix}.path`, issues, false); return str(p.path); }
  issues.push(`${prefix}: kind must be env or file`); return false;
}

function validateManifest(raw: unknown, file: string, root: string, issues: string[]): VerificationManifest | undefined {
  const at = file;
  if (!record(raw)) { issues.push(`${at}: manifest must be an object`); return; }
  if (raw.version !== 1) issues.push(`${at}: version must be 1`);
  if (!idOk(raw.group)) issues.push(`${at}: group must be a stable lowercase ID`);
  for (const key of ['programs', 'suites', 'actions', 'connections']) if (!arr(raw[key])) issues.push(`${at}: ${key} must be an array`);
  if (!arr(raw.programs) || !arr(raw.suites) || !arr(raw.actions) || !arr(raw.connections)) return;
  const validCheck = (x: unknown, label: string): boolean => {
    if (!record(x) || !idOk(x.suite) || !LAYERS.includes(x.layer as Layer) || !stringArray(x.claims, `${label}.claims`, issues)) {
      if (!record(x)) issues.push(`${label}: expected check object`);
      else if (!idOk(x.suite)) issues.push(`${label}.suite: invalid suite ID`);
      else if (!LAYERS.includes(x.layer as Layer)) issues.push(`${label}.layer: unknown layer`);
      return false;
    }
    return true;
  };
  const validManual = (x: unknown, label: string): boolean => {
    if (!record(x)) { issues.push(`${label}: expected manual scenario object`); return false; }
    if (!LAYERS.includes(x.layer as Layer) || !str(x.scenario) || !stringArray(x.expected, `${label}.expected`, issues)) {
      if (!LAYERS.includes(x.layer as Layer)) issues.push(`${label}.layer: unknown layer`);
      if (!str(x.scenario)) issues.push(`${label}.scenario: expected non-empty string`);
      return false;
    }
    return true;
  };
  const suites: VerificationSuite[] = [];
  raw.suites.forEach((x, i) => {
    const label = `${at}.suites[${i}]`;
    if (!record(x)) { issues.push(`${label}: expected object`); return; }
    if (!idOk(x.id)) issues.push(`${label}.id: invalid stable ID`);
    safeRepoFile(root, x.path, `${label}.path`, issues);
    if (!LAYERS.includes(x.layer as Layer)) issues.push(`${label}.layer: unknown layer`);
    if (!PLATFORMS.includes(x.platform as Platform)) issues.push(`${label}.platform: unknown platform`);
    if (!stringArray(x.resources, `${label}.resources`, issues, false)) { /* reported */ }
    if (!arr(x.prerequisites)) issues.push(`${label}.prerequisites: expected array`);
    else x.prerequisites.forEach((p, j) => checkPrerequisite(p, `${label}.prerequisites[${j}]`, root, issues));
    if (!Number.isInteger(x.timeoutMs) || (x.timeoutMs as number) < 1 || (x.timeoutMs as number) > 24 * 60 * 60_000) issues.push(`${label}.timeoutMs: expected integer from 1 to 86400000`);
    if (x.external !== undefined && typeof x.external !== 'boolean') issues.push(`${label}.external: expected boolean`);
    if (x.external === true) {
      const marked = arr(x.prerequisites) && x.prerequisites.some((p) => record(p) && p.kind === 'env' && typeof p.name === 'string' && /^FLUX_TEST_(?:ISOLATED|SANDBOX|FIXTURE)(?:_|$)/.test(p.name) && p.value === '1');
      if (!marked) issues.push(`${label}: external suite requires an explicit FLUX_TEST_* safety-marker env prerequisite`);
    }
    if (idOk(x.id) && str(x.path) && LAYERS.includes(x.layer as Layer) && PLATFORMS.includes(x.platform as Platform) && arr(x.resources) && arr(x.prerequisites) && Number.isInteger(x.timeoutMs)) {
      suites.push({ id: x.id as string, path: x.path as string, layer: x.layer as Layer, platform: x.platform as Platform, resources: x.resources as string[], prerequisites: x.prerequisites as Prerequisite[], timeoutMs: x.timeoutMs as number, ...(x.external === true ? { external: true } : {}) });
    }
  });
  const programs = raw.programs;
  programs.forEach((x, i) => {
    const label = `${at}.programs[${i}]`;
    if (!record(x)) { issues.push(`${label}: expected object`); return; }
    if (!idOk(x.id)) issues.push(`${label}.id: invalid stable ID`);
    if (!str(x.label)) issues.push(`${label}.label: expected non-empty string`);
    if (!stringArray(x.routes, `${label}.routes`, issues, false)) { /* reported */ }
    if (!stringArray(x.sources, `${label}.sources`, issues)) { /* reported */ } else (x.sources as string[]).forEach((p, j) => safeRepoFile(root, p, `${label}.sources[${j}]`, issues));
  });
  raw.actions.forEach((x, i) => {
    const label = `${at}.actions[${i}]`;
    if (!record(x)) { issues.push(`${label}: expected object`); return; }
    if (!idOk(x.id)) issues.push(`${label}.id: invalid stable ID`);
    if (!idOk(x.program)) issues.push(`${label}.program: invalid program ID`);
    if (!str(x.label)) issues.push(`${label}.label: expected non-empty string`);
    if (!stringArray(x.sources, `${label}.sources`, issues)) { /* reported */ } else (x.sources as string[]).forEach((p, j) => safeRepoFile(root, p, `${label}.sources[${j}]`, issues));
    for (const k of ['triggers', 'expected']) stringArray(x[k], `${label}.${k}`, issues);
    if (!['critical', 'normal', 'cosmetic'].includes(String(x.risk))) issues.push(`${label}.risk: unknown risk`);
    if (!arr(x.checks)) issues.push(`${label}.checks: expected array`); else x.checks.forEach((v, j) => validCheck(v, `${label}.checks[${j}]`));
    if (!arr(x.manual)) issues.push(`${label}.manual: expected array`); else x.manual.forEach((v, j) => validManual(v, `${label}.manual[${j}]`));
  });
  raw.connections.forEach((x, i) => {
    const label = `${at}.connections[${i}]`;
    if (!record(x)) { issues.push(`${label}: expected object`); return; }
    if (!idOk(x.id)) issues.push(`${label}.id: invalid stable ID`);
    if (!idOk(x.from) || !idOk(x.to)) issues.push(`${label}: from and to must be program IDs`);
    if (!CONNECTION_STATUSES.includes(x.status as ConnectionStatus)) issues.push(`${label}.status: unknown connection status`);
    if (!stringArray(x.sources, `${label}.sources`, issues)) { /* reported */ } else (x.sources as string[]).forEach((p, j) => safeRepoFile(root, p, `${label}.sources[${j}]`, issues));
    stringArray(x.expected, `${label}.expected`, issues);
    if (!arr(x.checks)) issues.push(`${label}.checks: expected array`); else x.checks.forEach((v, j) => validCheck(v, `${label}.checks[${j}]`));
    if (!arr(x.manual)) issues.push(`${label}.manual: expected array`); else x.manual.forEach((v, j) => validManual(v, `${label}.manual[${j}]`));
  });
  return {
    version: 1, group: str(raw.group) ? raw.group : path.basename(file, '.json'),
    programs: programs as VerificationManifest['programs'], suites,
    actions: raw.actions as VerificationManifest['actions'], connections: raw.connections as VerificationManifest['connections'],
  };
}

export function loadRegistry(root = process.cwd(), manifestDir = path.join(root, 'verification', 'manifests')): Registry {
  const issues: string[] = [];
  const files = existsSync(manifestDir) ? readdirSync(manifestDir).filter((f) => f.endsWith('.json')).sort().map((f) => path.join(manifestDir, f)) : [];
  if (!files.length) throw new ManifestError([`${path.relative(root, manifestDir) || manifestDir}: no verification manifests found`]);
  const manifests: VerificationManifest[] = [];
  for (const file of files) {
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(file, 'utf8')); }
    catch (e) { issues.push(`${path.relative(root, file)}: invalid JSON (${e instanceof Error ? e.message : 'parse error'})`); continue; }
    const manifest = validateManifest(raw, path.relative(root, file), root, issues);
    if (manifest) manifests.push(manifest);
  }
  const unique = (label: string, values: string[]) => {
    const seen = new Set<string>();
    for (const value of values) { if (seen.has(value)) issues.push(`duplicate ${label} ID: ${value}`); seen.add(value); }
  };
  unique('group', manifests.map((m) => m.group));
  unique('program', manifests.flatMap((m) => m.programs.map((x) => x.id)));
  unique('suite', manifests.flatMap((m) => m.suites.map((x) => x.id)));
  unique('action', manifests.flatMap((m) => m.actions.map((x) => x.id)));
  unique('connection', manifests.flatMap((m) => m.connections.map((x) => x.id)));
  const programs = new Set(manifests.flatMap((m) => m.programs.map((x) => x.id)));
  const routeOwners = new Map<string, string>();
  for (const manifest of manifests) for (const program of manifest.programs) for (const route of program.routes) {
    const owner = routeOwners.get(route);
    if (owner && owner !== program.id) issues.push(`route ${route}: owned by more than one program (${owner}, ${program.id})`);
    else routeOwners.set(route, program.id);
  }
  const suites = new Map(manifests.flatMap((m) => m.suites.map((s) => [s.id, { manifest: m, suite: s }] as const)));
  for (const m of manifests) {
    for (const a of m.actions) {
      if (!programs.has(a.program)) issues.push(`action ${a.id}: unknown program ${a.program}`);
      for (const c of a.checks) {
        const target = suites.get(c.suite);
        if (!target) issues.push(`action ${a.id}: unknown suite ${c.suite}`);
        else if (target.suite.layer !== c.layer) issues.push(`action ${a.id}: suite ${c.suite} layer mismatch (${c.layer} vs ${target.suite.layer})`);
      }
    }
    for (const c of m.connections) {
      if (!programs.has(c.from)) issues.push(`connection ${c.id}: unknown source program ${c.from}`);
      if (!programs.has(c.to)) issues.push(`connection ${c.id}: unknown destination program ${c.to}`);
      for (const check of c.checks) {
        const target = suites.get(check.suite);
        if (!target) issues.push(`connection ${c.id}: unknown suite ${check.suite}`);
        else if (target.suite.layer !== check.layer) issues.push(`connection ${c.id}: suite ${check.suite} layer mismatch (${check.layer} vs ${target.suite.layer})`);
      }
    }
  }
  if (issues.length) throw new ManifestError(issues);
  return { manifests, manifestFiles: files.map((file) => path.relative(root, file)).sort(), suites };
}
