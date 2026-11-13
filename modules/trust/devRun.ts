/**
 * «Запустить во Flux» из Studio: проверка пакета разработки.
 *
 * Пакет разработки — не выпуск: владелец его не проверял и не подписывал.
 * Поэтому доверие к нему отдельное и узкое, и сходиться обязано ВСЁ:
 * 1. сертификат разработчика подписан владельцем (корень, зашит в exe) и не
 *    отозван — «кто угодно с доступом к папке» пакет не подложит;
 * 2. сертификат выдан тому, кто сейчас вошёл во Flux: чужой пакет у другого
 *    человека не запускается, даже на том же компьютере;
 * 3. пакет и аренда подписаны ключом из этого сертификата. Ключ лежит в
 *    защищённом хранилище учётной записи Windows разработчика — подпись и
 *    привязывает пакет к его компьютеру;
 * 4. аренда свежая: Studio переподписывает её, пока открыта. Закрыли Studio
 *    или нажали «Убрать» — запуск прекращается сам, без связи с сервером;
 * 5. пакет совпадает с подписью, манифест и файлы проходят те же проверки
 *    формата и исполнения, что у выпуска.
 * Проверка даёт только право ЗАПУСТИТЬ: мост, разрешения и запрет записи в
 * данные Flux у пакета разработки те же, что у выпуска (modules/bridge.ts).
 *
 * Только Node: главный процесс Flux, Studio и проверки.
 */
import { openEnvelope } from './envelope';
import { parseCertificateClaim, parseDevLeaseClaim, parseDevRunClaim, type DevLeaseClaim, type DevRunClaim, type ReleaseClaim } from './claims';
import { unpackBundle, type BundleFiles } from './bundle';
import { bundleManifest, describeBundle, type RevokedSet, type RunnableRelease, type Verified } from './verify';
import { executionProblem, interfaceProblem } from './execution';
import { languageOf, platformOf } from '../engine/types';

/** Как часто Studio продлевает аренду */
export const DEV_LEASE_RENEW_MS = 20_000;
/** Аренда старше этого — Studio закрыта или зависла: запуск прекращается. Три пропущенных продления */
export const DEV_LEASE_TTL_MS = 75_000;
/** Допуск на часы: аренда «из будущего» дальше этого — не наша */
const DEV_LEASE_SKEW_MS = 60_000;
/** Отметка в `request` у собранной записи: по ней пакет разработки отличают от выпуска */
export const DEV_RUN_REQUEST = 'dev-run';

/** Имена файлов в папке обмена `<данные Flux>/dev-run/<moduleId>/`; пишет Studio, читает Flux */
export const DEV_RUN_DIR = 'dev-run';
export const DEV_RUN_FILES = { run: 'run.json', lease: 'lease.txt', bundle: 'package.bin' } as const;
/** run.json: подписанный пакет разработки и сертификат разработчика (он подписан владельцем, подделать его в файле нельзя) */
export interface DevRunFile { v: 1; run: string; certificate: string }

export interface DevRunnable extends RunnableRelease { dev: DevRunClaim; lease: DevLeaseClaim; developer: string }

export function devRunPayload(input: { moduleId: string; version: string; author: string; userId: string; bundle: Uint8Array; now: number }): DevRunClaim {
  return { v: 1, moduleId: input.moduleId, version: input.version, author: input.author, userId: input.userId, iat: input.now, ...describeBundle(input.bundle) };
}
export const devLeasePayload = (run: DevRunClaim, now: number): DevLeaseClaim => ({ v: 1, sha256: run.sha256, author: run.author, iat: now });

/** Только аренда: главный процесс перечитывает её чаще, чем пакет */
export function leaseProblem(input: { lease: string; run: DevRunClaim; now: number }): string {
  const lease = parseDevLeaseClaim(openEnvelope('devLease', input.lease, input.run.author));
  if (!lease || lease.author !== input.run.author || lease.sha256 !== input.run.sha256) return 'Аренда пакета разработки не подтверждена';
  if (input.now - lease.iat > DEV_LEASE_TTL_MS) return 'Studio закрыта: запуск из разработки прекращён';
  if (lease.iat - input.now > DEV_LEASE_SKEW_MS) return 'Аренда пакета разработки не подтверждена';
  return '';
}

export function verifyDevRun(input: {
  run: string; lease: string; certificate: string; bundle: Uint8Array;
  rootHex: string; revoked: RevokedSet; now: number;
  /** Кто сейчас вошёл во Flux; пусто — никто, пакет не запускается */
  userId: string;
  hostPlatform?: string;
}): Verified<DevRunnable> {
  if (!input.rootHex) return { ok: false, why: 'В этой сборке нет ключа владельца: программы из разработки не запускаются' };
  if (!input.userId) return { ok: false, why: 'Сначала войдите в программу' };
  const cert = parseCertificateClaim(openEnvelope('certificate', input.certificate, input.rootHex));
  if (!cert) return { ok: false, why: 'У ключа разработчика нет сертификата владельца' };
  if (input.revoked.keys.has(cert.key)) return { ok: false, why: 'Сертификат разработчика отозван' };
  if (cert.userId !== input.userId) return { ok: false, why: 'Пакет разработки собран другим человеком: он запускается только у своего разработчика' };
  const dev = parseDevRunClaim(openEnvelope('devRun', input.run, cert.key));
  if (!dev || dev.author !== cert.key) return { ok: false, why: 'Подпись пакета разработки не сходится с ключом разработчика' };
  if (dev.userId !== input.userId) return { ok: false, why: 'Пакет разработки собран другим человеком: он запускается только у своего разработчика' };
  const leaseWhy = leaseProblem({ lease: input.lease, run: dev, now: input.now });
  if (leaseWhy) return { ok: false, why: leaseWhy };
  const lease = parseDevLeaseClaim(openEnvelope('devLease', input.lease, cert.key))!;
  const digest = describeBundle(input.bundle);
  if (digest.size !== dev.size || digest.sha256 !== dev.sha256) return { ok: false, why: 'Пакет не совпадает с подписанным' };
  let files: BundleFiles;
  try { files = unpackBundle(input.bundle); } catch (e: any) { return { ok: false, why: e.message }; }
  const manifest = bundleManifest(files, dev.moduleId, dev.version);
  if (typeof manifest === 'string') return { ok: false, why: manifest };
  const surface = interfaceProblem(manifest, files);
  if (surface) return { ok: false, why: surface };
  if (input.hostPlatform && platformOf(manifest) === 'windows' && input.hostPlatform !== 'win32') {
    return { ok: false, why: 'Программа только для Windows и на этой системе не запускается' };
  }
  const execution = executionProblem(manifest, files);
  if (execution) return { ok: false, why: execution };
  // Остальной Flux работает с записью выпуска: собираем её из пакета разработки. Подписи владельца у неё нет и быть не может —
  // запись живёт только в памяти главного процесса и в кэш проверенных выпусков не попадает.
  const claim: ReleaseClaim = {
    v: 1, moduleId: dev.moduleId, version: dev.version, contractVersion: manifest.contractVersion, channel: 'test', notBefore: 0,
    request: DEV_RUN_REQUEST, author: dev.author, iat: dev.iat, size: dev.size, sha256: dev.sha256, chunks: dev.chunks,
    language: languageOf(manifest), platform: platformOf(manifest),
  };
  return { ok: true, claim, manifest, files, signature: input.run, dev, lease, developer: cert.name };
}
