import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const filename = 'src/components/drafts/DraftsButton.tsx';
const source = readFileSync(filename, 'utf8');
const changed = source.replace('onClick=', 'onDoubleClick=');
if (changed === source) throw new Error('Не найдена точка контрольной мутации кнопки');
function run(script: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', script], { encoding: 'utf8', timeout: 180_000 });
}
try {
  writeFileSync(filename, changed);
  const build = run('scripts/build-drafts-fixture.ts');
  if (build.status !== 0) throw new Error(`Контрольная сборка не завершилась: ${build.stderr}`);
  const result = run('scripts/test-drafts-panel-ui.ts');
  mkdirSync('.cache/drafts-evidence', { recursive: true });
  writeFileSync('.cache/drafts-evidence/button-negative.log', result.stdout + result.stderr);
  if (result.status !== 1 || !result.stderr.includes('waitFor')) {
    throw new Error(`Мутация должна провалить открытие панели, а не окружение: exit=${result.status} ${result.stderr}`);
  }
  console.log('Отрицательная проверка: без открытия кнопкой UI-набор падает (exit 1)');
} finally {
  writeFileSync(filename, source);
}
