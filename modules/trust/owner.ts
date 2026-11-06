/**
 * Что владелец подписывает — собирается из байт, а не из слов окна.
 *
 * Окно владельца показывает пакет и присылает решение («выпустить в рабочий
 * канал завтра в 9:00»), но описание выпуска главный процесс строит сам: из
 * тех же байт пакета считает SHA-256 и куски и сверяет их с подписанным
 * запросом разработчика. Так ошибка или подмена в окне не превращается в
 * подпись владельца под другим кодом.
 *
 * Только Node: берут главный процесс (electron/moduleSigning.ts) и проверки.
 */
import { openEnvelope, peekEnvelope, sha256Hex } from './envelope';
import { parsePromotionClaim, type PromotionClaim } from './promotion';
import {
  MODULE_CHANNELS, parseCertificateClaim, parsePinClaim, parseReleaseClaim, parseRequestClaim, parseRevocationClaim,
  type CertificateClaim, type PinClaim, type ModuleChannel, type ReleaseClaim, type RequestClaim, type RequestMeta, type RevocationClaim,
} from './claims';
import { unpackBundle } from './bundle';
import { bundleManifest, describeBundle } from './verify';

export function buildReleaseClaim(p: {
  requestId: string; requestSignature: string; bundle: Uint8Array; channel: ModuleChannel; notBefore: number; now?: number;
}): ReleaseClaim {
  const request = parseRequestClaim(peekEnvelope('request', p.requestSignature));
  if (!request) throw new Error('Запрос на публикацию повреждён');
  const digest = describeBundle(p.bundle);
  if (digest.sha256 !== request.sha256 || digest.size !== request.size) throw new Error('Пакет не тот, что прислан в запросе: выпуск не подписан');
  const manifest = bundleManifest(unpackBundle(p.bundle), request.moduleId, request.version);
  if (typeof manifest === 'string') throw new Error(manifest);
  if (!MODULE_CHANNELS.includes(p.channel)) throw new Error('Неизвестный канал выпуска');
  const claim = parseReleaseClaim({
    v: 1, moduleId: request.moduleId, version: request.version, contractVersion: manifest.contractVersion, channel: p.channel,
    notBefore: Math.max(0, Math.floor(p.notBefore || 0)), request: p.requestId, author: request.author, iat: p.now ?? Date.now(), ...digest,
  });
  if (!claim) throw new Error('Описание выпуска не прошло проверку');
  return claim;
}

/** «Внести изменения сам»: новый запрос с ключом владельца поверх запроса разработчика */
export function buildOwnerRequestClaim(p: {
  ownerHex: string; parentSignature: string; parentRequestId: string; bundle: Uint8Array; comment: string; now?: number;
}): RequestClaim {
  const parent = parseRequestClaim(peekEnvelope('request', p.parentSignature));
  if (!parent) throw new Error('Запрос разработчика повреждён');
  const files = unpackBundle(p.bundle);
  const manifest = bundleManifest(files, parent.moduleId, parent.version);
  if (typeof manifest === 'string') throw new Error(manifest);
  const meta: RequestMeta = { ...parent.meta, comment: String(p.comment || '').slice(0, 4000), contractVersion: manifest.contractVersion };
  const claim = parseRequestClaim({
    v: 1, moduleId: parent.moduleId, version: parent.version, baseRelease: parent.baseRelease, parentRequest: p.parentRequestId,
    author: p.ownerHex, meta, iat: p.now ?? Date.now(), ...describeBundle(p.bundle),
  });
  if (!claim) throw new Error('Описание правки не прошло проверку');
  return claim;
}

export function buildRevocationClaim(p: { kind: 'release' | 'key'; target: string; reason: string; now?: number }): RevocationClaim {
  const claim = parseRevocationClaim({ v: 1, kind: p.kind, target: String(p.target || '').trim().toLowerCase(),
    reason: String(p.reason || '').slice(0, 2000), iat: p.now ?? Date.now() });
  if (!claim) throw new Error(p.kind === 'key' ? 'Укажите открытый ключ разработчика (64 знака hex)' : 'Укажите выпуск как модуль@1.2.3');
  return claim;
}

export function buildCertificateClaim(p: { key: string; userId: string; name: string; now?: number }): CertificateClaim {
  const claim = parseCertificateClaim({ v: 1, key: String(p.key || '').trim().toLowerCase(), userId: String(p.userId || ''),
    name: String(p.name || '').slice(0, 200), iat: p.now ?? Date.now() });
  if (!claim) throw new Error('Укажите профиль и открытый ключ разработчика (64 знака hex)');
  return claim;
}

/** Откат: канал модуля не выше версии (null — снять ограничение) */
export function buildPinClaim(p: { moduleId: string; channel: ModuleChannel; version: string | null; reason: string; now?: number }): PinClaim {
  const claim = parsePinClaim({ v: 1, moduleId: String(p.moduleId || ''), channel: p.channel, version: p.version ? String(p.version) : null,
    reason: String(p.reason || '').slice(0, 2000), iat: p.now ?? Date.now() });
  if (!claim) throw new Error('Укажите подпрограмму, канал и версию как 1.2.3');
  return claim;
}

export function buildPromotionClaim(p: { releaseSignature: string; rootHex: string; now?: number }): PromotionClaim {
  const release = parseReleaseClaim(openEnvelope('release', p.releaseSignature, p.rootHex));
  if (!release || release.channel !== 'test') throw new Error('Нужен подписанный владельцем выпуск тестового канала');
  const claim = parsePromotionClaim({ v: 1, moduleId: release.moduleId, version: release.version,
    releaseSignatureHash: sha256Hex(p.releaseSignature), channel: 'production', iat: p.now ?? Date.now() });
  if (!claim) throw new Error('Назначение канала не прошло проверку');
  return claim;
}
