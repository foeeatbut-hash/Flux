/**
 * «Запустить во Flux» из Studio, сторона главного процесса: папка обмена, проверка, память.
 *
 * Studio кладёт пакет разработки в `<данные Flux>/dev-run/<moduleId>/` (run.json, lease.txt, package.bin;
 * имена, сроки и сама проверка — modules/trust/devRun.ts). Здесь:
 * - читаем папку осторожно: имя папки — только MODULE_ID, символические ссылки не читаем, размеры ограничены
 *   теми же пределами, что у выпуска; чужого в папке обмена нет права что-то записать — мы туда не пишем,
 *   кроме «Убрать» (удаление своей папки);
 * - проверяем `verifyDevRun` (корень владельца, отзыв ключей, вошедший человек, свежая аренда, байты пакета);
 * - держим проверенное ТОЛЬКО в памяти: в кэш выпусков, в файл выбора и на диск Flux оно не попадает;
 * - аренду перечитываем по таймеру и при каждом обращении программы: просроченное или удалённое Studio
 *   перестаёт запускаться само, окну об этом сообщает событие.
 * Согласие человека на разрешения хранится тоже в памяти и привязано к человеку, программе и хешу сборки: новая
 * сборка спрашивает снова, на выпущенную программу того же имени согласие не переносится и обратно.
 *
 * Без electron: проверяется скриптом и настоящим Electron (scripts/test-modules-dev-run-native.ts).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { DevRunItem } from '../modules/store/devRun';
import { MODULE_BUNDLE_MAX, MODULE_ID, parseCertificateClaim } from '../modules/trust/claims';
import { DEV_RUN_FILES, leaseProblem, verifyDevRun, type DevRunFile, type DevRunnable } from '../modules/trust/devRun';
import { ENVELOPE_MAX, peekEnvelope, sha256Hex } from '../modules/trust/envelope';
import type { RevokedSet, RunnableRelease } from '../modules/trust/verify';
import { permissionsDigest } from '../modules/permissions/registry';

/** Папок обмена больше этого не читаем: у человека их единицы, остальное — мусор или попытка забить память */
const FOLDERS_MAX = 32;
/** run.json несёт два конверта (пакет и сертификат) в JSON */
const RUN_FILE_MAX = ENVELOPE_MAX * 2 + 4096;
/** Как часто главный процесс перечитывает аренду; Studio продлевает в два раза реже (DEV_LEASE_RENEW_MS), срок — три продления */
export const DEV_POLL_MS = 10_000;
/** Чаще этого обращения программы не перечитывают папку: запросов у кадра много */
const TOUCH_MIN_MS = 1500;

interface Entry {
  moduleId: string;
  /** Отпечаток прочитанного и условий проверки: при том же отпечатке заново не проверяем */
  fingerprint: string;
  runText: string;
  packageStamp: string;
  userId: string;
  /** Кому принадлежит пакет по его же записи (для списка: чужое не показывается); пусто — прочитать не удалось */
  owner: string;
  verified: DevRunnable | null;
  live: boolean;
  why: string;
}

export interface DevRunsOptions {
  /** `<данные Flux>/dev-run` */
  dir: string;
  rootHex: () => string;
  revoked: () => Promise<RevokedSet>;
  /** Кто сейчас вошёл */
  userId: () => string;
  /** Имена встроенных примеров: их пакет разработки не подменяет */
  reserved: readonly string[];
  /** Состав или состояние изменились (появилось, истекло, убрано, принято) */
  changed: () => void;
  now?: () => number;
  platform?: string;
}

async function readLimited(file: string, max: number): Promise<{ bytes: Buffer | null; why: string }> {
  let stat;
  try { stat = await fs.lstat(file); } catch { return { bytes: null, why: 'нет файла' }; }
  // Символическая ссылка — это не файл Studio: по ней можно указать на что угодно на диске
  if (!stat.isFile()) return { bytes: null, why: 'это не обычный файл' };
  if (stat.size > max) return { bytes: null, why: 'файл слишком велик' };
  let handle;
  try {
    handle = await fs.open(file, (fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)));
    const buffer = Buffer.alloc(Math.min(max, stat.size) + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > max) return { bytes: null, why: 'файл слишком велик' };
    return { bytes: buffer.subarray(0, bytesRead), why: '' };
  } catch { return { bytes: null, why: 'файл не читается' }; }
  finally { await handle?.close().catch(() => {}); }
}

export type { DevRunItem };

export class ModuleDevRuns {
  private entries = new Map<string, Entry>();
  /** (человек, программа, хеш сборки) → человек согласился; только память */
  private accepted = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private lastScan = 0;
  private now: () => number;

  constructor(private o: DevRunsOptions) { this.now = o.now ?? Date.now; }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.scan().catch(() => {}); }, DEV_POLL_MS);
    this.timer.unref?.();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** Перечитать папку обмена; одновременные вызовы делят один проход */
  scan(): Promise<void> {
    return this.running ||= this.scanNow().finally(() => { this.running = null; this.lastScan = this.now(); });
  }
  /** Вызов «при обращении»: перечитывает, если давно не читали */
  async touch(): Promise<void> {
    if (this.running) { await this.running; return; }
    if (this.now() - this.lastScan < TOUCH_MIN_MS) return;
    await this.scan();
  }

  private signature() {
    return JSON.stringify([...this.entries.values()].map(e => [e.moduleId, e.fingerprint, e.live, e.why, this.isAccepted(e)]));
  }

  private async scanNow() {
    const before = this.signature();
    let names: string[] = [];
    try {
      const root = await fs.lstat(this.o.dir);
      if (root.isDirectory()) names = (await fs.readdir(this.o.dir)).filter(n => MODULE_ID.test(n)).sort().slice(0, FOLDERS_MAX);
    } catch { /* папки обмена ещё нет */ }
    const revoked = await this.o.revoked().catch(() => ({ releases: new Set<string>(), keys: new Set<string>() }));
    for (const gone of [...this.entries.keys()]) if (!names.includes(gone)) this.entries.delete(gone);
    for (const name of names) {
      try { await this.readFolder(name, revoked); }
      catch (e: any) { this.entries.set(name, this.failed(name, 'Папка обмена не читается', e?.message || '')); }
    }
    if (this.signature() !== before) this.o.changed();
  }

  private failed(moduleId: string, why: string, fingerprint: string): Entry {
    return { moduleId, fingerprint: `failed|${fingerprint}`, runText: '', packageStamp: '', userId: '', owner: '', verified: null, live: false, why };
  }

  private async readFolder(moduleId: string, revoked: RevokedSet) {
    const dir = path.join(this.o.dir, moduleId);
    const stat = await fs.lstat(dir).catch(() => null);
    if (!stat?.isDirectory()) { this.entries.delete(moduleId); return; }
    if (this.o.reserved.includes(moduleId)) {
      this.entries.set(moduleId, this.failed(moduleId, 'Это имя занято встроенным примером Flux: пакет разработки его не заменяет', 'reserved'));
      return;
    }
    const userId = this.o.userId(), previous = this.entries.get(moduleId);
    const run = await readLimited(path.join(dir, DEV_RUN_FILES.run), RUN_FILE_MAX);
    const lease = await readLimited(path.join(dir, DEV_RUN_FILES.lease), ENVELOPE_MAX);
    const pkgStat = await fs.lstat(path.join(dir, DEV_RUN_FILES.bundle)).catch(() => null);
    const packageStamp = pkgStat?.isFile() ? `${pkgStat.size}:${pkgStat.mtimeMs}` : '';
    if (!run.bytes) { this.entries.set(moduleId, this.failed(moduleId, `В папке обмена нет читаемого ${DEV_RUN_FILES.run}`, run.why)); return; }
    const runText = run.bytes.toString('utf8'), leaseText = lease.bytes?.toString('utf8') ?? '';

    // Та же сборка, тот же человек: заново проверяем только аренду и отзыв ключа (пакет в памяти уже проверен)
    if (previous?.verified && previous.runText === runText && previous.packageStamp === packageStamp && previous.userId === userId) {
      const dev = previous.verified.dev;
      const why = revoked.keys.has(dev.author) ? 'Сертификат разработчика отозван'
        : leaseProblem({ lease: leaseText, run: dev, now: this.now() });
      this.entries.set(moduleId, { ...previous, fingerprint: previous.fingerprint, live: !why, why });
      return;
    }
    // Не прошло раньше и ничего не изменилось (кроме минуты: аренда «из будущего» со временем становится годной)
    const fingerprint = `${sha256Hex(runText)}|${sha256Hex(leaseText)}|${packageStamp}|${userId}|${[...revoked.keys].sort().join(',')}|${Math.floor(this.now() / 60_000)}`;
    if (previous && !previous.verified && previous.fingerprint === fingerprint) return;

    let file: DevRunFile | null = null;
    try { const parsed = JSON.parse(runText); if (parsed && parsed.v === 1 && typeof parsed.run === 'string' && typeof parsed.certificate === 'string') file = parsed; } catch { /* ниже */ }
    if (!file) { this.entries.set(moduleId, { ...this.failed(moduleId, 'run.json не читается', fingerprint), fingerprint }); return; }
    const certificate = parseCertificateClaim(peekEnvelope('certificate', file.certificate));
    const owner = certificate?.userId ?? '';
    const bundle = await readLimited(path.join(dir, DEV_RUN_FILES.bundle), MODULE_BUNDLE_MAX);
    if (!bundle.bytes) { this.entries.set(moduleId, { ...this.failed(moduleId, `В папке обмена нет читаемого ${DEV_RUN_FILES.bundle}`, fingerprint), fingerprint, owner }); return; }

    const result = verifyDevRun({
      run: file.run, lease: leaseText, certificate: file.certificate, bundle: new Uint8Array(bundle.bytes),
      rootHex: this.o.rootHex(), revoked, now: this.now(), userId, hostPlatform: this.o.platform ?? process.platform,
    });
    if (!result.ok) { this.entries.set(moduleId, { ...this.failed(moduleId, result.why, fingerprint), fingerprint, owner, runText, packageStamp, userId }); return; }
    if (result.dev.moduleId !== moduleId) {
      this.entries.set(moduleId, { ...this.failed(moduleId, 'Папка обмена названа не по программе из пакета', fingerprint), fingerprint, owner, runText, packageStamp, userId });
      return;
    }
    this.entries.set(moduleId, { moduleId, fingerprint, runText, packageStamp, userId, owner: result.dev.userId, verified: result, live: true, why: '' });
  }

  private static consent = (user: string, moduleId: string, sha256: string) => [user, moduleId, sha256].join('\u0001');
  private isAccepted(e: Entry) {
    return !!e.verified && this.accepted.has(ModuleDevRuns.consent(e.userId, e.moduleId, e.verified.claim.sha256));
  }

  /** Список для окна: только своё (пакет чужого разработчика человеку не показывается) */
  list(): DevRunItem[] {
    const user = this.o.userId();
    return [...this.entries.values()].filter(e => !e.owner || e.owner === user).map(e => {
      const v = e.verified;
      return { moduleId: e.moduleId, name: v?.manifest.name ?? e.moduleId, version: v?.claim.version ?? '', developer: v?.developer ?? '',
        live: e.live, accepted: e.live && this.isAccepted(e), sha256: v?.claim.sha256 ?? '', manifest: e.live && v ? v.manifest : null, why: e.why };
    });
  }

  /** Пакеты, которые можно запускать СЕЙЧАС: проверены, аренда свежая, человек согласился с разрешениями этой сборки */
  active(): Map<string, RunnableRelease> {
    const out = new Map<string, RunnableRelease>();
    for (const e of this.entries.values()) if (e.live && e.verified && e.userId === this.o.userId() && this.isAccepted(e)) out.set(e.moduleId, e.verified);
    return out;
  }
  isActive(moduleId: string) { return this.active().has(moduleId); }

  /** Согласие на разрешения: digest сверяется с манифестом проверенного пакета, а не с тем, что показало окно */
  accept(moduleId: string, sha256: string, digest: string): { ok: true } | { ok: false; error: string } {
    const e = this.entries.get(moduleId), user = this.o.userId();
    if (!user) return { ok: false, error: 'Сначала войдите в программу.' };
    if (!e?.live || !e.verified || e.userId !== user || e.verified.claim.sha256 !== sha256) return { ok: false, error: 'Пакет разработки изменился или больше не запускается: откройте список заново.' };
    if (digest !== permissionsDigest(e.verified.manifest)) return { ok: false, error: 'Разрешения пакета не совпали с показанными: согласие не принято.' };
    this.accepted.add(ModuleDevRuns.consent(user, moduleId, sha256));
    this.o.changed();
    return { ok: true };
  }

  /** «Убрать»: из памяти и папку обмена; Studio при следующем продлении увидит, что папки нет */
  async remove(moduleId: string): Promise<{ ok: boolean; error?: string }> {
    if (!MODULE_ID.test(moduleId)) return { ok: false, error: 'Неверное имя программы.' };
    const dir = path.join(this.o.dir, moduleId);
    this.entries.delete(moduleId);
    for (const key of [...this.accepted]) if (key.split('\u0001')[1] === moduleId) this.accepted.delete(key);
    this.o.changed();
    try {
      const stat = await fs.lstat(dir).catch(() => null);
      // По ссылке ничего не удаляем: только обычная папка внутри папки обмена
      if (stat?.isDirectory()) await fs.rm(dir, { recursive: true, force: true });
      else if (stat) await fs.unlink(dir);
    } catch (e: any) { return { ok: false, error: `Папку обмена не удалось убрать (${e?.code || 'ошибка'}). Программа из разработки остановлена.` }; }
    return { ok: true };
  }
}
