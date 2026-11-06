import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

/**
 * Отрицательные проверки панели: каждая правка ломает одно поведение, и
 * интерфейсный набор обязан упасть именно на нём, а не из-за окружения.
 * Без этого новая проверка могла бы быть пустой и всё равно зелёной.
 */
const MUTATIONS: Array<{ name: string; file: string; from: string; to: string; expect: string }> = [
  { name: 'button', file: 'src/components/drafts/DraftsButton.tsx', from: 'onClick=', to: 'onDoubleClick=', expect: 'waitFor' },
  { name: 'columns', file: 'src/components/drafts/DraftsCompact.tsx', from: 'repeat(${s.columns}, minmax(0, 1fr))', to: 'repeat(4, minmax(0, 1fr))', expect: 'столбцов плиток' },
  { name: 'state-filter', file: 'src/lib/draftsPanel.ts', from: '(!q.state || draftState(entry, q.openDrafts) === q.state)', to: '(true)', expect: 'фильтр «не в проекте»' },
  { name: 'review', file: 'src/components/drafts/DraftsLayer.tsx', from: '...(reviewing ? { olderThanDays: oldDays } : {}),', to: '', expect: '«Разобрать старые» оставляет только давние' },
];

function run(script: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', script], { encoding: 'utf8', timeout: 240_000 });
}

const only = process.env.ONLY;
mkdirSync('.cache/drafts-evidence', { recursive: true });
for (const mutation of MUTATIONS) {
  if (only && mutation.name !== only) continue;
  const source = readFileSync(mutation.file, 'utf8');
  const changed = source.replace(mutation.from, mutation.to);
  if (changed === source) throw new Error(`Не найдена точка контрольной мутации «${mutation.name}» в ${mutation.file}`);
  try {
    writeFileSync(mutation.file, changed);
    const build = run('scripts/build-drafts-fixture.ts');
    if (build.status !== 0) throw new Error(`Контрольная сборка «${mutation.name}» не завершилась: ${build.stderr}`);
    const result = run('scripts/test-drafts-panel-ui.ts');
    writeFileSync(`.cache/drafts-evidence/${mutation.name}-negative.log`, result.stdout + result.stderr);
    if (result.status !== 1 || !result.stderr.includes(mutation.expect)) {
      throw new Error(`Мутация «${mutation.name}» должна провалить «${mutation.expect}», а не окружение: exit=${result.status} ${result.stderr.slice(0, 600)}`);
    }
    console.log(`Отрицательная проверка «${mutation.name}»: набор падает на «${mutation.expect}» (exit 1)`);
  } finally {
    writeFileSync(mutation.file, source);
  }
}
