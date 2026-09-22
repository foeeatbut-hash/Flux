/**
 * Правила менеджера игр: опись, подпись, пути и состояние установки.
 *
 * Проверяется то, что можно проверить без Windows и без сборки, — и это
 * большая часть опасного. Установка кладёт файлы на диск по присланному
 * списку имён: ошибка здесь стоит не «кнопка не работает», а переписанных
 * чужих файлов. Такую ошибку глазами не находят, её находят проверкой.
 *
 * Чего здесь нет и быть не может: настоящей установки, запуска игры и
 * поведения на Windows. Это проверяется только на машине с оболочкой, и так и
 * написано в документации.
 *
 * Запуск: npx tsx scripts/test-play-games.ts
 */

import {
  canonicalManifest, compareVersions, installState, launchArgs, parseManifest, pathProblem,
  type BuildManifest,
} from '../play/builds';
import { newPublisherKeys, signManifest, verifyManifest } from '../play/node/signature';

let f = 0;
const ok = (name: string, cond: boolean, detail?: unknown) =>
  (cond ? console.log('  ✓', name) : (f++, console.error('  ✗', name, detail === undefined ? '' : JSON.stringify(detail))));

const sha = (n: number) => String(n).padStart(2, '0').repeat(32).slice(0, 64);

const goodManifest = (): BuildManifest => ({
  gameId: 'fluxstrike',
  version: '1.2.0',
  exe: 'FluxStrike.exe',
  files: [
    { path: 'FluxStrike.exe', size: 1024, sha256: sha(1), url: 'files/FluxStrike.exe' },
    { path: 'data/maps/dust.pak', size: 2048, sha256: sha(2), url: 'files/dust.pak' },
  ],
});

console.log('1. Имя из описи — не путь, пока его не проверили');
{
  const bad = [
    '../../Windows/System32/drivers/etc/hosts',
    '..',
    '/etc/passwd',
    'C:/Windows/notepad.exe',
    'data\\maps\\dust.pak',
    'data/../../../secret',
    'кто\u0000то.exe',
    'trailing.',
    'trailing ',
    '',
  ];
  for (const name of bad) ok(`отказ: ${JSON.stringify(name)}`, !!pathProblem(name), pathProblem(name));

  const good = ['FluxStrike.exe', 'data/maps/dust.pak', 'bin/x64/engine-1.2.dll', 'readme file.txt'];
  for (const name of good) ok(`годится: ${name}`, !pathProblem(name), pathProblem(name));
}

console.log('\n2. Опись принимается целиком или не принимается вовсе');
{
  ok('целая опись принята', !!parseManifest(goodManifest()).manifest);

  const noSha: any = goodManifest();
  delete noSha.files[1].sha256;
  ok('без отпечатка — отказ', !parseManifest(noSha).manifest, parseManifest(noSha).problem);

  const twice: any = goodManifest();
  twice.files.push({ ...twice.files[0] });
  ok('файл дважды — отказ', !parseManifest(twice).manifest, parseManifest(twice).problem);

  const noExe: any = goodManifest();
  noExe.exe = 'другой.exe';
  ok('запускаемого файла нет в описи — отказ', !parseManifest(noExe).manifest, parseManifest(noExe).problem);

  const badVersion: any = goodManifest();
  badVersion.version = 'последняя';
  ok('версия не числами — отказ', !parseManifest(badVersion).manifest, parseManifest(badVersion).problem);

  const traversal: any = goodManifest();
  traversal.files[1].path = '../../../windows/system32/kernel32.dll';
  ok('путь вверх по дереву — отказ', !parseManifest(traversal).manifest, parseManifest(traversal).problem);

  const huge: any = goodManifest();
  huge.files[1].size = 9e12;
  ok('размер больше допустимого — отказ', !parseManifest(huge).manifest, parseManifest(huge).problem);

  ok('опись строкой разбирается так же', !!parseManifest(JSON.stringify(goodManifest())).manifest);
}

console.log('\n3. Канонический текст описи не зависит от порядка');
{
  const a = goodManifest();
  const b = goodManifest();
  b.files.reverse();
  ok('порядок файлов ничего не меняет', canonicalManifest(a) === canonicalManifest(b));

  const signed = { ...a, signature: 'ЧТО-УГОДНО' };
  ok('подпись в подписываемый текст не входит', canonicalManifest(signed) === canonicalManifest(a));

  const changed = goodManifest();
  changed.files[0].sha256 = sha(9);
  ok('подмена отпечатка меняет текст', canonicalManifest(changed) !== canonicalManifest(a));
}

console.log('\n4. Подпись издателя');
{
  const keys = newPublisherKeys();
  const other = newPublisherKeys();
  const manifest = goodManifest();
  manifest.signature = signManifest(manifest, keys.privateKey);

  ok('своя подпись сходится', verifyManifest(manifest, keys.publicKey));
  ok('чужой ключ не подходит', !verifyManifest(manifest, other.publicKey));
  ok('без подписи не принимается', !verifyManifest({ ...manifest, signature: undefined }, keys.publicKey));

  // Главное: подменённый файл нельзя провести под старой подписью
  const tampered = { ...manifest, files: manifest.files.map((x, i) => (i ? x : { ...x, sha256: sha(7) })) };
  ok('подменённый отпечаток ломает подпись', !verifyManifest(tampered, keys.publicKey));

  const renamed = { ...manifest, files: manifest.files.map((x, i) => (i ? x : { ...x, path: 'Другой.exe' })) };
  ok('подменённое имя ломает подпись', !verifyManifest(renamed, keys.publicKey));

  ok('ключ не той длины отвергается', !verifyManifest(manifest, 'abc'));
}

console.log('\n5. Версии сравниваются числами, а не буквами');
{
  ok('1.10.0 новее 1.9.0', compareVersions('1.10.0', '1.9.0') > 0);
  ok('1.2 и 1.2.0 — одно и то же', compareVersions('1.2', '1.2.0') === 0);
  ok('предвыпуск старее выпуска', compareVersions('1.2.0-rc1', '1.2.0') < 0);
  ok('rc2 новее rc1', compareVersions('1.2.0-rc2', '1.2.0-rc1') > 0);
}

console.log('\n6. Состояние установки: порядок правил');
{
  ok('ничего не выложено — ставить нечего',
    installState({ published: '', installed: '' }) === 'unavailable');
  ok('выложено, не установлено — «установить»',
    installState({ published: '1.0.0', installed: '' }) === 'absent');
  ok('установлено старое — «обновить»',
    installState({ published: '1.1.0', installed: '1.0.0' }) === 'outdated');
  ok('установлено свежее — «готово»',
    installState({ published: '1.1.0', installed: '1.1.0' }) === 'ready');
  ok('испорченное важнее устаревшего',
    installState({ published: '1.1.0', installed: '1.0.0', intact: false }) === 'broken');
  ok('идущая закачка важнее всего',
    installState({ published: '1.1.0', installed: '1.0.0', intact: false, downloading: true }) === 'downloading');
  ok('пауза важнее закачки',
    installState({ published: '1.1.0', installed: '', downloading: true, paused: true }) === 'paused');
  ok('установлено, а публикацию не спросили — не «устарело»',
    installState({ published: '', installed: '1.0.0' }) === 'ready');
}

console.log('\n7. Пропуск уходит доводами, а не окружением');
{
  const args = launchArgs({ address: '10.0.0.5:27015', ticket: 'one-time', sessionId: 's-1' });
  ok('адрес назван', args.includes('--flux-server') && args.includes('10.0.0.5:27015'));
  ok('пропуск назван', args.includes('--flux-ticket') && args.includes('one-time'));
  ok('матч назван', args.includes('--flux-session') && args.includes('s-1'));
  ok('путь к файлу в доводы не попадает', args.every((a) => !a.includes('..')));
}

console.log(f ? `\nПРОВАЛОВ: ${f}` : '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ');
process.exit(f ? 1 : 0);
