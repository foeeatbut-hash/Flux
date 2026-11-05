import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-docflow-negative-'));
const evidence = path.join(root, '.cache/docflow-evidence');
fs.mkdirSync(evidence, { recursive: true });
// Копии меняют только выбранную зависимость теста; сборка и рабочая копия
// продолжают читать исходные файлы, поэтому мутация не попадёт в продукт.
function imports(source: string, original: string, target: string, replacement: string) {
  return source.replace(/(['"])(\.\.?\/[^'"\r\n]+)\1/g, (_all, _quote, relative) => {
    const resolved = path.resolve(path.dirname(original), relative);
    const normalized = resolved.replace(/\.[cm]?[jt]sx?$/, '');
    const selected = normalized === target.replace(/\.[cm]?[jt]sx?$/, '') ? replacement : resolved;
    return JSON.stringify(selected.split(path.sep).join('/'));
  });
}
const mutations = [
  { id: 'navigation', test: 'scripts/test-docflow-navigation.ts', file: 'src/lib/docflowNavigation.ts',
    change: (s: string) => s.replace('return `/docflow?${next.toString()}`;', 'return null;') },
  { id: 'permission-translation', test: 'scripts/test-docflow-permissions.ts', file: 'shared/docflowPermissions.ts',
    change: (s: string) => s.replace('return result;', 'return { ...source };') },
  { id: 'files-default-deny', test: 'scripts/test-docflow-permissions.ts', file: 'src/lib/permissions.ts',
    change: (s: string) => s.replace("  'docflow.files',\n", '') },
];
try {
  for (const mutation of mutations) {
    const sourcePath = path.resolve(mutation.file), testPath = path.resolve(mutation.test);
    const source = fs.readFileSync(sourcePath, 'utf8'), changed = mutation.change(source);
    if (source === changed) throw new Error(`Нет точки мутации ${mutation.id}`);
    const moduleCopy = path.join(temporary, mutation.id + '.ts');
    const testCopy = path.join(temporary, mutation.id + '-test.ts');
    fs.writeFileSync(moduleCopy, imports(changed, sourcePath, '', ''));
    fs.writeFileSync(testCopy, imports(fs.readFileSync(testPath, 'utf8'), testPath, sourcePath, moduleCopy));
    const result = spawnSync(process.execPath, ['--import', 'tsx', testCopy], {
      cwd: root, encoding: 'utf8', timeout: 60_000,
    });
    fs.writeFileSync(path.join(evidence, mutation.id + '-negative.log'), result.stdout + result.stderr);
    if (result.status !== 1 || !result.stderr.includes('AssertionError')) {
      throw new Error(`Мутация ${mutation.id} не дала ожидаемую ошибку утверждения: ${result.status}\n${result.stderr}`);
    }
    console.log(`✓ ${mutation.id}: без правки новая проверка падает (exit 1)`);
  }
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
