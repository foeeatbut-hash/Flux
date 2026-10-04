import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { inventoryCoverage } from '../verification/coverage';

try {
  const args = process.argv.slice(2);
  const index = args.indexOf('--report');
  if (args.length && (args.length !== 2 || index !== 0 || !args[1] || args[1].startsWith('--'))) throw new Error('Usage: verification-inventory.ts [--report FILE]');
  const report = inventoryCoverage();
  if (index >= 0) {
    const file = resolve(args[index + 1]); mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
  }
  console.log(`Реестр: ${report.summary.programs} программ, ${report.summary.actions} действий, ${report.summary.suiteAliases} ссылок на наборы.`);
  console.log(`Исходные управляющие элементы: ${report.summary.sourceBindings}; действий без автоматического утверждения: ${report.summary.actionsWithoutAutomatedClaim}.`);
  console.log(`Связи: ${report.connections.implemented} реализованных, ${report.connections.conditional} условных, ${report.connections.planned} планируемых.`);
  for (const p of report.programs) console.log(`  ${p.label}: действий ${p.actions}; без автопроверки ${p.withoutAutomatedClaim.length}; ручных сценариев NOT_RUN ${p.manualScenariosNotRun}; source bindings ${p.sourceInventory?.sourceBindings || 0}`);
  console.log('Это инвентаризация. Сценарии и исходные обработчики сами по себе не подтверждают работу кнопок.');
  if (!report.inventoryValid) {
    console.error('✗ Пробелы реестра:', JSON.stringify({ routes: report.missingRoutes, programs: report.emptyPrograms }));
    process.exitCode = 1;
  }
} catch (e) { console.error(`✗ ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1; }
