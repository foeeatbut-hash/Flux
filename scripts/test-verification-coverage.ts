import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inventoryCoverage } from '../verification/coverage';
import { registeredRoutes } from '../verification/sourceInventory';

const coverage = inventoryCoverage();
assert.deepEqual(coverage.missingRoutes, [], 'every declared Flux route and special window must have an owner passport');
assert.deepEqual(coverage.emptyPrograms, [], 'every program must declare actual actions');
assert.ok(coverage.summary.programs >= 30, 'registry must include programs and Owner, not only selected visible pages');
assert.ok(coverage.summary.sourceBindings > 0, 'inventory must inspect source controls');
assert.match(coverage.limitation, /INVENTORY_ONLY/, 'inventory cannot claim all buttons passed');
const source = readFileSync('src/workspace/sections.tsx', 'utf8');
const changed = registeredRoutes(source + '\nconst newApp = {path:"/new-verification-fixture-route"};');
assert.ok(changed.includes('/new-verification-fixture-route'), 'new route cannot silently disappear from detection');
assert.ok(!coverage.routes.declared.includes('/new-verification-fixture-route'), 'new route requires a real passport');

const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'flux-coverage-duplicates-'));
try {
  const sectionsDir = path.join(fixtureRoot, 'src/workspace');
  const manifestsDir = path.join(fixtureRoot, 'verification/manifests');
  mkdirSync(sectionsDir, { recursive: true });
  mkdirSync(manifestsDir, { recursive: true });
  writeFileSync(path.join(fixtureRoot, 'src/fixture.tsx'), 'export const Fixture = () => <button onClick={() => {}}>Fixture</button>;');
  const sectionsPath = path.join(sectionsDir, 'sections.tsx');
  writeFileSync(sectionsPath, `const routes = [
  { path: '/fixture-route' },
  { path: '/sticker' },
  { path: '/capture' },
  { path: '/native-app' },
];`);
  const manifest = {
    version: 1,
    group: 'coverage-fixture',
    programs: [{ id: 'fixture', label: 'Fixture', routes: ['/fixture-route', '/sticker', '/capture', '/native-app'], sources: ['src/fixture.tsx'] }],
    suites: [],
    actions: [{ id: 'fixture.open', program: 'fixture', label: 'Open fixture', sources: ['src/fixture.tsx'], triggers: ['button'], risk: 'normal', expected: ['fixture route opens'], checks: [], manual: [] }],
    connections: [],
  };
  writeFileSync(path.join(manifestsDir, 'fixture.json'), JSON.stringify(manifest));

  const uniqueFixture = inventoryCoverage(fixtureRoot);
  assert.equal(uniqueFixture.inventoryValid, true, 'a complete fixture inventory with unique routes is valid');
  assert.deepEqual(uniqueFixture.duplicateRoutes, [], 'unique fixture routes produce no duplicate report');
  writeFileSync(sectionsPath, `const routes = [
  { path: '/fixture-route' },
  { path: '/fixture-route' },
  { path: '/sticker' },
  { path: '/capture' },
  { path: '/native-app' },
];`);
  const duplicateFixture = inventoryCoverage(fixtureRoot);
  assert.equal(duplicateFixture.inventoryValid, false, 'duplicate app route registration invalidates inventory');
  assert.deepEqual(duplicateFixture.duplicateRoutes, ['/fixture-route'], 'duplicate route list identifies the repeated path once');
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}

console.log('✓ Реестр всех маршрутов, отдельных окон, программ и обнаружение нового раздела');
