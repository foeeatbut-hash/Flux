/**
 * Выкладка сборки игры: опись, подпись, публикация.
 *
 * Отдельным скриптом, а не окном в программе, — и это решение, а не лень.
 * Подписывающий ключ не должен попадать ни в программу, ни на сервер: оттуда
 * его однажды заберут вместе с резервной копией. Он лежит у владельца, и
 * подписывает владелец — на своей машине, этой командой.
 *
 * Что делает:
 *
 *   ключи   — заводит пару. Открытую половину кладут в Параметрах, закрытую
 *             хранят так же, как ключ лицензии: у себя и нигде больше;
 *   опись   — обходит папку сборки, считает размер и SHA-256 каждого файла;
 *   подпись — подписывает опись закрытым ключом;
 *   выкладка — отправляет опись серверу (сами файлы кладутся на файловый
 *             сервер отдельно, обычным копированием).
 *
 * Примеры:
 *   npx tsx scripts/play-publish.ts keys
 *   npx tsx scripts/play-publish.ts manifest --dir ./build --game fluxstrike \
 *       --version 1.2.0 --exe FluxStrike.exe --base https://сервер/games/fluxstrike/1.2.0/ > manifest.json
 *   FLUX_PUBLISH_KEY=… npx tsx scripts/play-publish.ts sign --manifest manifest.json > signed.json
 *   FLUX_TOKEN=… npx tsx scripts/play-publish.ts push --manifest signed.json \
 *       --url https://сервер/games/fluxstrike/1.2.0/ --server http://localhost:3000
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseManifest, pathProblem, type BuildFile, type BuildManifest } from '../play/builds';
import { newPublisherKeys, signManifest, verifyManifest } from '../play/node/signature';

const args = process.argv.slice(2);
const cmd = args[0] || '';
const flag = (name: string, fallback = ''): string => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? String(args[at + 1] || '') : fallback;
};

const die = (message: string): never => { console.error(message); process.exit(2); };

/** Обойти папку сборки, считая отпечатки. Имена сразу проверяются правилом. */
function collect(dir: string, base: string, prefix = ''): BuildFile[] {
  const out: BuildFile[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(full).isDirectory()) { out.push(...collect(full, base, rel)); continue; }
    const problem = pathProblem(rel);
    if (problem) die(`Файл «${rel}» так назвать нельзя: ${problem}. Переименуйте и повторите.`);
    const data = readFileSync(full);
    out.push({
      path: rel,
      size: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
      url: new URL(rel, base.endsWith('/') ? base : `${base}/`).toString(),
    });
  }
  return out;
}

if (cmd === 'keys') {
  const pair = newPublisherKeys();
  console.log('Открытый ключ (в Параметры → Flux Play):');
  console.log(pair.publicKey);
  console.log('\nЗакрытый ключ (хранить у себя, никуда не выкладывать):');
  console.log(pair.privateKey);
  console.log('\nЗакрытый ключ больше нигде не появится. Потеряете — заведёте новую пару,');
  console.log('и всем, у кого игра уже стоит, придётся поставить её заново.');
  process.exit(0);
}

if (cmd === 'manifest') {
  const dir = flag('dir') || die('Не указана папка сборки: --dir');
  const manifest: BuildManifest = {
    gameId: flag('game') || die('Не указана игра: --game'),
    version: flag('version') || die('Не указана версия: --version'),
    exe: flag('exe') || die('Не указан запускаемый файл: --exe'),
    files: collect(dir, flag('base') || './'),
  };
  const parsed = parseManifest(manifest);
  if (!parsed.manifest) die(`Опись не годится: ${parsed.problem}`);
  console.log(JSON.stringify(parsed.manifest, null, 2));
  process.exit(0);
}

if (cmd === 'sign') {
  const file = flag('manifest') || die('Не указана опись: --manifest');
  const key = process.env.FLUX_PUBLISH_KEY || '';
  if (!/^[0-9a-f]{64}$/.test(key)) die('Нет закрытого ключа: положите его в FLUX_PUBLISH_KEY');
  const parsed = parseManifest(readFileSync(file, 'utf-8'));
  if (!parsed.manifest) die(`Опись не годится: ${parsed.problem}`);
  const signed = { ...parsed.manifest, signature: signManifest(parsed.manifest, key) };
  const out = flag('out');
  const text = JSON.stringify(signed, null, 2);
  if (out) { writeFileSync(out, text, 'utf-8'); console.error(`Подписано: ${out}`); } else { console.log(text); }
  process.exit(0);
}

if (cmd === 'check') {
  const file = flag('manifest') || die('Не указана опись: --manifest');
  const pub = flag('key') || die('Не указан открытый ключ: --key');
  const parsed = parseManifest(readFileSync(file, 'utf-8'));
  if (!parsed.manifest) die(`Опись не годится: ${parsed.problem}`);
  const fits = verifyManifest(parsed.manifest, pub);
  console.log(fits ? 'Подпись сходится.' : 'Подпись НЕ сходится с этим ключом.');
  process.exit(fits ? 0 : 1);
}

if (cmd === 'push') {
  const file = flag('manifest') || die('Не указана опись: --manifest');
  const url = flag('url') || die('Не указан адрес сборки: --url');
  const server = flag('server', 'http://localhost:3000');
  const token = process.env.FLUX_TOKEN || '';
  if (!token) die('Нет токена входа: положите его в FLUX_TOKEN');
  const manifest = JSON.parse(readFileSync(file, 'utf-8'));
  void (async () => {
    const res = await fetch(`${server}/api/play/builds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ manifest, url, channel: flag('channel', 'stable') }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) die(`Сервер не принял сборку: ${data?.error || res.status}`);
    console.log(`Выложено: ${data?.build?.gameId} ${data?.build?.version} (канал ${data?.build?.channel})`);
  })();
} else if (!['keys', 'manifest', 'sign', 'check'].includes(cmd)) {
  console.error('Команды: keys | manifest | sign | check | push');
  console.error('Подробности — в заголовке файла и в docs/play-design.md');
  process.exit(2);
}
