import { readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { runSuite } from '../verification/runner';
import type { SuiteResult } from '../verification/contracts';

async function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--report' || !args[1] || args[1].startsWith('--'))) throw new Error('Usage: check-verification.ts [--report FILE]');
  const files = readdirSync('scripts').filter(f => /^test-verification-.*\.(ts|cjs)$/.test(f)).sort();
  if (!files.length) throw new Error('No verification infrastructure/regression tests found');
  const results: SuiteResult[] = [];
  for (const file of files) {
    const suite = { id: file, path: `scripts/${file}`, layer: 'unit' as const, platform: 'any' as const, resources: ['verification-infrastructure'], prerequisites: [], timeoutMs: 120_000 };
    const outcome = await runSuite(suite);
    results.push({ id: suite.id, group: 'infrastructure', path: suite.path, layer: suite.layer, platform: suite.platform, ...outcome });
    if (outcome.status !== 'PASS') console.error(`✗ ${file}: ${outcome.status} ${outcome.reason || ''}\n${outcome.output || ''}`);
  }
  if (args.length) {
    const file = resolve(args[1]); mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, scope: 'Infrastructure and targeted regressions only; not complete app acceptance', generatedAt: new Date().toISOString(), suites: results }, null, 2) + '\n', { mode: 0o600 });
  }
  const failed = results.filter(r => r.status !== 'PASS');
  console.log(`Механизм проверок и регрессии: ${results.length} наборов, ${failed.length} не пройдено.`);
  process.exitCode = failed.length ? 1 : 0;
}
main().catch(e => { console.error(`✗ ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1; });
