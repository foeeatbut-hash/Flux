/**
 * Проверка сборки разработчика Flux Studio: кода владельца в ней нет совсем.
 *
 * Решение владельца: у разработчика раздела владельца нет «физически» — ни
 * скрытого, ни выключенного. Поэтому смотрим на готовый пакет, а не на
 * исходники: пакет, который собрали и отдают, — единственное, что важно.
 * Три независимых признака, любого достаточно для отказа:
 *   1. в карте сборки esbuild есть файл из studio/owner (код попал в бандл);
 *   2. в пакете есть каталоги раздела владельца (owner/, ui/);
 *   3. в тексте любого файла пакета (и app.asar, если дан) есть метка кода
 *      владельца — имена функций подписи лицензий и обновлений, ключевые
 *      строки хранилища и входа владельца.
 *
 *   npx tsx scripts/check-studio-bundle.ts [--dir dist-studio/developer] [--asar release-studio/win-unpacked/resources/app.asar]
 */
import fs from 'node:fs';
import path from 'node:path';

/** Метки, которых нет и не должно быть в коде разработчика. Каждая обязана встречаться в сборке владельца: scripts/test-studio-bundle.ts */
export const OWNER_MARKERS = [
  'signUpdate', 'signUpdateDelegation', 'issueLicense', 'publicConfig', 'authorizeUpdates', 'publishRevocation', 'withdrawUpdate',
  'flux-owner-login', 'FLUXPUBLIC1', 'privatePem', 'vault.flux-owner', 'owner:action', 'generateVaults',
];
const OWNER_DIRECTORIES = ['owner', 'ui'];

function filesOf(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...filesOf(full)); else found.push(full);
  }
  return found;
}

export function checkBundle(dir: string, asar?: string): string[] {
  const problems: string[] = [];
  const app = path.join(dir, 'app');
  if (!fs.existsSync(app)) return [`пакет не найден: ${app}`];

  const metaFile = path.join(dir, 'meta.json');
  if (fs.existsSync(metaFile)) {
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as Record<string, { inputs: Record<string, unknown> }>;
    for (const [part, build] of Object.entries(meta)) {
      for (const input of Object.keys(build.inputs)) {
        if (/^studio\/owner\//.test(input.replace(/\\/g, '/'))) problems.push(`в карте сборки (${part}) есть файл владельца: ${input}`);
      }
    }
  } else problems.push('нет карты сборки meta.json: проверить состав бандла нечем');

  for (const name of OWNER_DIRECTORIES) {
    if (fs.existsSync(path.join(app, name))) problems.push(`в пакете есть каталог раздела владельца: ${name}/`);
  }
  const scan = (label: string, text: string) => {
    for (const marker of OWNER_MARKERS) if (text.includes(marker)) problems.push(`${label}: найдена метка кода владельца «${marker}»`);
  };
  for (const file of filesOf(app)) scan(path.relative(dir, file).replace(/\\/g, '/'), fs.readFileSync(file, 'latin1'));
  if (asar) scan(`asar ${path.basename(asar)}`, fs.readFileSync(asar, 'latin1'));
  return problems;
}

if (require.main === module) {
  const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
  const dir = path.resolve(arg('--dir') || 'dist-studio/developer');
  const asar = arg('--asar');
  const problems = checkBundle(dir, asar ? path.resolve(asar) : undefined);
  if (problems.length) {
    console.error('✗ В сборке разработчика найден код владельца:');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(`✓ Сборка разработчика не содержит кода владельца (${dir}${asar ? ' и ' + path.basename(asar) : ''})`);
}
