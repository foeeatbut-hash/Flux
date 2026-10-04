import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { listVerification, runVerification, verificationExitCode } from '../verification/runner.js';

function usage(): never {
  throw new Error('Usage: node --import tsx scripts/verify-programs.ts [--list | --run] [--group NAME] [--report /path/file.json]');
}
function parse(argv: string[]) {
  let mode: 'list' | 'run' = 'list', group: string | undefined, report: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--list') { if (mode === 'run') usage(); mode = 'list'; }
    else if (arg === '--run') { mode = 'run'; }
    else if (arg === '--group') { group = argv[++i]; if (!group || group.startsWith('--')) usage(); }
    else if (arg === '--report') { report = argv[++i]; if (!report || report.startsWith('--')) usage(); }
    else usage();
  }
  if (mode === 'list' && report) usage();
  return { mode, group, report };
}
async function main() {
  const options = parse(process.argv.slice(2));
  if (options.mode === 'list') {
    const groups = listVerification({ group: options.group });
    if (!groups.length) { console.log('No verification manifests found.'); return; }
    for (const g of groups) console.log(`${g.group}: ${g.programs} programs, ${g.actions} actions, ${g.connections} implemented/conditional connections, ${g.suites} suites`);
    return;
  }
  const report = await runVerification({ group: options.group });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (options.report) {
    const target = path.resolve(options.report);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, json, { mode: 0o600 });
    chmodSync(target, 0o600);
  }
  const totals = new Map<string, number>();
  for (const suite of report.suites) totals.set(suite.status, (totals.get(suite.status) ?? 0) + 1);
  console.log([...totals.entries()].map(([status, count]) => `${status} ${count}`).join(', ') || 'No suites selected.');
  console.log(`Evidence scope: validated verification registry; this does not certify the whole application. Version ${report.appVersion}, ${report.platform}, Node ${report.nodeVersion}.`);
  console.log(`Scoped source SHA-256: start ${report.scopedSourceDigest}; finish ${report.finishedScopedSourceDigest}; changed during run: ${report.sourceChangedDuringRun}`);
  if (report.sourceChangedDuringRun) console.log('FAIL: source files changed during the run; this report is not a stable source snapshot.');
  if (options.report) console.log(`Report: ${path.resolve(options.report)}`);
  else console.log(json);
  process.exitCode = verificationExitCode(report);
}
main().catch((e) => { console.error(e instanceof Error ? e.message : 'verification failed'); process.exitCode = 2; });
