/**
 * Пакет экстренного обновления: один файл `.fluxupdate` = подпись владельца + exe.
 *
 * Зачем. Если неудачное обновление ушло всем и обновления через базу больше не
 * работают, владелец передаёт сотрудникам один файл (файлообменником, флешкой),
 * а сотрудник выбирает его в скрытом разделе Flux. Ни сервера, ни входа для
 * этого не нужно: подпись проверяется открытым ключом, зашитым в программу.
 *
 * Устройство файла (текстовая шапка, затем байты exe без изменений):
 *
 *     FLUXPKG1\n
 *     FLUXUPD1.<описание base64url>.<подпись Ed25519 base64url>\n
 *     <exe: ровно `size` байт из подписанного описания>
 *
 * Вторая строка — та самая подпись выпуска, что Studio владельца кладёт в
 * `.flux-sig` и сервер хранит рядом с обновлением (версия, размер, SHA-256
 * exe, electron/updateSignature.ts). Поэтому у экстренного пути нет своего
 * способа подписи, который мог бы разойтись с обычным: проверяет тот же код.
 * Метка первой строки — версия формата: пакет формата новее известного
 * отклоняется словами, а не молча принимается по старым правилам.
 *
 * Exe весит сотни мегабайт: нигде целиком в память не читается — ни при записи
 * пакета, ни при проверке. Хеш считается потоком вместе с копированием.
 *
 * Модуль без Electron: его же подключает Studio владельца (запись пакета) и
 * проверяет scripts/test-emergency-package.ts.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { readUpdateSignature, updateRefusal } from './updateSignature';
import { badPackage } from './updates';

export const PACKAGE_EXTENSION = 'fluxupdate';
/** Формат, который понимает эта сборка; пакет с большим числом — от более новой Studio */
export const PACKAGE_FORMAT = 1;
const MAGIC = 'FLUXPKG';
/** Шапка короткая: подпись ≤ 4096 знаков (electron/updateSignature.ts) и метка */
const MAX_HEAD = 4096 + 64;

/** Отказ с текстом для человека: ничего не установлено, прежний файл на месте */
export class PackageRefusal extends Error {}

export interface PackageInfo {
  version: string;
  size: number;
  sha256: string;
  iat?: number;
  /** Строка подписи как есть: её же получит помощник подмены (electron/applyUpdate.ts) */
  signature: string;
  /** С какого байта файла начинается exe */
  offset: number;
}

const label = () => `${MAGIC}${PACKAGE_FORMAT}\n`;

/** Что за файл по первым байтам: ответ словами, если это не наш пакет */
function headRefusal(head: Buffer): string {
  if (head.length >= 2 && head[0] === 0x4d && head[1] === 0x5a) {
    return 'Это обычный exe без подписи. Экстренно ставится только пакет .fluxupdate, который подписал владелец программы в Flux Studio.';
  }
  const text = head.subarray(0, MAGIC.length + 2).toString('latin1');
  if (!text.startsWith(MAGIC)) return 'Файл не похож на пакет обновления Flux. Нужен файл .fluxupdate от владельца программы.';
  const format = /^(\d+)\n?/.exec(text.slice(MAGIC.length));
  if (!format) return 'Файл не похож на пакет обновления Flux. Нужен файл .fluxupdate от владельца программы.';
  if (Number(format[1]) > PACKAGE_FORMAT) {
    return 'Пакет создан более новой версией Flux Studio, и эта версия Flux не знает его формата. Обновите программу вручную или попросите владельца сохранить пакет прежним форматом.';
  }
  return '';
}

/** Разобрать и проверить шапку пакета. Файл читается только в пределах шапки */
export async function readPackageHeader(file: string, keyHex: string, current: string): Promise<PackageInfo> {
  let handle: fs.promises.FileHandle;
  try { handle = await fs.promises.open(file, 'r'); } catch { throw new PackageRefusal('Файл пакета не открывается. Проверьте, что он на месте и не занят другой программой.'); }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new PackageRefusal('Выбран не файл пакета обновления.');
    const head = Buffer.alloc(Math.min(MAX_HEAD, stat.size));
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    const text = head.subarray(0, bytesRead);
    const bad = headRefusal(text);
    if (bad) throw new PackageRefusal(bad);
    const first = text.indexOf(0x0a);
    const second = first < 0 ? -1 : text.indexOf(0x0a, first + 1);
    if (text.subarray(0, label().length).toString('latin1') !== label() || second < 0) throw new PackageRefusal('Пакет повреждён: не читается шапка с подписью. Попросите владельца сохранить пакет заново.');
    const signature = text.subarray(first + 1, second).toString('latin1');
    if (!keyHex) throw new PackageRefusal('В этой сборке не задан ключ издателя: обновления не ставятся. Установите новую версию вручную.');
    const manifest = readUpdateSignature(signature, keyHex);
    if (!manifest) throw new PackageRefusal('Подпись пакета не подтверждена: его выпустил не владелец программы или файл изменили. Пакет не установлен.');
    const offset = second + 1;
    const have = stat.size - offset;
    if (have < manifest.size) throw new PackageRefusal(`Пакет обрезан: в файле ${have} байт программы вместо ${manifest.size}. Скопируйте файл заново целиком.`);
    if (have > manifest.size) throw new PackageRefusal('В конце пакета лишние данные: файл изменён после подписи. Пакет не установлен.');
    return { version: manifest.version, size: manifest.size, sha256: manifest.sha256, iat: manifest.iat, signature, offset };
  } finally { await handle.close(); }
}

export interface ExtractOptions {
  keyHex: string;
  /** Версия работающей программы: откат на прежнюю или ту же версию не ставится */
  current: string;
  onProgress?: (percent: number) => void;
}

/**
 * Проверить пакет и положить exe из него в `dest`. До успешной проверки `dest`
 * не появляется: поток пишется во временный файл рядом, после сверки размера и
 * SHA-256 с подписью файл переименовывается. Любая неудача стирает временный
 * файл — запускаемого на диске не остаётся.
 */
export async function extractPackage(file: string, dest: string, o: ExtractOptions): Promise<PackageInfo> {
  const info = await readPackageHeader(file, o.keyHex, o.current);
  const early = updateRefusal({ signature: info.signature, version: info.version, current: o.current, size: info.size, sha256: info.sha256, keyHex: o.keyHex });
  if (early) throw new PackageRefusal(early);
  const part = `${dest}.part-${crypto.randomUUID()}`;
  const hash = crypto.createHash('sha256');
  let size = 0; const head: number[] = [];
  const watch = new Transform({ transform(chunk: Buffer, _enc, callback) {
    size += chunk.length; hash.update(chunk);
    for (let i = 0; head.length < 2 && i < chunk.length; i++) head.push(chunk[i]);
    o.onProgress?.(Math.min(100, Math.round(size * 100 / info.size)));
    callback(null, chunk);
  } });
  try {
    // Байты после подписанного размера не читаем вовсе: поток ровно до конца exe
    await pipeline(fs.createReadStream(file, { start: info.offset, end: info.offset + info.size - 1 }), watch, fs.createWriteStream(part, { flags: 'wx', mode: 0o600 }));
    if (size !== info.size) throw new PackageRefusal(`Пакет обрезан: прочитано ${size} байт программы вместо ${info.size}. Скопируйте файл заново целиком.`);
    const bad = badPackage(head, size);
    if (bad) throw new PackageRefusal('В пакете лежит не файл программы. Пакет не установлен.');
    if (hash.digest('hex') !== info.sha256) throw new PackageRefusal('Содержимое пакета не совпадает с подписью: файл повреждён при копировании или подменён. Пакет не установлен.');
    fs.renameSync(part, dest);
    return info;
  } catch (e) {
    try { fs.unlinkSync(part); } catch { /* временного файла могло не быть */ }
    if (e instanceof PackageRefusal) throw e;
    throw new PackageRefusal(`Не удалось прочитать пакет: ${(e as Error)?.message || e}`);
  }
}

export interface WriteOptions {
  /** Подпись выпуска (`FLUXUPD1.…`), выданная ключом владельца без обращения к серверу */
  signature: string;
  /** Открытая половина ключа обновлений: пакет не пишется, если подпись не сходится с ней */
  keyHex: string;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal | null;
}

/**
 * Записать пакет: шапка и exe. Перед записью подпись проверяется открытым
 * ключом, а exe — по размеру и SHA-256 из неё прямо во время копирования, так
 * что пакет, который не примет сама программа, не появится. Запись идёт во
 * временный файл и заменяет итоговый одним переименованием.
 */
export async function writePackage(exe: string, out: string, o: WriteOptions): Promise<PackageInfo> {
  const signature = String(o.signature || '').trim();
  const manifest = readUpdateSignature(signature, o.keyHex);
  if (!manifest) throw new PackageRefusal('Подпись не сходится с открытым ключом обновлений этого хранилища. Пакет не записан.');
  const part = `${out}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  const hash = crypto.createHash('sha256');
  let size = 0;
  const watch = new Transform({ transform(chunk: Buffer, _enc, callback) {
    size += chunk.length; hash.update(chunk);
    if (size > manifest.size) return callback(new PackageRefusal('Файл EXE больше подписанного размера: он изменился после подписи.'));
    o.onProgress?.(size, manifest.size);
    callback(null, chunk);
  } });
  const headText = Buffer.from(`${label()}${signature}\n`, 'latin1');
  try {
    const target = fs.createWriteStream(part, { flags: 'wx', mode: 0o600 });
    await new Promise<void>((resolve, reject) => target.write(headText, e => (e ? reject(e) : resolve())));
    // Шапка уже в потоке записи; конвейер дописывает exe и закрывает файл сам
    await pipeline(fs.createReadStream(exe), watch, target, { signal: o.signal || undefined });
    if (size !== manifest.size || hash.digest('hex') !== manifest.sha256) throw new PackageRefusal('EXE изменился после подписи: размер или SHA-256 не совпадают. Выберите файл заново и подпишите ещё раз.');
    fs.renameSync(part, out);
    return { version: manifest.version, size: manifest.size, sha256: manifest.sha256, iat: manifest.iat, signature, offset: headText.length };
  } catch (e) {
    try { fs.unlinkSync(part); } catch { /* файла могло не быть */ }
    throw e;
  }
}
