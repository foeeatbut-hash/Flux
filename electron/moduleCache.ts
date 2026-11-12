/**
 * Кэш проверенных выпусков модулей на этом компьютере.
 *
 * Зачем: Flux не доверяет таблицам общей базы (их может переписать любой с
 * реквизитами SQL) и не обязан быть на связи. Поэтому:
 * - выпуск попадает в кэш только после полной проверки (modules/trust/verify.ts);
 * - при запуске кэш проверяется ЗАНОВО — подпись и SHA-256 каждого куска: файл
 *   на диске тоже можно подменить;
 * - запускается самый новый выпуск, который прошёл проверку; не прошёл
 *   (изменён кусок, отозван, подписан не владельцем) — работает прошлый
 *   проверенный;
 * - отзывы, однажды увиденные, хранятся здесь и не забываются: удалить строку
 *   отзыва из базы — не значит вернуть отозванный выпуск;
 * - выпуск, пропавший из базы, продолжает работать из кэша: удалить новую
 *   строку, чтобы вернуть старую версию, нельзя. Откат — решение владельца:
 *   подписанное назначение канала («не выше версии X», FLUXMODPIN1); как и
 *   отзывы, назначения только добавляются, а из двух побеждает более позднее.
 *
 * Без electron: проверяется скриптом (scripts/test-modules-publishing.ts).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { splitChunks } from '../modules/trust/bundle';
import { sha256Hex } from '../modules/trust/envelope';
import { readPins, readRevocations, verifyRelease, type ChannelCaps, type RevokedSet, type RunnableRelease } from '../modules/trust/verify';
import { MODULE_ID, MODULE_VERSION, type ModuleChannel } from '../modules/trust/claims';
import { effectiveChannel, readPromotions } from '../modules/trust/promotion';
import { compareVersions } from '../shared/versionCompare';

/** Сколько проверенных версий модуля держать: «Вернуть предыдущую версию» без связи (Flux Store) */
export const KEEP_VERSIONS = 3;

export interface ReleaseRow { id: string; moduleId: string; version: string; signature: string }
export interface CachedRelease { moduleId: string; version: string; signatureHash: string }
export interface SyncReport { installed: string[]; broken: Array<{ moduleId: string; version: string; why: string }> }

async function atomicWrite(file: string, data: Uint8Array | string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, file);
}

export class ModuleCache {
  constructor(private dir: string, private rootHex: string, private now: () => number = Date.now) {}

  private releaseDir(moduleId: string, version: string) {
    if (!MODULE_ID.test(moduleId) || !MODULE_VERSION.test(version)) throw new Error('Недопустимое имя модуля или версии');
    return path.join(this.dir, 'releases', moduleId, version);
  }

  async revoked(): Promise<RevokedSet & { valid: string[] }> {
    let saved: unknown = [];
    try { saved = JSON.parse(await fs.readFile(path.join(this.dir, 'revocations.json'), 'utf8')); } catch { /* ещё не было */ }
    return readRevocations(Array.isArray(saved) ? saved.filter((s) => typeof s === 'string') : [], this.rootHex);
  }

  async pins(): Promise<{ caps: ChannelCaps; valid: string[] }> {
    let saved: unknown = [];
    try { saved = JSON.parse(await fs.readFile(path.join(this.dir, 'pins.json'), 'utf8')); } catch { /* ещё не было */ }
    return readPins(Array.isArray(saved) ? saved.filter((s) => typeof s === 'string') : [], this.rootHex);
  }

  async promotions() {
    let saved: unknown = [];
    try { saved = JSON.parse(await fs.readFile(path.join(this.dir, 'promotions.json'), 'utf8')); } catch { /* ещё не было */ }
    return readPromotions(Array.isArray(saved) ? saved.filter((s): s is string => typeof s === 'string') : [], this.rootHex);
  }

  async addPromotions(envelopes: readonly string[]): Promise<void> {
    const known = await this.promotions();
    const fresh = readPromotions(envelopes, this.rootHex).valid.filter(s => !known.valid.includes(s));
    if (fresh.length) await atomicWrite(path.join(this.dir, 'promotions.json'), JSON.stringify([...new Set([...known.valid, ...fresh])]));
  }

  async addPins(envelopes: readonly string[]): Promise<ChannelCaps> {
    const known = await this.pins();
    const fresh = readPins(envelopes, this.rootHex).valid.filter((s) => !known.valid.includes(s));
    // Список растёт, но не бесконечно: по каждой паре «модуль, канал» нужна только последняя запись
    if (fresh.length) await atomicWrite(path.join(this.dir, 'pins.json'), JSON.stringify([...known.valid, ...fresh].slice(-2000)));
    return fresh.length ? (await this.pins()).caps : known.caps;
  }

  /** Новые отзывы добавляются к увиденным; запись без подписи владельца не сохраняется */
  async addRevocations(envelopes: readonly string[]): Promise<RevokedSet> {
    const known = await this.revoked();
    const fresh = readRevocations(envelopes, this.rootHex).valid.filter((s) => !known.valid.includes(s));
    if (fresh.length) await atomicWrite(path.join(this.dir, 'revocations.json'), JSON.stringify([...known.valid, ...fresh]));
    return fresh.length ? this.revoked() : known;
  }

  async cached(): Promise<CachedRelease[]> {
    const out: CachedRelease[] = [];
    const modules = await fs.readdir(path.join(this.dir, 'releases')).catch(() => [] as string[]);
    for (const moduleId of modules.filter((m) => MODULE_ID.test(m))) {
      const versions = await fs.readdir(path.join(this.dir, 'releases', moduleId)).catch(() => [] as string[]);
      for (const version of versions.filter((v) => MODULE_VERSION.test(v))) {
        const signature = await fs.readFile(path.join(this.releaseDir(moduleId, version), 'release.sig'), 'utf8').catch(() => '');
        if (signature) out.push({ moduleId, version, signatureHash: sha256Hex(signature) });
      }
    }
    return out;
  }

  /** Проверить скачанный выпуск и положить в кэш. Не прошёл — в кэш не попадает, прошлый остаётся */
  async install(row: ReleaseRow, chunks: Uint8Array[]): Promise<{ ok: boolean; why?: string }> {
    const revoked = await this.revoked();
    const checked = verifyRelease({ signature: row.signature, chunks, rootHex: this.rootHex, revoked, now: Number.MAX_SAFE_INTEGER,
      moduleId: row.moduleId, version: row.version });
    // Время выпуска проверяется при запуске, а не при скачивании: выпуск «на завтра» качается заранее
    if (!checked.ok) return checked;
    const dir = this.releaseDir(row.moduleId, row.version);
    await atomicWrite(path.join(dir, 'bundle.bin'), Buffer.concat(chunks.map((c) => Buffer.from(c))));
    await atomicWrite(path.join(dir, 'release.sig'), row.signature);
    return { ok: true };
  }

  /** Все проверенные выпуски модуля, новые первыми; каждый проверяется с диска заново */
  async verifiedVersions(moduleId: string, channels: readonly ModuleChannel[] = ['production']): Promise<Array<RunnableRelease | { version: string; why: string }>> {
    const revoked = await this.revoked();
    const { caps } = await this.pins();
    const { claims: promotions } = await this.promotions();
    const versions = (await fs.readdir(path.join(this.dir, 'releases', moduleId)).catch(() => [] as string[]))
      .filter((v) => MODULE_VERSION.test(v)).sort((a, b) => compareVersions(b, a));
    const out: Array<RunnableRelease | { version: string; why: string }> = [];
    for (const version of versions) {
      const dir = this.releaseDir(moduleId, version);
      const [signature, bundle] = await Promise.all([fs.readFile(path.join(dir, 'release.sig'), 'utf8').catch(() => ''), fs.readFile(path.join(dir, 'bundle.bin')).catch(() => null)]);
      const checked = verifyRelease({ signature, chunks: bundle ? splitChunks(new Uint8Array(bundle)) : [], rootHex: this.rootHex, revoked, now: this.now(), moduleId, version, caps, promotions, hostPlatform: process.platform });
      if (!checked.ok) { out.push({ version, why: checked.why }); continue; }
      const channel = effectiveChannel(checked.claim, signature, promotions);
      if (!channels.includes(channel)) { out.push({ version, why: `Выпуск в канале «${channel}»` }); continue; }
      out.push(checked);
    }
    return out;
  }

  /** Что запускать: по модулю — самый новый проверенный выпуск разрешённого канала */
  async runnable(channels: readonly ModuleChannel[] = ['production']): Promise<Map<string, RunnableRelease>> {
    const out = new Map<string, RunnableRelease>();
    const modules = await fs.readdir(path.join(this.dir, 'releases')).catch(() => [] as string[]);
    for (const moduleId of modules.filter((m) => MODULE_ID.test(m))) {
      const first = (await this.verifiedVersions(moduleId, channels)).find((r): r is RunnableRelease => 'claim' in r);
      if (first) out.set(moduleId, first);
    }
    return out;
  }

  /** Версии, которые можно запустить прямо сейчас (проверены, в разрешённом канале), новые первыми */
  async available(moduleId: string, channels: readonly ModuleChannel[] = ['production']): Promise<RunnableRelease[]> {
    return (await this.verifiedVersions(moduleId, channels)).filter((r): r is RunnableRelease => 'claim' in r);
  }

  /**
   * Что запускать из установленного: по каждой программе — выбранная
   * версия, а если она больше не проходит проверку (отозвана, выше отката
   * владельца, повреждена) — ближайшая более старая проверенная. Это и есть
   * «отзыв откатывает всех»: версия меняется без человека, но только вниз и
   * только на то, что владелец подписал.
   */
  async resolve(wanted: Record<string, string>, channels: readonly ModuleChannel[] = ['production']): Promise<Map<string, RunnableRelease>> {
    const out = new Map<string, RunnableRelease>();
    for (const [moduleId, version] of Object.entries(wanted)) {
      if (!MODULE_ID.test(moduleId) || !MODULE_VERSION.test(version)) continue;
      const found = (await this.available(moduleId, channels)).find((r) => compareVersions(r.claim.version, version) <= 0);
      if (found) out.set(moduleId, found);
    }
    return out;
  }

  /** Предыдущая версия для «Вернуть»: ближайшая старше выбранной из уже лежащих на диске — работает без связи */
  async previous(moduleId: string, current: string, channels: readonly ModuleChannel[] = ['production']): Promise<RunnableRelease | null> {
    return (await this.available(moduleId, channels)).find((r) => compareVersions(r.claim.version, current) < 0) || null;
  }

  /** Держать KEEP_VERSIONS новейших проверенных версий и выбранную человеком; отозванные и битые убирать */
  async prune(selected: readonly string[] = []): Promise<void> {
    const modules = await fs.readdir(path.join(this.dir, 'releases')).catch(() => [] as string[]);
    for (const moduleId of modules.filter((m) => MODULE_ID.test(m))) {
      const all = await this.verifiedVersions(moduleId, ['production', 'test']);
      const keep = new Set(all.filter((r): r is RunnableRelease => 'claim' in r).slice(0, KEEP_VERSIONS).map((r) => r.claim.version));
      // Выбранную человеком версию не убираем, даже если новее неё уже три: иначе она «пропала бы» без связи
      for (const r of all) if ('claim' in r && selected.includes(`${moduleId}@${r.claim.version}`)) keep.add(r.claim.version);
      for (const r of all) {
        const version = 'claim' in r ? r.claim.version : r.version;
        // Выпуск «на завтра» и выпуск выше отката владельца битыми не считаются: время придёт или откат снимут
        if (!keep.has(version) && !('why' in r && /не наступило|вернул канал/.test(r.why))) await fs.rm(this.releaseDir(moduleId, version), { recursive: true, force: true });
      }
    }
  }
}

/**
 * Обмен с сервером: отзывы, список выпусков, куски новых. Сервер отдаёт как
 * есть — проверяет кэш. `get` — запрос к API от имени вошедшего человека.
 */
export async function syncModuleReleases(cache: ModuleCache, get: (route: string) => Promise<any>): Promise<SyncReport> {
  const report: SyncReport = { installed: [], broken: [] };
  const revocations = await get('/api/modules/revocations');
  await cache.addRevocations(Array.isArray(revocations?.revocations) ? revocations.revocations : []);
  const pins = await get('/api/modules/pins');
  await cache.addPins(Array.isArray(pins?.pins) ? pins.pins : []);
  const promotions = await get('/api/modules/promotions');
  await cache.addPromotions(Array.isArray(promotions?.promotions) ? promotions.promotions : []);
  const list = await get('/api/modules/releases');
  const known = new Set((await cache.cached()).map((c) => `${c.moduleId}@${c.version}`));
  for (const row of Array.isArray(list?.releases) ? list.releases as ReleaseRow[] : []) {
    if (!row || typeof row.id !== 'string' || !MODULE_ID.test(row.moduleId) || !MODULE_VERSION.test(row.version)) continue;
    if (known.has(`${row.moduleId}@${row.version}`)) continue;
    try {
      const body = await get(`/api/modules/releases/${encodeURIComponent(row.id)}/chunks`);
      const chunks = (Array.isArray(body?.chunks) ? body.chunks : []).map((c: string) => new Uint8Array(Buffer.from(String(c), 'base64')));
      const result = await cache.install(row, chunks);
      if (result.ok) report.installed.push(`${row.moduleId}@${row.version}`);
      else report.broken.push({ moduleId: row.moduleId, version: row.version, why: result.why });
    } catch (e: any) { report.broken.push({ moduleId: row.moduleId, version: row.version, why: e?.message || 'Не скачан' }); }
  }
  await cache.prune();
  return report;
}
