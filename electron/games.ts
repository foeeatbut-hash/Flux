/**
 * Локальный менеджер игр: установка, сверка, запуск.
 *
 * Здесь всё, что трогает диск. Правила — в общем модуле `play/builds.ts`: их
 * читают ещё сервер и окно, и разъехаться им нельзя.
 *
 * Три решения этого файла, каждое о том, как НЕ сломать чужую машину:
 *
 *   1. **Имя из описи — не путь.** Всё, что приходит снаружи, проходит через
 *      `pathProblem`, и только потом превращается в путь. Дополнительно
 *      готовый путь сверяется с папкой игры: даже если правило однажды
 *      пропустит хитрость, файл не ляжет за пределы своей папки.
 *   2. **Версия переключается одним движением.** Файлы качаются в рабочую
 *      папку, оттуда переезжают целой папкой, и только после этого
 *      переписывается указатель `current.json` — тоже через временный файл и
 *      переименование. Прерванная посреди установка оставляет прежнюю версию
 *      целой; полуустановленной версии не бывает.
 *   3. **Подпись издателя закрепляется при первой установке.** Дальше опись,
 *      подписанная другим ключом, не принимается вовсе. Это защита ровно от
 *      того, что бывает на деле: подменённый файл на файловом сервере.
 *      Ключ меняется только вместе с удалением игры — то есть осознанно.
 *
 * Чего здесь нет и не будет: запуска игры в контейнере разработки. Проверить
 * установку и запуск можно только на Windows с настоящей сборкой, и это прямо
 * сказано в документации, а не умолчано.
 */

import { app, ipcMain, type BrowserWindow } from 'electron';
import crypto from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import {
  installState, launchArgs, parseManifest, pathProblem,
  type BuildFile, type BuildManifest, type InstallState,
} from '../play/builds';
import { verifyManifest } from '../play/node/signature';
import { sameServer } from './updates';

/** Столько версий держим про запас: прежняя нужна, чтобы было куда вернуться */
const KEEP_VERSIONS = 1;

/** Как часто рассказывать окну о ходе закачки */
const PROGRESS_MS = 400;

let sendToWindow: (channel: string, payload: unknown) => void = () => {};

// ── Где что лежит ───────────────────────────────────────────────────────────

const gamesRoot = (): string => path.join(app.getPath('userData'), 'games');
const gameDir = (gameId: string): string => path.join(gamesRoot(), safeId(gameId));
const versionsDir = (gameId: string): string => path.join(gameDir(gameId), 'versions');
const workDir = (gameId: string): string => path.join(gameDir(gameId), '.work');

/**
 * Идентификатор игры тоже приходит снаружи.
 *
 * Он короче пути и выглядит безобидно, поэтому его легко забыть проверить — а
 * `../../..` в нём работает ровно так же, как в пути файла.
 */
function safeId(gameId: string): string {
  const id = String(gameId || '');
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(id)) throw new Error('недопустимый идентификатор игры');
  return id;
}

/** Путь файла сборки — с двойной проверкой: по правилу и по итоговому пути. */
function fileInside(root: string, rel: string): string {
  const problem = pathProblem(rel);
  if (problem) throw new Error(`недопустимый путь в описи (${problem})`);
  const full = path.resolve(root, rel);
  const base = path.resolve(root) + path.sep;
  if (!full.startsWith(base)) throw new Error('путь из описи ведёт за пределы папки игры');
  return full;
}

// ── Указатель текущей версии ────────────────────────────────────────────────

interface CurrentInfo {
  version: string;
  installedAt: number;
  manifest: BuildManifest;
}

async function readCurrent(gameId: string): Promise<CurrentInfo | null> {
  try {
    const text = await fsp.readFile(path.join(gameDir(gameId), 'current.json'), 'utf-8');
    const raw = JSON.parse(text);
    const parsed = parseManifest(raw?.manifest);
    if (!parsed.manifest) return null;
    return { version: String(raw.version || ''), installedAt: Number(raw.installedAt) || 0, manifest: parsed.manifest };
  } catch (_) { return null; }
}

/**
 * Переписать указатель одним движением.
 *
 * Запись поверх — это окно, в котором файл уже не старый, но ещё не новый;
 * выключенный в этот миг компьютер оставил бы игру без указателя вовсе.
 * Временный файл и переименование такого окна не оставляют.
 */
async function writeCurrent(gameId: string, info: CurrentInfo): Promise<void> {
  const dir = gameDir(gameId);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `current.json.${process.pid}.tmp`);
  await fsp.writeFile(tmp, JSON.stringify(info, null, 2), 'utf-8');
  await fsp.rename(tmp, path.join(dir, 'current.json'));
}

// ── Подпись издателя ────────────────────────────────────────────────────────

async function pinnedKey(gameId: string): Promise<string> {
  try { return (await fsp.readFile(path.join(gameDir(gameId), 'key.pub'), 'utf-8')).trim(); } catch (_) { return ''; }
}

async function pinKey(gameId: string, hex: string): Promise<void> {
  await fsp.mkdir(gameDir(gameId), { recursive: true });
  await fsp.writeFile(path.join(gameDir(gameId), 'key.pub'), hex, 'utf-8');
}

// ── Отпечатки файлов ────────────────────────────────────────────────────────

/** SHA-256 файла потоком: сборки бывают гигабайтными, в память они не влезут. */
function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** Сходятся ли файлы установленной версии с её описью. */
async function intactNow(gameId: string, info: CurrentInfo): Promise<boolean> {
  const root = path.join(versionsDir(gameId), info.version);
  for (const f of info.manifest.files) {
    try {
      const full = fileInside(root, f.path);
      const stat = await fsp.stat(full);
      if (stat.size !== f.size) return false;
      if (await hashFile(full) !== f.sha256) return false;
    } catch (_) { return false; }
  }
  return true;
}

// ── Ход установки ───────────────────────────────────────────────────────────

interface Job {
  gameId: string;
  version: string;
  total: number;
  done: number;
  paused: boolean;
  cancel: AbortController;
  failure: string;
}

const jobs = new Map<string, Job>();

/** Что сейчас с игрой — одним ответом для окна. */
export interface GameStatus {
  gameId: string;
  state: InstallState;
  installed: string;
  published: string;
  bytesDone: number;
  bytesTotal: number;
  failure: string;
}

async function statusOf(gameId: string, published = ''): Promise<GameStatus> {
  const current = await readCurrent(gameId);
  const job = jobs.get(safeId(gameId));
  const intact = current ? await intactNow(gameId, current) : undefined;
  return {
    gameId: safeId(gameId),
    state: installState({
      published,
      installed: current?.version || '',
      downloading: !!job && !job.paused,
      paused: !!job?.paused,
      intact,
    }),
    installed: current?.version || '',
    published,
    bytesDone: job?.done || 0,
    bytesTotal: job?.total || 0,
    failure: job?.failure || '',
  };
}

function report(job: Job): void {
  sendToWindow('games:progress', {
    gameId: job.gameId,
    version: job.version,
    bytesDone: job.done,
    bytesTotal: job.total,
    paused: job.paused,
    failure: job.failure,
  });
}

/**
 * Скачать один файл сборки и проверить его отпечаток.
 *
 * Отпечаток проверяется СРАЗУ, а не в конце установки: сломанный файл, найденный
 * сейчас, стоит одной перекачки, а найденный в конце — всей сборки заново.
 */
async function fetchFile(
  job: Job, file: BuildFile, base: string, token: string, server: string, into: string,
): Promise<void> {
  const url = new URL(file.url, base).toString();
  if (!sameServer(url, server)) throw new Error('файл сборки лежит не на своём сервере');

  const res = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    signal: job.cancel.signal,
  });
  if (!res.ok || !res.body) throw new Error(`сервер ответил ${res.status} на ${file.path}`);

  const target = fileInside(into, file.path);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const out = fs.createWriteStream(target);
  const hash = crypto.createHash('sha256');
  let last = Date.now();
  let size = 0;

  const reader = (res.body as any).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    size += chunk.length;
    if (size > file.size) throw new Error(`файл ${file.path} больше обещанного описью`);
    hash.update(chunk);
    job.done += chunk.length;
    if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
    if (Date.now() - last > PROGRESS_MS) { last = Date.now(); report(job); }
  }
  await new Promise<void>((resolve, reject) => { out.end(() => resolve()); out.on('error', reject); });

  if (size !== file.size) throw new Error(`размер ${file.path} не сошёлся с описью`);
  if (hash.digest('hex') !== file.sha256) throw new Error(`отпечаток ${file.path} не сошёлся с описью`);
}

export interface InstallRequest {
  gameId: string;
  /** Опись, полученная окном от сервера: она подписана издателем */
  manifest: unknown;
  /** Адрес сборки: от него разрешаются адреса файлов */
  base: string;
  /** Свой сервер: чужому ни токен, ни доверие не уходят */
  server: string;
  token?: string;
  /** Ключ издателя. При первой установке закрепляется, дальше сверяется */
  publisherKey: string;
}

/**
 * Поставить или обновить игру.
 *
 * Порядок здесь — и есть безопасность: разобрать опись → проверить подпись →
 * скачать в рабочую папку с проверкой каждого файла → переложить папкой →
 * переписать указатель → прибрать старое. Любой сбой до последнего шага
 * оставляет установленное нетронутым.
 */
export async function install(req: InstallRequest): Promise<GameStatus> {
  const gameId = safeId(req.gameId);
  const parsed = parseManifest(req.manifest);
  if (!parsed.manifest) throw new Error(parsed.problem);
  const manifest = parsed.manifest;
  if (manifest.gameId !== gameId) throw new Error('опись выдана другой игре');

  const known = await pinnedKey(gameId);
  const key = known || String(req.publisherKey || '');
  if (!verifyManifest(manifest, key)) {
    throw new Error(known
      ? 'опись подписана не тем ключом, которым подписывалась установленная игра'
      : 'опись не подписана издателем');
  }

  if (jobs.has(gameId)) throw new Error('установка этой игры уже идёт');
  const job: Job = {
    gameId,
    version: manifest.version,
    total: manifest.files.reduce((s, f) => s + f.size, 0),
    done: 0,
    paused: false,
    cancel: new AbortController(),
    failure: '',
  };
  jobs.set(gameId, job);

  const work = path.join(workDir(gameId), manifest.version);
  try {
    await fsp.rm(work, { recursive: true, force: true });
    await fsp.mkdir(work, { recursive: true });
    for (const file of manifest.files) {
      while (job.paused) {
        await new Promise((r) => setTimeout(r, 300));
        if (job.cancel.signal.aborted) throw new Error('установка отменена');
      }
      await fetchFile(job, file, req.base, String(req.token || ''), req.server, work);
    }

    // Переезд целой папкой: до этого мига установленной новая версия не
    // считается ничем и нигде
    const home = path.join(versionsDir(gameId), manifest.version);
    await fsp.mkdir(versionsDir(gameId), { recursive: true });
    await fsp.rm(home, { recursive: true, force: true });
    await fsp.rename(work, home);

    if (!known) await pinKey(gameId, key);
    await writeCurrent(gameId, { version: manifest.version, installedAt: Date.now(), manifest });
    await prune(gameId, manifest.version);
    return await statusOf(gameId, manifest.version);
  } catch (e: any) {
    job.failure = String(e?.message || e);
    report(job);
    await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
    throw e;
  } finally {
    jobs.delete(gameId);
  }
}

/** Прибрать старые версии, оставив одну про запас. */
async function prune(gameId: string, keepVersion: string): Promise<void> {
  try {
    const dir = versionsDir(gameId);
    const list = await fsp.readdir(dir);
    const others = list.filter((v) => v !== keepVersion);
    // Свежие — в начало: про запас держим последнюю прежнюю
    const stats = await Promise.all(others.map(async (v) => ({
      v, at: (await fsp.stat(path.join(dir, v))).mtimeMs,
    })));
    stats.sort((a, b) => b.at - a.at);
    for (const old of stats.slice(KEEP_VERSIONS)) {
      await fsp.rm(path.join(dir, old.v), { recursive: true, force: true }).catch(() => {});
    }
  } catch (_) { /* прибирать нечего */ }
}

/** Убрать игру целиком — вместе с закреплённым ключом издателя. */
export async function remove(gameId: string): Promise<void> {
  const job = jobs.get(safeId(gameId));
  if (job) job.cancel.abort();
  await fsp.rm(gameDir(gameId), { recursive: true, force: true });
}

/**
 * Запустить игру.
 *
 * Отдельным процессом и с отвязкой: программа не обязана жить, пока идёт матч,
 * а матч не обязан кончаться вместе с окном программы.
 */
export async function launch(
  gameId: string, p: { address: string; ticket: string; sessionId: string },
): Promise<{ started: boolean; problem: string }> {
  const current = await readCurrent(gameId);
  if (!current) return { started: false, problem: 'игра не установлена' };
  const exe = fileInside(path.join(versionsDir(gameId), current.version), current.manifest.exe);
  try { await fsp.access(exe, fs.constants.X_OK | fs.constants.R_OK); } catch (_) {
    return { started: false, problem: 'запускаемый файл игры недоступен' };
  }
  try {
    const child = spawn(exe, launchArgs(p), {
      cwd: path.dirname(exe),
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.unref();
    return { started: true, problem: '' };
  } catch (e: any) {
    return { started: false, problem: String(e?.message || e) };
  }
}

// ── Мост с окном: белый список каналов ──────────────────────────────────────

/**
 * Обработчики менеджера игр.
 *
 * Каналы перечислены поимённо и здесь, и в preload: окно не должно уметь
 * позвать «какой-нибудь» канал оболочки — тем более тот, что пишет файлы на
 * диск по присланному пути.
 */
export function setupGames(getWindow: () => BrowserWindow | null): void {
  sendToWindow = (channel, payload) => {
    try { getWindow()?.webContents.send(channel, payload); } catch (_) { /* окно закрыто */ }
  };

  ipcMain.handle('games:state', async (_e, p: { gameId: string; published?: string }) =>
    statusOf(String(p?.gameId || ''), String(p?.published || '')));

  ipcMain.handle('games:install', async (_e, req: InstallRequest) => {
    try { return { ok: true, status: await install(req) }; } catch (e: any) {
      return { ok: false, problem: String(e?.message || e) };
    }
  });

  ipcMain.handle('games:pause', async (_e, p: { gameId: string }) => {
    const job = jobs.get(safeId(String(p?.gameId || '')));
    if (!job) return { ok: false, problem: 'закачка не идёт' };
    job.paused = true;
    report(job);
    return { ok: true };
  });

  ipcMain.handle('games:resume', async (_e, p: { gameId: string }) => {
    const job = jobs.get(safeId(String(p?.gameId || '')));
    if (!job) return { ok: false, problem: 'закачка не идёт' };
    job.paused = false;
    report(job);
    return { ok: true };
  });

  ipcMain.handle('games:cancel', async (_e, p: { gameId: string }) => {
    const job = jobs.get(safeId(String(p?.gameId || '')));
    if (!job) return { ok: false, problem: 'закачка не идёт' };
    job.cancel.abort();
    return { ok: true };
  });

  ipcMain.handle('games:verify', async (_e, p: { gameId: string; published?: string }) => {
    const gameId = String(p?.gameId || '');
    const current = await readCurrent(gameId);
    if (!current) return { ok: false, problem: 'игра не установлена' };
    const intact = await intactNow(gameId, current);
    return { ok: true, intact, status: await statusOf(gameId, String(p?.published || '')) };
  });

  ipcMain.handle('games:launch', async (_e, p: { gameId: string; address: string; ticket: string; sessionId: string }) =>
    launch(String(p?.gameId || ''), {
      address: String(p?.address || ''), ticket: String(p?.ticket || ''), sessionId: String(p?.sessionId || ''),
    }));

  ipcMain.handle('games:remove', async (_e, p: { gameId: string }) => {
    try { await remove(String(p?.gameId || '')); return { ok: true }; } catch (e: any) {
      return { ok: false, problem: String(e?.message || e) };
    }
  });
}
