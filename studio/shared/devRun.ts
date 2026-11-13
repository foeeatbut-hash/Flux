/**
 * «Запустить во Flux»: что Studio кладёт в папку обмена `<данные Flux>/dev-run/<moduleId>/`.
 *
 * Содержимое трёх файлов делает чистая часть (`prepareDevRun`, `renewLease`) — её проверяет `verifyDevRun` из
 * modules/trust/devRun.ts, то есть ровно тот код, которым пакет проверит Flux. Запись файлов и уборка — `DevRunFolder`:
 * только своя папка `dev-run/<moduleId>/`, остальное в данных Flux не трогается.
 *
 * Пакет — тот же, что уходит владельцу (`buildPackage`): все языки, включая Python и WebAssembly. Подписывает ключ
 * разработчика (keyring.ts); сертификат владельца на этот ключ Studio получает с сервера и кладёт рядом как есть.
 */
import fs from 'node:fs';
import path from 'node:path';
import { peekEnvelope } from '../../modules/trust/envelope';
import { parseCertificateClaim, MODULE_ID, type DevRunClaim } from '../../modules/trust/claims';
import { DEV_RUN_DIR, DEV_RUN_FILES, devLeasePayload, devRunPayload, type DevRunFile } from '../../modules/trust/devRun';
import { buildPackage, PublishRefused } from './publish';
import { KeyringFailure, type DeveloperKeyring } from './keyring';
import { fluxDataDirs } from './fluxAddress';
import type { ProjectFiles } from './templates';

/** Отказ словами для человека: окно показывает текст как есть */
export class DevRunRefused extends Error {}

export interface DevRunInput {
  keyring: DeveloperKeyring;
  /** Конверт сертификата владельца на ключ разработчика (с сервера); пусто — сертификата нет */
  certificate: string;
  /** Кто сейчас вошёл в Studio: пакет запускается только у этого человека */
  userId: string;
  moduleId: string; version: string;
  files: ProjectFiles; runtime: string; logic?: string;
  now: number;
}
export interface DevRunPrepared {
  /** Содержимое run.json */
  runJson: string;
  bundle: Uint8Array;
  lease: string;
  claim: DevRunClaim;
  builtAt: number;
}

export function prepareDevRun(input: DevRunInput): DevRunPrepared {
  if (!input.userId) throw new DevRunRefused('Сначала войдите в Studio: пакет запускается только у вошедшего человека.');
  const info = input.keyring.info();
  if (info.damaged) throw new DevRunRefused('Файл ключа разработчика повреждён: запустить во Flux нельзя.');
  if (!info.exists) throw new DevRunRefused('Ключа разработчика нет: он создаётся при первом входе. Откройте «Запросить право публиковать».');
  if (!input.certificate) throw new DevRunRefused('У вашего ключа нет сертификата владельца: запросите право публиковать, и после выдачи сертификата программу можно запускать во Flux.');
  // Сверка нужна ради ясных слов; доверие всё равно решает Flux по корню владельца
  const cert = parseCertificateClaim(peekEnvelope('certificate', input.certificate));
  if (!cert) throw new DevRunRefused('Сертификат владельца не читается: запросите его заново.');
  if (cert.key !== info.publicKey) throw new DevRunRefused('Сертификат выдан другому ключу: ключ на этом компьютере заменён. Запросите сертификат заново.');
  if (cert.userId !== input.userId) throw new DevRunRefused('Сертификат выдан другому человеку: войдите в Studio под своим именем.');
  let bundle: Uint8Array;
  try { bundle = buildPackage(input.files, input.runtime, input.logic || ''); }
  catch (error) {
    // packBundle отказывает своими словами (размер, имена файлов): человеку они и нужны
    throw new DevRunRefused(`Пакет не собран: ${error instanceof PublishRefused || error instanceof Error ? error.message : 'ошибка сборки'}`);
  }
  try {
    const claim = devRunPayload({ moduleId: input.moduleId, version: input.version, author: info.publicKey, userId: input.userId, bundle, now: input.now });
    const run: DevRunFile = { v: 1, run: input.keyring.sign('devRun', claim), certificate: input.certificate };
    return { runJson: JSON.stringify(run), bundle, lease: input.keyring.sign('devLease', devLeasePayload(claim, input.now)), claim, builtAt: input.now };
  } catch (error) {
    if (error instanceof KeyringFailure) throw new DevRunRefused(error.message);
    throw error;
  }
}

/** Новая аренда того же пакета: Studio вызывает её каждые DEV_LEASE_RENEW_MS */
export function renewLease(keyring: DeveloperKeyring, claim: DevRunClaim, now: number): string {
  try { return keyring.sign('devLease', devLeasePayload(claim, now)); }
  catch (error) {
    if (error instanceof KeyringFailure) throw new DevRunRefused(error.message);
    throw error;
  }
}

/** Папка данных Flux на этом компьютере: первая из возможных, где Flux уже работал (есть config.json или сама папка) */
export function findFluxDataDir(options: {
  env: Record<string, string | undefined>; platform: string; home: string;
  exists?: (p: string) => boolean;
}): string {
  const exists = options.exists || ((p: string) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
  const dirs = fluxDataDirs(options.env, options.platform, options.home);
  const hit = dirs.find(exists);
  if (!hit) throw new DevRunRefused('Flux на этом компьютере не найден: запустите Flux хотя бы раз, затем повторите.');
  return hit;
}

/** Запись в папку обмена: временный файл + rename; пакет и run.json раньше lease.txt, поэтому Flux не видит аренду без пакета */
function writeAtomic(file: string, data: Uint8Array | string): void {
  const temp = `${file}.${process.pid}.tmp`;
  try { fs.writeFileSync(temp, data); fs.renameSync(temp, file); }
  catch (error) { try { fs.rmSync(temp, { force: true }); } catch { /* временный файл не убран — не критично */ } throw error; }
}

/** Отметка в папке: по ней при старте Studio узнаёт свои осиротевшие папки, не трогая чужие (папку мог создать и другой экземпляр) */
const OWNER_FILE = 'studio.pid';

export class DevRunFolder {
  readonly dir: string;
  constructor(dataDir: string, readonly moduleId: string) {
    if (!MODULE_ID.test(moduleId)) throw new DevRunRefused('Некорректный идентификатор программы.');
    this.dir = path.join(dataDir, DEV_RUN_DIR, moduleId);
  }

  /** Пакет и run.json — раньше аренды: пока lease.txt старый или отсутствует, Flux программу не запускает */
  write(prepared: DevRunPrepared): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      // Прежняя аренда уходит до замены пакета: иначе старая аренда подошла бы лишь к старому пакету, а Flux увидел бы смесь
      fs.rmSync(path.join(this.dir, DEV_RUN_FILES.lease), { force: true });
      writeAtomic(path.join(this.dir, DEV_RUN_FILES.bundle), prepared.bundle);
      writeAtomic(path.join(this.dir, DEV_RUN_FILES.run), prepared.runJson);
      writeAtomic(path.join(this.dir, DEV_RUN_FILES.lease), prepared.lease);
      writeAtomic(path.join(this.dir, OWNER_FILE), String(process.pid));
    } catch (error: any) {
      throw new DevRunRefused(`Не удалось записать пакет в папку Flux (${String(error?.code || error?.message || 'ошибка записи')}). Проверьте, что у папки данных Flux есть доступ на запись.`);
    }
  }

  renew(lease: string): void {
    try { writeAtomic(path.join(this.dir, DEV_RUN_FILES.lease), lease); }
    catch (error: any) { throw new DevRunRefused(`Аренда не продлена (${String(error?.code || 'ошибка записи')}).`); }
  }

  /** Только своя папка; аренда уходит первой, чтобы Flux перестал запускать программу сразу */
  remove(): void {
    try { fs.rmSync(path.join(this.dir, DEV_RUN_FILES.lease), { force: true }); } catch { /* ниже снесём всю папку */ }
    fs.rmSync(this.dir, { recursive: true, force: true });
  }

  exists(): boolean { return fs.existsSync(this.dir); }
}

/**
 * Старт Studio: убрать папки, оставленные прежним запуском Studio (вылет, выключение питания). Чужие не трогаются:
 * папка с отметкой живого процесса, не равного нашему, остаётся. `alive` — проверка процесса (подставляется в проверках).
 */
export function sweepOrphans(dataDir: string, alive: (pid: number) => boolean = pidAlive): string[] {
  const root = path.join(dataDir, DEV_RUN_DIR), removed: string[] = [];
  let names: string[] = [];
  try { names = fs.readdirSync(root); } catch { return removed; }
  for (const name of names) {
    if (!MODULE_ID.test(name)) continue;
    const dir = path.join(root, name);
    let pid = NaN;
    try { pid = Number(fs.readFileSync(path.join(dir, OWNER_FILE), 'utf8')); } catch { continue; } // без отметки Studio папка не наша
    if (pid === process.pid || (Number.isSafeInteger(pid) && alive(pid))) continue;
    try { fs.rmSync(dir, { recursive: true, force: true }); removed.push(name); } catch { /* останется: аренда всё равно протухнет */ }
  }
  return removed;
}

function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error: any) { return error?.code === 'EPERM'; }
}
