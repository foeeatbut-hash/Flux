/** Проверяет чувствительность браузерного набора через временные подмены Vite. */
import { createServer, type Plugin } from 'vite';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import viteConfig from '../vite.config';

const evidence = '/tmp/flux-docflow-negative-evidence';
type Scenario = { name: string; file: string; from: string; to: string; expected: RegExp; test?: string; precondition?: string; fixture?: string; env?: Record<string, string> };
const cases: Scenario[] = [
  { name: 'docflow-screen-route', file: '/scripts/fixtures/windows-explorer-ui.tsx', from: "route.pathname === '/docflow'", to: "new URLSearchParams(location.search).get('screen') === 'docflow'", test: 'scripts/test-docflow-explorer-ui.ts', fixture: '/scripts/fixtures/windows-explorer-ui.tsx', precondition: '✓ «Открыть в ДО» ведёт на строку реестра', expected: /getByRole\('columnheader'.*Файл/s },
  { name: 'empty-files', file: '/src/components/docflow/MaskBuilder.tsx', from: '...scan });', to: '...scan, files: [] });', expected: /getByRole\('table'.*Разбор файлов рабочей папки/s },
  { name: 'fixed-mask', file: '/src/components/docflow/MaskBuilder.tsx', from: 'parseFileName(config, name)', to: "parseFileName({ ...config, masks: { ...config.masks, file: '{шифр}_{ред}' } }, name)", expected: /getByText\('читается'.*detached/s },
  { name: 'ignore-disabled', file: '/src/components/docflow/MaskBuilder.tsx', from: 'const ignored = isIgnored(config, name);', to: 'const ignored = false;', expected: /✗ Исключение применяется до сохранения настроек/ },
  { name: 'list-error-hidden', file: '/src/lib/docflowAssign.ts', from: "if ('error' in answer) throw new Error(answer.error.message || 'Не удалось прочитать папку');", to: "if ('error' in answer) break;", expected: /getByRole\('alert'\).*Нет доступа к рабочей папке/s },
  { name: 'contents-tags', file: '/src/components/files/viewModel.ts', from: "{ id: 'project', label: 'Проект' }, { id: 'storage', label: 'Хранение' },", to: "{ id: 'project', label: 'Проект' }, { id: 'storage', label: 'Хранение' }, { id: 'tags', label: 'Теги' },", test: 'scripts/test-explorer-contents-ui.ts', fixture: '/scripts/fixtures/explorer-shell/contents.tsx', precondition: '✓ Панель виртуально отображает список файлов', expected: /✗ Удалённых локальных столбцов нет/ },
  { name: 'nav-tag', file: '/src/components/files/SearchBox.tsx', from: '<Row label="Тип"><select', to: '<label>Тег<input aria-label="Тег" /></label><Row label="Тип"><select', test: 'scripts/test-explorer-nav-ui.ts', fixture: '/scripts/fixtures/explorer-shell/shell.tsx', precondition: '✓ Доступны фильтры типа, даты, размера и черновиков', expected: /✗ Удалённых фильтров локальных свойств нет/ },
  { name: 'operation-properties', file: '/src/components/files/useExplorerOperations.tsx', from: '<p>Папка назначения проверена полностью.', to: '<label><input type="checkbox" />Перенести теги, проекты</label><p>Папка назначения проверена полностью.', test: 'scripts/test-explorer-operation-ui.ts', fixture: '/scripts/fixtures/explorer-shell/operations.tsx', env: { EXPLORER_UI_SCENARIOS: '1' }, expected: /✗ Перенос удалённых локальных свойств не предлагается/ },
];

async function run(testCase?: Scenario, baseline?: Scenario) {
  const scenario = testCase || baseline;
  const name = testCase?.name || (baseline ? `${baseline.name}-baseline` : 'baseline');
  let transformed = 0;
  const mutation: Plugin = {
    name: 'docflow-mask-negative', enforce: 'pre',
    transform(code, id) {
      if (!testCase || !id.split('?')[0].endsWith(testCase.file)) return;
      if (code.split(testCase.from).length !== 2) throw new Error(`Не найдено единственное место мутации ${testCase.name}`);
      transformed++;
      return code.replace(testCase.from, testCase.to);
    },
  };
  const original = await viteConfig({ command: 'serve', mode: 'test', isSsrBuild: false, isPreview: false });
  const server = await createServer({ ...original, configFile: false, cacheDir: `${evidence}/cache-${name}`,
    plugins: [...(original.plugins || []), mutation],
    server: { ...original.server, host: '127.0.0.1', port: 5199, strictPort: true, hmr: false, watch: null } });
  try {
    await server.listen();
    await server.warmupRequest(scenario?.fixture || '/scripts/fixtures/windows-explorer-ui.tsx');
    await server.waitForRequestsIdle();
    await server.environments.client.depsOptimizer?.scanProcessing;
    const child = spawn(process.execPath, ['--import', 'tsx', scenario?.test || 'scripts/test-docflow-mask-ui.ts'], {
      env: { ...process.env, FLUX_UI_URL: 'http://127.0.0.1:5199', FLUX_CHROME: process.env.FLUX_CHROME || '/usr/bin/chromium', EXPLORER_SHOTS: `${evidence}/shots`, ...scenario?.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', (data) => { log += data; });
    child.stderr.on('data', (data) => { log += data; });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 90000);
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    clearTimeout(timeout);
    await writeFile(`${evidence}/${name}.log`, log);
    const success = testCase ? code !== null && code !== 0 && transformed > 0 && (testCase.test ? (!testCase.precondition || log.includes(testCase.precondition)) : log.includes('✓ Конструктор позволяет проверить рабочую папку')) && testCase.expected.test(log) : code === 0;
    console.log(`${success ? '✓' : '✗'} ${name}: код ${code}, подмен ${transformed}`);
    if (!success) throw new Error(`Неожиданный результат: ${evidence}/${name}.log`);
  } finally { await server.close(); }
}

async function main() {
  await mkdir(evidence, { recursive: true });
  const explorerOnly = process.argv.includes('--explorer');
  if (!explorerOnly) {
    await run();
    for (const testCase of cases.filter((item) => !item.test)) await run(testCase);
  }
  for (const testCase of cases.filter((item) => item.test)) { await run(undefined, testCase); await run(testCase); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
