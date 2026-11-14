/**
 * Файл хранилища самостоятельной программы на диске: путь, конверт, атомарная запись, битый файл, удаление.
 *
 * Только главный процесс (Flux и Studio): `node:path` и `node:crypto`. Над переданным `fs` (в проверках — настоящий `fs.promises`
 * во временной папке, иногда с подставленным отказом), а не над глобальным: так одна и та же логика проверяется на сбоях диска.
 *
 * Данные человека: правила `flux-data-safety`. Ничего не удаляется по списку или фрагменту — только точный путь, который
 * `storagePath` собирает из проверенных частей; предел проверяется здесь, а не только в окне; запись сначала во временный файл
 * и только потом переименование, поэтому обрыв посреди записи не портит прежнее состояние; файл, который не удалось прочитать
 * как свой, откладывается рядом (`state.broken-…json`), а не затирается.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { PROGRAM_ID } from '../programs/model';
import {
  STORAGE_FILE, STORAGE_FORMAT, STORAGE_LIMIT_BYTES, STORAGE_SCOPES, isPlainObject, stateBytes,
  type StorageErrorCode, type StorageScope,
} from './model';

/** Подмножество `fs.promises`, которое нужно хранилищу (поэтому в проверках диск можно ломать точечно) */
export interface StorageFs {
  mkdir(p: string, options: { recursive: true }): Promise<unknown>;
  readFile(p: string, encoding: 'utf8'): Promise<string>;
  writeFile(p: string, data: string, options: { encoding: 'utf8'; flag: 'wx' }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  rm(p: string, options: { recursive: true; force: true }): Promise<void>;
  rmdir(p: string): Promise<void>;
  lstat(p: string): Promise<{ size: number; isFile(): boolean; isSymbolicLink(): boolean; isDirectory(): boolean }>;
}

/** Где лежит хранилище: корень (`<данные приложения>/program-data`), человек, программа, область */
export interface StorageTarget { root: string; userId: string; programId: string; scope: StorageScope }

const USER_DIR_LENGTH = 32;
/** Папка человека: первые 32 знака sha256 от идентификатора пользователя Flux — сам идентификатор в имени папки не нужен */
export const userDirName = (userId: string) => createHash('sha256').update(userId, 'utf8').digest('hex').slice(0, USER_DIR_LENGTH);

/**
 * Папка области программы у человека. Идентификатор программы и область проверяются по образцу, идентификатор человека —
 * непустая строка: ничто, пришедшее от окна или из манифеста, не может вывести путь за пределы корня.
 */
export function storagePath(root: string, userId: string, programId: string, scope: StorageScope): string {
  if (!root || typeof userId !== 'string' || !userId) throw new Error('storage: не указан корень или человек');
  if (typeof programId !== 'string' || !PROGRAM_ID.test(programId)) throw new Error('storage: неверный идентификатор программы');
  if (!STORAGE_SCOPES.includes(scope)) throw new Error('storage: неверная область');
  return path.join(root, userDirName(userId), programId, scope);
}
const dirOf = (t: StorageTarget) => storagePath(t.root, t.userId, t.programId, t.scope);

/** Что лежит в `state.json` */
export interface StorageEnvelope { format: number; program: string; writtenBy: string; savedAt: string; state: Record<string, unknown> }

export type ReadResult =
  | { ok: true; state: Record<string, unknown>; bytes: number; savedAt: string | null; broken?: { kept: string } }
  | { ok: false; code: 'FAILED' };
/** `reason` — код и текст первой ошибки диска для журнала и проверок (человеку не показывается): без него «FAILED» на чужом компьютере не разобрать */
export type WriteResult = { ok: true; bytes: number; broken?: { kept: string } } | { ok: false; code: StorageErrorCode; bytes?: number; reason?: string };
const reasonOf = (e: unknown) => { const err = e as NodeJS.ErrnoException | undefined; return `${err?.code ?? 'ERR'}: ${String(err?.message ?? e).slice(0, 200)}`; };

const isMissing = (e: unknown) => (e as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
/** Файл крупнее предела состояния с запасом на конверт не может быть нашим: читать его целиком незачем */
const MAX_FILE_BYTES = STORAGE_LIMIT_BYTES + 16 * 1024;

type Inspect = { kind: 'missing' } | { kind: 'ok'; envelope: StorageEnvelope; bytes: number } | { kind: 'broken' } | { kind: 'error' };

/** Разбор файла: «нет», «наш и цел», «битый или чужого формата» (его откладывают) или «диск не отвечает» (его не трогают) */
async function inspect(fs: StorageFs, file: string, programId: string): Promise<Inspect> {
  let info: Awaited<ReturnType<StorageFs['lstat']>>;
  try { info = await fs.lstat(file); } catch (e) { return isMissing(e) ? { kind: 'missing' } : { kind: 'error' }; }
  // Ссылка, папка и гигантский файл на месте `state.json` — не наш файл; ссылку не читаем: она может вести куда угодно
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES) return { kind: 'broken' };
  let text: string;
  try { text = await fs.readFile(file, 'utf8'); } catch (e) { return isMissing(e) ? { kind: 'missing' } : { kind: 'error' }; }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { kind: 'broken' }; }
  if (!isPlainObject(parsed) || parsed.format !== STORAGE_FORMAT || parsed.program !== programId
    || typeof parsed.writtenBy !== 'string' || typeof parsed.savedAt !== 'string' || !isPlainObject(parsed.state)) return { kind: 'broken' };
  const bytes = stateBytes(parsed.state);
  if (bytes === null || bytes > STORAGE_LIMIT_BYTES) return { kind: 'broken' };
  return { kind: 'ok', envelope: parsed as unknown as StorageEnvelope, bytes };
}

/** Откладывает негодный файл рядом; имя с временем, повтор в ту же миллисекунду получает номер. Не получилось — `null` */
async function setAside(fs: StorageFs, dir: string, now: Date): Promise<string | null> {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('.', '-').replace('Z', '');
  for (let n = 0; n < 20; n++) {
    const name = `state.broken-${stamp}${n ? `-${n + 1}` : ''}.json`;
    const target = path.join(dir, name);
    // Занятое имя не перезаписывается: прежний отложенный файл тоже чей-то
    try { await fs.lstat(target); continue; } catch (e) { if (!isMissing(e)) return null; }
    try { await fs.rename(path.join(dir, STORAGE_FILE), target); return name; } catch { return null; }
  }
  return null;
}

/**
 * Читает состояние. Нет файла — пустое состояние. Битый, чужого формата или чужой программы файл откладывается в
 * `state.broken-<время>.json`, программа получает пустое состояние, а вызывающий записывает строку в журнал программ.
 * Если и отложить не удалось, то состояние не отдаётся вовсе (`FAILED`): иначе следующая запись затёрла бы файл.
 */
export async function readEnvelope(fs: StorageFs, target: StorageTarget, options: { now?: Date } = {}): Promise<ReadResult> {
  const dir = dirOf(target);
  return withLock(dir, () => readLocked(fs, target, dir, options));
}
async function readLocked(fs: StorageFs, target: StorageTarget, dir: string, options: { now?: Date }): Promise<ReadResult> {
  const found = await inspect(fs, path.join(dir, STORAGE_FILE), target.programId);
  if (found.kind === 'missing') return { ok: true, state: {}, bytes: 0, savedAt: null };
  if (found.kind === 'error') return { ok: false, code: 'FAILED' };
  if (found.kind === 'ok') return { ok: true, state: found.envelope.state, bytes: found.bytes, savedAt: found.envelope.savedAt };
  const kept = await setAside(fs, dir, options.now ?? new Date());
  return kept ? { ok: true, state: {}, bytes: 0, savedAt: null, broken: { kept } } : { ok: false, code: 'FAILED' };
}

/**
 * Работы с одной областью идут по очереди внутри процесса. На Windows переименование временного файла поверх целевого, пока другое
 * переименование в тот же файл не закончилось, отказывает (EPERM/EBUSY); на Linux гонка тихо проходит и скрывает ту же ошибку.
 * Окна одной программы пишут одновременно, поэтому очередь здесь, у самого файла, а не только у вызывающего.
 */
const locks = new Map<string, Promise<unknown>>();
function withLock<T>(key: string, job: () => Promise<T>): Promise<T> {
  const run = (locks.get(key) ?? Promise.resolve()).then(job, job);
  const tail = run.then(() => undefined, () => undefined);
  locks.set(key, tail);
  // Очередь не копится по мёртвым путям: пока никто не встал следом, запись о ней убирается
  void tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  return run;
}
/** Антивирус и индексатор Windows ненадолго держат только что записанный файл: переименование повторяется, а не сдаётся с первого раза */
const RENAME_RETRY = ['EPERM', 'EBUSY', 'EACCES'];
async function renameWithRetry(fs: StorageFs, from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await fs.rename(from, to); return; }
    catch (e) {
      if (attempt >= 5 || !RENAME_RETRY.includes((e as NodeJS.ErrnoException | undefined)?.code ?? '')) throw e;
      await new Promise(resolve => setTimeout(resolve, 15 * (attempt + 1)));
    }
  }
}

let counter = 0;
/**
 * Записывает состояние целиком. Предел проверяется здесь: `LIMIT` — и ничего на диске не тронуто (прежнее состояние цело).
 * Запись атомарная: временный файл рядом, потом переименование; любой сбой — `FAILED`, временный файл убирается, прежний файл цел.
 * Лежащий на месте негодный файл (битый, чужой) сначала откладывается, а не перекрывается.
 */
export async function writeEnvelope(fs: StorageFs, target: StorageTarget, input: { writtenBy: string; state: unknown; now?: Date }): Promise<WriteResult> {
  const dir = dirOf(target);
  const bytes = stateBytes(input.state);
  if (bytes === null || !isPlainObject(input.state)) return { ok: false, code: 'FAILED', reason: 'состояние не объект JSON' };
  if (bytes > STORAGE_LIMIT_BYTES) return { ok: false, code: 'LIMIT', bytes };
  return withLock(dir, () => writeLocked(fs, target, dir, bytes, input as { writtenBy: string; state: Record<string, unknown>; now?: Date }));
}
async function writeLocked(fs: StorageFs, target: StorageTarget, dir: string, bytes: number, input: { writtenBy: string; state: Record<string, unknown>; now?: Date }): Promise<WriteResult> {
  const now = input.now ?? new Date();
  const envelope: StorageEnvelope = { format: STORAGE_FORMAT, program: target.programId, writtenBy: String(input.writtenBy).slice(0, 64), savedAt: now.toISOString(), state: input.state };
  const text = JSON.stringify(envelope);
  const file = path.join(dir, STORAGE_FILE);
  const tmp = path.join(dir, `state.tmp-${process.pid}-${Date.now()}-${++counter}.json`);
  try {
    await fs.mkdir(dir, { recursive: true });
    let broken: { kept: string } | undefined;
    const found = await inspect(fs, file, target.programId);
    if (found.kind === 'error') return { ok: false, code: 'FAILED', reason: 'файл хранилища не прочитан' };
    if (found.kind === 'broken') {
      const kept = await setAside(fs, dir, now);
      if (!kept) return { ok: false, code: 'FAILED', reason: 'повреждённый файл не удалось отложить' };
      broken = { kept };
    }
    await fs.writeFile(tmp, text, { encoding: 'utf8', flag: 'wx' });
    await renameWithRetry(fs, tmp, file);
    return { ok: true, bytes, ...(broken ? { broken } : {}) };
  } catch (e) {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    return { ok: false, code: 'FAILED', reason: reasonOf(e) };
  }
}

/** Сколько занято сейчас (байты состояния); нет файла — 0, файл негодный или диск не отвечает — `null` */
export async function storageUsage(fs: StorageFs, target: StorageTarget): Promise<number | null> {
  const found = await inspect(fs, path.join(dirOf(target), STORAGE_FILE), target.programId);
  return found.kind === 'missing' ? 0 : found.kind === 'ok' ? found.bytes : null;
}

/**
 * Удаляет папку области: `<корень>/<человек>/<программа>/<область>` и ничего больше. Путь собирает `storagePath` из проверенных
 * частей; ссылка на месте папки снимается как ссылка (`fs.rm` не идёт по ссылке, то, куда она ведёт, не трогается); пустая папка
 * программы убирается за собой (`rmdir` не рекурсивный: пока в ней есть другая область, она остаётся).
 */
export async function clearStorage(fs: StorageFs, target: StorageTarget): Promise<{ ok: true; removed: boolean } | { ok: false; code: 'FAILED' }> {
  const dir = dirOf(target);
  return withLock(dir, () => clearLocked(fs, dir));
}
async function clearLocked(fs: StorageFs, dir: string): Promise<{ ok: true; removed: boolean } | { ok: false; code: 'FAILED' }> {
  try {
    try { await fs.lstat(dir); } catch (e) { if (isMissing(e)) return { ok: true, removed: false }; throw e; }
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rmdir(path.dirname(dir)).catch(() => undefined);
    return { ok: true, removed: true };
  } catch { return { ok: false, code: 'FAILED' }; }
}
