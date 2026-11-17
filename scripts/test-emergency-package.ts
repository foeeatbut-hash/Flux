/**
 * Экстренная установка из подписанного файла: формат пакета `.fluxupdate`, проверка подписи без сервера и входа,
 * отказы, поток без чтения exe в память и установка через помощник подмены.
 *
 * Ключи одноразовые, создаются здесь же: настоящего закрытого ключа в репозитории нет и быть не должно.
 * Запуск: npx tsx scripts/test-emergency-package.ts
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractPackage, PackageRefusal, readPackageHeader, writePackage, PACKAGE_EXTENSION } from '../electron/updatePackage';
import { createEmergencyInstaller } from '../electron/emergencyInstall';
import { APPLY_FLAG, WAIT_FLAG, parseApplyArgs } from '../electron/updates';
import { updateRefusal } from '../electron/updateSignature';

let passed = 0;
const ok = (name: string, value: unknown) => { assert.ok(value, name); passed++; console.log(`  ✓ ${name}`); };
const eq = (name: string, got: unknown, want: unknown) => { assert.deepEqual(got, want, name); passed++; console.log(`  ✓ ${name}`); };

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const pair = () => {
  const p = crypto.generateKeyPairSync('ed25519');
  const der = p.publicKey.export({ format: 'der', type: 'spki' });
  return { priv: p.privateKey, hex: der.subarray(der.length - 32).toString('hex') };
};
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const sign = (priv: crypto.KeyObject, m: object) => {
  const head = `FLUXUPD1.${b64url(JSON.stringify(m))}`;
  return `${head}.${b64url(crypto.sign(null, Buffer.from(head), priv))}`;
};
/** Файл, похожий на exe: MZ и случайные байты; настоящий exe для проверки не нужен — проверяется только поток */
const fakeExe = (size = 5.5 * 1024 * 1024) => { const b = crypto.randomBytes(Math.floor(size)); b[0] = 0x4d; b[1] = 0x5a; return b; };

const owner = pair(), stranger = pair();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-emergency-'));
const exeBytes = fakeExe();
const exeFile = path.join(dir, 'Flux.exe');
fs.writeFileSync(exeFile, exeBytes);
const manifest = { version: '1.30.0', size: exeBytes.length, sha256: sha(exeBytes), iat: Date.now() };
const signature = sign(owner.priv, manifest);
const CURRENT = '1.29.0';

/** После отказа не остаётся ни итогового файла, ни временного */
const leftovers = (d: string) => fs.readdirSync(d).filter(n => n.includes('.part-') || n.endsWith('.tmp') || n === 'out.exe');
const refused = async (name: string, run: () => Promise<unknown>, pattern: RegExp, folder = dir) => {
  await assert.rejects(run, (e: unknown) => e instanceof PackageRefusal && pattern.test(e.message), name);
  eq(`${name}: на диске ничего не осталось`, leftovers(folder), []);
};

async function main() {
  // ---- Запись и чтение пакета
  const pkg = path.join(dir, `Flux-1.30.0.${PACKAGE_EXTENSION}`);
  const written = await writePackage(exeFile, pkg, { signature, keyHex: owner.hex });
  eq('пакет записан: версия и размер из подписи', [written.version, written.size], ['1.30.0', exeBytes.length]);
  const raw = fs.readFileSync(pkg);
  ok('файл начинается меткой формата', raw.subarray(0, 9).toString('latin1') === 'FLUXPKG1\n');
  ok('вторая строка — подпись выпуска без изменений', raw.subarray(9, 9 + signature.length + 1).toString('latin1') === `${signature}\n`);
  ok('exe лежит в конце байт в байт', raw.subarray(raw.length - exeBytes.length).equals(exeBytes));
  ok('закрытого ключа в пакете нет', !raw.includes(owner.priv.export({ format: 'der', type: 'pkcs8' }).subarray(-32)));

  const header = await readPackageHeader(pkg, owner.hex, CURRENT);
  eq('шапка читается и проверяется без сервера', [header.version, header.sha256 === manifest.sha256], ['1.30.0', true]);

  const out = path.join(dir, 'out.exe');
  const progress: number[] = [];
  const info = await extractPackage(pkg, out, { keyHex: owner.hex, current: CURRENT, onProgress: p => progress.push(p) });
  ok('exe извлечён и совпадает с подписанным', fs.readFileSync(out).equals(exeBytes));
  eq('подпись из пакета сходится с обычной проверкой выпуска', updateRefusal({ signature: info.signature, version: info.version, current: CURRENT, size: exeBytes.length, sha256: sha(exeBytes), keyHex: owner.hex }), '');
  ok('ход извлечения доходит до 100', progress.at(-1) === 100);
  eq('временных файлов после успеха нет', leftovers(dir).filter(n => n !== 'out.exe'), []);
  fs.unlinkSync(out);

  // ---- Отказы: каждый — отдельная защита
  const bare = path.join(dir, 'bare.exe');
  fs.writeFileSync(bare, exeBytes);
  await refused('голый exe не принимается', () => extractPackage(bare, out, { keyHex: owner.hex, current: CURRENT }), /обычный exe без подписи/);
  await refused('голый exe с расширением пакета не принимается', async () => { const f = path.join(dir, 'fake.fluxupdate'); fs.writeFileSync(f, exeBytes); await extractPackage(f, out, { keyHex: owner.hex, current: CURRENT }); }, /обычный exe без подписи/);

  const other = path.join(dir, 'stranger.fluxupdate');
  await writePackage(exeFile, other, { signature: sign(stranger.priv, manifest), keyHex: stranger.hex });
  await refused('подпись чужого ключа не принимается', () => extractPackage(other, out, { keyHex: owner.hex, current: CURRENT }), /Подпись пакета не подтверждена/);

  // Подмена версии в описании без закрытого ключа: подпись не сойдётся
  const [prefix, body, sigPart] = signature.split('.');
  const forged = { ...manifest, version: '9.9.9' };
  const forgedFile = path.join(dir, 'forged.fluxupdate');
  fs.writeFileSync(forgedFile, Buffer.concat([Buffer.from(`FLUXPKG1\n${prefix}.${b64url(JSON.stringify(forged))}.${sigPart}\n`, 'latin1'), exeBytes]));
  await refused('изменённое описание при прежней подписи не принимается', () => extractPackage(forgedFile, out, { keyHex: owner.hex, current: CURRENT }), /Подпись пакета не подтверждена/);
  void body;

  const flipped = Buffer.from(raw); flipped[flipped.length - 1000] ^= 0xff;
  const flippedFile = path.join(dir, 'flipped.fluxupdate'); fs.writeFileSync(flippedFile, flipped);
  await refused('изменённый байт exe не принимается (не сходится SHA-256)', () => extractPackage(flippedFile, out, { keyHex: owner.hex, current: CURRENT }), /не совпадает с подписью/);

  for (const [name, cut] of [['на один байт', 1], ['наполовину', Math.floor(exeBytes.length / 2)], ['до одной шапки', exeBytes.length]] as const) {
    const f = path.join(dir, `cut-${cut}.fluxupdate`); fs.writeFileSync(f, raw.subarray(0, raw.length - cut));
    await refused(`пакет, обрезанный ${name}, не принимается`, () => extractPackage(f, out, { keyHex: owner.hex, current: CURRENT }), /обрезан/);
  }
  const tail = path.join(dir, 'tail.fluxupdate'); fs.writeFileSync(tail, Buffer.concat([raw, Buffer.from('lишнее')]));
  await refused('лишние байты в конце не принимаются', () => extractPackage(tail, out, { keyHex: owner.hex, current: CURRENT }), /лишние данные/);

  for (const [name, text, pattern] of [
    ['формат новее известного', `FLUXPKG2\n${signature}\n`, /новее|более новой/],
    ['формат с двумя цифрами', `FLUXPKG10\n${signature}\n`, /более новой/],
    ['нулевой формат', `FLUXPKG0\n${signature}\n`, /не читается шапка|не похож/],
    ['чужая метка', `FLUXZIP1\n${signature}\n`, /не похож на пакет/],
    ['шапка без подписи', 'FLUXPKG1\n', /не читается шапка|Подпись пакета не подтверждена/],
    ['пустая подпись', 'FLUXPKG1\n\n', /Подпись пакета не подтверждена/],
    ['мусор вместо подписи', 'FLUXPKG1\nхлам\n', /Подпись пакета не подтверждена/],
  ] as const) {
    const f = path.join(dir, `bad-${name.length}.fluxupdate`); fs.writeFileSync(f, Buffer.concat([Buffer.from(text, 'latin1'), exeBytes]));
    await refused(`${name}: отказ`, () => extractPackage(f, out, { keyHex: owner.hex, current: CURRENT }), pattern);
  }
  const empty = path.join(dir, 'empty.fluxupdate'); fs.writeFileSync(empty, '');
  await refused('пустой файл не принимается', () => extractPackage(empty, out, { keyHex: owner.hex, current: CURRENT }), /не похож/);
  await refused('нет файла — понятный отказ', () => extractPackage(path.join(dir, 'нет.fluxupdate'), out, { keyHex: owner.hex, current: CURRENT }), /не открывается/);
  await refused('папка вместо файла не принимается', () => extractPackage(dir, out, { keyHex: owner.hex, current: CURRENT }), /не файл|не открывается/);

  await refused('та же версия, что уже стоит, не ставится', () => extractPackage(pkg, out, { keyHex: owner.hex, current: '1.30.0' }), /не новее/);
  await refused('откат на прежнюю версию не ставится', () => extractPackage(pkg, out, { keyHex: owner.hex, current: '1.31.0' }), /не новее/);
  await refused('в сборке без ключа издателя пакет не принимается', () => extractPackage(pkg, out, { keyHex: '', current: CURRENT }), /не задан ключ издателя/);

  // Подпись верна, но внутри не программа: страница или архив под видом exe
  const notExe = Buffer.alloc(exeBytes.length, 7);
  const notExeFile = path.join(dir, 'notexe.fluxupdate');
  fs.writeFileSync(notExeFile, Buffer.concat([Buffer.from(`FLUXPKG1\n${sign(owner.priv, { version: '1.30.0', size: notExe.length, sha256: sha(notExe) })}\n`, 'latin1'), notExe]));
  await refused('подписанный не-exe не принимается', () => extractPackage(notExeFile, out, { keyHex: owner.hex, current: CURRENT }), /не файл программы/);

  // ---- Запись пакета: то, что не примет сама программа, не появляется
  const small = path.join(dir, 'w1.fluxupdate');
  await assert.rejects(writePackage(exeFile, small, { signature: sign(stranger.priv, manifest), keyHex: owner.hex }), /не сходится с открытым ключом/); passed++; console.log('  ✓ запись: подпись другого ключа не пишется');
  await assert.rejects(writePackage(exeFile, small, { signature: '', keyHex: owner.hex }), PackageRefusal); passed++; console.log('  ✓ запись: пустая подпись не пишется');
  const changedExe = path.join(dir, 'Changed.exe'); fs.writeFileSync(changedExe, Buffer.concat([exeBytes.subarray(0, exeBytes.length - 1), Buffer.from([1])]));
  await assert.rejects(writePackage(changedExe, small, { signature, keyHex: owner.hex }), /изменился после подписи/); passed++; console.log('  ✓ запись: exe, изменённый после подписи, не пишется');
  const bigger = path.join(dir, 'Bigger.exe'); fs.writeFileSync(bigger, Buffer.concat([exeBytes, Buffer.from([1])]));
  await assert.rejects(writePackage(bigger, small, { signature, keyHex: owner.hex }), /больше подписанного|изменился после подписи/); passed++; console.log('  ✓ запись: exe длиннее подписанного не пишется');
  eq('запись: после отказов ни пакета, ни временного файла', fs.readdirSync(dir).filter(n => n.startsWith('w1.fluxupdate')), []);

  // ---- Exe не читается в память целиком
  const bigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-emergency-big-'));
  const bigExe = path.join(bigDir, 'Big.exe');
  const fd = fs.openSync(bigExe, 'w');
  const chunk = fakeExe(4 * 1024 * 1024); const hash = crypto.createHash('sha256');
  for (let i = 0; i < 40; i++) { fs.writeSync(fd, chunk); hash.update(chunk); }
  fs.closeSync(fd);
  const bigSig = sign(owner.priv, { version: '1.31.0', size: chunk.length * 40, sha256: hash.digest('hex') });
  global.gc?.();
  const before = process.memoryUsage();
  let peak = 0; const timer = setInterval(() => { const m = process.memoryUsage(); peak = Math.max(peak, m.rss - before.rss); }, 5);
  const bigPkg = path.join(bigDir, 'Big.fluxupdate');
  await writePackage(bigExe, bigPkg, { signature: bigSig, keyHex: owner.hex });
  await extractPackage(bigPkg, path.join(bigDir, 'big-out.exe'), { keyHex: owner.hex, current: CURRENT });
  clearInterval(timer);
  ok(`160 МБ записаны и проверены без чтения в память (рост RSS ${Math.round(peak / 1048576)} МБ)`, peak < 90 * 1048576);
  fs.rmSync(bigDir, { recursive: true, force: true });

  // ---- Установка: подготовка, повторная сверка, помощник подмены
  await installFlow();

  console.log(`\nЭкстренный пакет — ${passed} проверок пройдено`);
}

async function installFlow() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-emergency-inst-'));
  const portable = path.join(tmp, 'Flux-portable.exe'); fs.writeFileSync(portable, 'прежняя программа');
  const make = (over: Partial<Parameters<typeof createEmergencyInstaller>[0]> & { file?: string | null } = {}) => {
    const calls = { spawn: [] as Array<[string, string[]]>, quit: 0, approve: 0, logs: [] as string[] };
    const d = createEmergencyInstaller({
      keyHex: owner.hex, current: () => CURRENT, tempDir: tmp, portableExe: () => portable, pid: 4242,
      pickFile: async () => (over.file === undefined ? path.join(dir, `Flux-1.30.0.${PACKAGE_EXTENSION}`) : over.file),
      spawnHelper: async (exe, args) => { calls.spawn.push([exe, args]); },
      approveClose: async () => { calls.approve++; return true; }, quit: () => { calls.quit++; },
      log: (level, text) => calls.logs.push(`${level} ${text}`), ...over,
    });
    return { d, calls };
  };
  const folders = () => fs.readdirSync(tmp).filter(n => n.startsWith('flux-update-'));

  // Нормальный путь
  {
    const { d, calls } = make();
    const picked = await d.pick();
    ok('выбор: подписанный пакет принят, видна версия', picked.ok && (picked as any).version === '1.30.0' && (picked as any).current === CURRENT);
    ok('до установки помощник не запущен, программа не заменена', calls.spawn.length === 0 && fs.readFileSync(portable, 'utf8') === 'прежняя программа');
    const done: any = await d.install();
    ok('установка запущена и программа закрывается', done.ok && calls.quit === 1 && calls.approve === 1);
    const [exe, args] = calls.spawn[0];
    ok('помощник запущен из проверенного exe', fs.readFileSync(exe).equals(exeBytes));
    const plan = parseApplyArgs(args);
    eq('помощнику переданы цель, ожидание процесса, подпись и прежняя версия', [plan?.target, plan?.waitPid, plan?.signature, plan?.previousVersion], [portable, 4242, signature, CURRENT]);
    ok(`довод ${APPLY_FLAG} и ${WAIT_FLAG} на месте`, args[0] === APPLY_FLAG && args.includes(WAIT_FLAG));
    ok('прежний файл программы не тронут до ухода процесса', fs.readFileSync(portable, 'utf8') === 'прежняя программа');
    d.discard();
  }
  eq('после закрытия раздела временные папки убраны', folders(), []);

  // Отказ человека, голый exe, чужая подпись: ничего не готово и не установлено
  for (const [name, file] of [['отказ в диалоге', null], ['голый exe', bare()], ['чужая подпись', path.join(dir, 'stranger.fluxupdate')], ['обрезанный пакет', path.join(dir, `cut-1.fluxupdate`)]] as const) {
    const { d, calls } = make({ file });
    const r: any = await d.pick();
    ok(`${name}: не принято`, r.ok === false && !d.prepared());
    const inst: any = await d.install();
    ok(`${name}: установка без подготовленного пакета невозможна`, inst.ok === false && calls.spawn.length === 0 && calls.quit === 0);
    eq(`${name}: временных папок нет`, folders(), []);
    if (name === 'голый exe') ok('текст отказа по-русски и объясняет, что нужно', /обычный exe без подписи/.test(r.error));
    if (name === 'отказ в диалоге') ok('отказ в диалоге помечен как отмена, а не ошибка', r.canceled === true);
  }

  // Файл подменили между выбором и установкой
  {
    const { d, calls } = make();
    const picked: any = await d.pick(); assert.ok(picked.ok);
    const staged = fs.readdirSync(tmp).filter(n => n.startsWith('flux-update-')).map(n => path.join(tmp, n, 'Flux-update.exe'))[0];
    const swapped = Buffer.from(exeBytes); swapped[5000] ^= 1; fs.writeFileSync(staged, swapped);
    const r: any = await d.install();
    ok('подмена файла между шагами обнаружена, помощник не запущен', r.ok === false && /не совпадает|Скачанный файл/.test(r.error) && calls.spawn.length === 0 && calls.quit === 0);
    eq('и временная папка убрана', folders(), []);
  }
  // Окна не согласились закрыться
  {
    const { d, calls } = make({ approveClose: async () => false });
    await d.pick();
    const r: any = await d.install();
    ok('несохранённые правки: установка отложена без запуска помощника', r.ok === false && r.deferred === true && calls.spawn.length === 0 && calls.quit === 0);
    ok('отложенное можно повторить', d.prepared());
    d.discard();
  }
  // Не портативная сборка
  {
    const { d, calls } = make({ portableExe: () => '' });
    await d.pick();
    const r: any = await d.install();
    ok('не портативная сборка: честный отказ, ничего не запущено', r.ok === false && /портативной сборке/.test(r.error) && calls.spawn.length === 0);
    d.discard();
  }
  // Помощник не запустился
  {
    const { d, calls } = make({ spawnHelper: async () => { throw new Error('ENOENT'); } });
    await d.pick();
    const r: any = await d.install();
    ok('сбой запуска помощника: программа не закрывается, прежняя на месте', r.ok === false && /Прежняя программа на месте/.test(r.error) && calls.quit === 0);
    d.discard();
  }
  // Работает без сервера и входа: модуль не знает ни о сети, ни о сессии
  const source = fs.readFileSync(path.join(__dirname, '..', 'electron', 'emergencyInstall.ts'), 'utf8') + fs.readFileSync(path.join(__dirname, '..', 'electron', 'updatePackage.ts'), 'utf8');
  ok('логика экстренной установки не обращается ни к сети, ни к базе, ни к сессии', !/\bfetch\b|node:https?|localhost|readNativeSession|authStorage|prisma|\/api\//.test(source));
  fs.rmSync(tmp, { recursive: true, force: true });
}
function bare() { return path.join(dir, 'bare.exe'); }

main().then(() => fs.rmSync(dir, { recursive: true, force: true }), e => { console.error(e); fs.rmSync(dir, { recursive: true, force: true }); process.exit(1); });
