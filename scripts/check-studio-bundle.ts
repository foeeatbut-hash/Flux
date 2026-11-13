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
  'signUpdate', 'issueLicense', 'publicConfig', 'publishRevocation', 'withdrawUpdate',
  'FLUXPUBLIC1', 'generateVaults',
  // Разделы владельца, перешедшие из Flux (этап 4в): подпись выпусков и сертификатов, назначение обновлений, окно разделов
  'moduleClaimFor', 'signModule', 'signCampaign', 'console:action', 'FLUXUPDCMD1', 'FLUXUPDAUTH1',
];
/**
 * Вход владельца файлом ключа (решение владельца 11 ноября 2026: одинаковый вход во всех программах) — это не «код владельца»:
 * выбрать файл .flux-owner, расшифровать его паролем и подписать одноразовый запрос сервера. Кода, который что-то выпускает
 * или подписывает для других (лицензии, обновления, подписи выпусков, создание и запись хранилища), здесь нет и не будет.
 * Эти метки обязаны быть в КАЖДОЙ сборке, включая сборку разработчика: без них вход владельца в ней сломан (проверка ниже).
 */
export const OWNER_LOGIN_MARKERS: Record<string, string> = {
  'flux-owner-login': 'studio/shared/ownerKey.ts', privatePem: 'studio/shared/vaultRead.cjs',
  'vault.flux-owner': 'studio/shared/ownerKey.ts', signOwnerChallenge: 'studio/shared/ownerKey.ts',
};
/** Файлы владельца вне studio/owner: общий импорт любого из них тянет код владельца в чужой бандл, даже под другим именем функции */
export const OWNER_PATHS = [
  /^studio\/owner\//, /^license\/ownerKey\.ts$/, /^modules\/trust\/owner\.ts$/, /^modules\/trust\/ownerEdit\.ts$/, /^electron\/ownerLogin\.ts$/,
  /^license\/node\//, /^electron\/updateCommand\.ts$/, /^server\/routes\/owner\.ts$/, /^server\/ownerAuth\.ts$/,
  // Серверная часть владельца: назначение обновлений, очередь запросов на сертификат, снятие разрешений администраторам
  /^server\/routes\/updateCampaigns\.ts$/, /^server\/routes\/moduleCertRequests\.ts$/, /^server\/updateDelegationCleanup\.ts$/,
];
/** Метки кода владельца, который лежит вне studio/owner: у каждой в OUTSIDE_SOURCES указан файл, где она обязана быть (иначе метка устарела) */
export const OUTSIDE_MARKERS: Record<string, string> = {
  buildOwnerRequestClaim: 'modules/trust/owner.ts', buildCertificateClaim: 'modules/trust/owner.ts', buildReleaseClaim: 'modules/trust/owner.ts',
  buildRevocationClaim: 'modules/trust/owner.ts', buildPinClaim: 'modules/trust/owner.ts', buildPromotionClaim: 'modules/trust/owner.ts',
  // Тексты отказов сборщиков подписи переживают переименование функций и файла
  'Описание правки не прошло проверку': 'modules/trust/owner.ts', 'Запрос разработчика повреждён': 'modules/trust/owner.ts',
  'Нужен подписанный владельцем выпуск для пробной группы': 'modules/trust/owner.ts',
  OWNER_PUBLIC_KEY_HEX: 'license/ownerKey.ts', OWNER_BACKUP_PUBLIC_KEY_HEX: 'license/ownerKey.ts', LICENSE_SIGNING_PUBLIC_KEY_HEX: 'license/ownerKey.ts',
};
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
        if (OWNER_PATHS.some((re) => re.test(input.replace(/\\/g, '/')))) problems.push(`в карте сборки (${part}) есть файл владельца: ${input}`);
      }
    }
  } else problems.push('нет карты сборки meta.json: проверить состав бандла нечем');

  for (const name of OWNER_DIRECTORIES) {
    if (fs.existsSync(path.join(app, name))) problems.push(`в пакете есть каталог раздела владельца: ${name}/`);
  }
  // esbuild записывает кириллицу в строках как \uXXXX — для сверки возвращаем читаемый текст
  const readable = (text: string) => text.replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
  const scan = (label: string, raw: string) => {
    const text = raw + '\n' + readable(raw);
    for (const marker of [...OWNER_MARKERS, ...Object.keys(OUTSIDE_MARKERS)]) if (text.includes(marker)) problems.push(`${label}: найдена метка кода владельца «${marker}»`);
  };
  const texts = filesOf(app).map((file) => [path.relative(dir, file).replace(/\\/g, '/'), fs.readFileSync(file, 'latin1')] as const);
  for (const [label, raw] of texts) scan(label, raw);
  // Вход владельца файлом ключа обязан быть: иначе владелец не войдёт в Studio прежним файлом
  const everything = texts.map(([, raw]) => raw).join('\n');
  for (const marker of Object.keys(OWNER_LOGIN_MARKERS)) if (!everything.includes(marker)) problems.push(`в пакете нет входа владельца файлом ключа (не найдена метка «${marker}»)`);
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
