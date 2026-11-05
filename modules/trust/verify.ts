/**
 * Проверка цепочки доверия модуля — одна на сервер и главный процесс.
 *
 * Выпуск запускается, только если ВСЁ сходится:
 * 1. подпись выпуска — ключом владельца (корень, зашит в exe). Подпись
 *    разработчика, даже с сертификатом, выпуск не делает: так разработчик не
 *    может выложить непроверенный код;
 * 2. запись в таблице говорит о том же модуле и версии, что подпись;
 * 3. выпуск и ключ его автора не отозваны (отзыв тоже подписан владельцем);
 * 4. время выпуска наступило;
 * 5. каждый кусок и весь пакет совпадают по SHA-256 с подписанным списком;
 * 6. внутри пакета манифест того же модуля и версии и собранный runtime.js.
 * Что-то не сошлось — причина словами, выпуск не запускается; предыдущий
 * проверенный выпуск из кэша продолжает работать (electron/moduleCache.ts).
 */
import { openEnvelope, peekEnvelope, sha256Hex } from './envelope';
import {
  parseCertificateClaim, parseReleaseClaim, parseRequestClaim, parseRevocationClaim, releaseKey,
  type CertificateClaim, type ReleaseClaim, type RequestClaim, type BundleDigest,
} from './claims';
import { joinChunks, splitChunks, unpackBundle, bundleText, RUNTIME_FILE, type BundleFiles } from './bundle';
import { validManifest } from '../schemas';
import { CONTRACT_VERSION, type ModuleManifest } from '../contract';

export interface RevokedSet { releases: Set<string>; keys: Set<string> }
export type Verified<T> = { ok: true } & T | { ok: false; why: string };

/** Отзывы с подписью владельца; чужие и битые записи молча пропускаются — они ничего не отзывают и не отменяют */
export function readRevocations(envelopes: readonly string[], rootHex: string): RevokedSet & { valid: string[] } {
  const out = { releases: new Set<string>(), keys: new Set<string>(), valid: [] as string[] };
  for (const text of envelopes) {
    const claim = parseRevocationClaim(openEnvelope('revocation', text, rootHex));
    if (!claim) continue;
    (claim.kind === 'key' ? out.keys : out.releases).add(claim.target);
    out.valid.push(text);
  }
  return out;
}

export function describeBundle(bytes: Uint8Array): BundleDigest {
  return { size: bytes.length, sha256: sha256Hex(bytes), chunks: splitChunks(bytes).map((c) => sha256Hex(c)) };
}

/** Куски сходятся с подписанным описанием: по каждому куску и целиком */
export function checkChunks(digest: BundleDigest, chunks: readonly Uint8Array[]): string {
  if (chunks.length !== digest.chunks.length) return `В базе ${chunks.length} кусков из ${digest.chunks.length}`;
  for (let i = 0; i < chunks.length; i++) {
    if (!chunks[i]?.length || sha256Hex(chunks[i]) !== digest.chunks[i]) return `Кусок ${i + 1} не совпадает с подписанным`;
  }
  const whole = joinChunks(chunks as Uint8Array[]);
  if (whole.length !== digest.size || sha256Hex(whole) !== digest.sha256) return 'Пакет не совпадает с подписанным';
  return '';
}

/** Манифест из пакета: тот же модуль и версия, что в подписи, и договор, который эта сборка Flux понимает */
export function bundleManifest(files: BundleFiles, moduleId: string, version: string): ModuleManifest | string {
  let manifest: unknown;
  try { manifest = JSON.parse(bundleText(files, 'manifest.json') || ''); } catch { return 'В пакете нет корректного manifest.json'; }
  if (!validManifest(manifest)) return 'manifest.json не соответствует договору';
  const m = manifest as ModuleManifest;
  if (m.id !== moduleId || m.version !== version) return 'manifest.json описывает другой модуль или версию';
  if (m.contractVersion > CONTRACT_VERSION) return `Модулю нужен договор v${m.contractVersion}: обновите Flux`;
  return m;
}

export interface RunnableRelease { claim: ReleaseClaim; manifest: ModuleManifest; files: BundleFiles; signature: string }

export function verifyRelease(input: {
  signature: string; chunks: readonly Uint8Array[]; rootHex: string; revoked: RevokedSet; now: number;
  /** Что сказано в строке таблицы: подпись обязана говорить о том же */
  moduleId?: string; version?: string;
}): Verified<RunnableRelease> {
  if (!input.rootHex) return { ok: false, why: 'В этой сборке нет ключа владельца: модули из базы не запускаются' };
  if (!String(input.signature || '').trim()) return { ok: false, why: 'У выпуска нет подписи владельца' };
  const claim = parseReleaseClaim(openEnvelope('release', input.signature, input.rootHex));
  if (!claim) {
    const peek = parseReleaseClaim(peekEnvelope('release', input.signature));
    return { ok: false, why: peek ? 'Выпуск подписан не владельцем: такой выпуск не запускается' : 'Подпись выпуска не подтверждена' };
  }
  if ((input.moduleId && input.moduleId !== claim.moduleId) || (input.version && input.version !== claim.version)) {
    return { ok: false, why: 'Запись в базе не совпадает с подписанным выпуском' };
  }
  if (input.revoked.releases.has(releaseKey(claim.moduleId, claim.version))) return { ok: false, why: 'Выпуск отозван владельцем' };
  if (input.revoked.keys.has(claim.author)) return { ok: false, why: 'Сертификат разработчика выпуска отозван' };
  if (claim.notBefore > input.now) return { ok: false, why: 'Время выпуска ещё не наступило' };
  const chunks = checkChunks(claim, input.chunks);
  if (chunks) return { ok: false, why: chunks };
  let files: BundleFiles;
  try { files = unpackBundle(joinChunks(input.chunks as Uint8Array[])); } catch (e: any) { return { ok: false, why: e.message }; }
  const manifest = bundleManifest(files, claim.moduleId, claim.version);
  if (typeof manifest === 'string') return { ok: false, why: manifest };
  if (manifest.contractVersion !== claim.contractVersion) return { ok: false, why: 'Версия договора в подписи и в manifest.json разная' };
  if (!files[RUNTIME_FILE]?.length) return { ok: false, why: `В пакете нет ${RUNTIME_FILE}` };
  return { ok: true, claim, manifest, files, signature: input.signature };
}

/** Сертификаты с подписью владельца, без отозванных ключей: ключ → сертификат */
export function readCertificates(envelopes: readonly string[], rootHex: string, revoked: RevokedSet): Map<string, CertificateClaim> {
  const out = new Map<string, CertificateClaim>();
  for (const text of envelopes) {
    const claim = parseCertificateClaim(openEnvelope('certificate', text, rootHex));
    if (claim && !revoked.keys.has(claim.key)) out.set(claim.key, claim);
  }
  return out;
}

/**
 * Запрос на публикацию: подписан ключом из действующего сертификата (или
 * ключом владельца — «изменения владельца»), пакет совпадает с подписью.
 */
export function verifyRequest(input: {
  signature: string; bundle: Uint8Array; rootHex: string; certificates: Map<string, CertificateClaim>;
}): Verified<{ claim: RequestClaim; files: BundleFiles; manifest: ModuleManifest; byOwner: boolean }> {
  const peek = parseRequestClaim(peekEnvelope('request', input.signature));
  if (!peek) return { ok: false, why: 'Запрос на публикацию повреждён или в неизвестном формате' };
  const byOwner = !!input.rootHex && peek.author === input.rootHex;
  if (!byOwner && !input.certificates.has(peek.author)) return { ok: false, why: 'У ключа разработчика нет действующего сертификата владельца' };
  const claim = parseRequestClaim(openEnvelope('request', input.signature, peek.author));
  if (!claim) return { ok: false, why: 'Подпись запроса не сходится с ключом разработчика' };
  const digest = describeBundle(input.bundle);
  if (digest.size !== claim.size || digest.sha256 !== claim.sha256) return { ok: false, why: 'Пакет не совпадает с подписанным запросом' };
  let files: BundleFiles;
  try { files = unpackBundle(input.bundle); } catch (e: any) { return { ok: false, why: e.message }; }
  const manifest = bundleManifest(files, claim.moduleId, claim.version);
  if (typeof manifest === 'string') return { ok: false, why: manifest };
  if (manifest.contractVersion !== claim.meta.contractVersion) return { ok: false, why: 'Версия договора в запросе и в manifest.json разная' };
  if (!files[RUNTIME_FILE]?.length) return { ok: false, why: `В пакете нет ${RUNTIME_FILE}` };
  return { ok: true, claim, files, manifest, byOwner };
}
