/**
 * Подпись владельца для подпрограмм: выпуск, правка владельца, отзыв, сертификат, откат канала.
 *
 * Перенесено из Flux (там это был electron/moduleSigning.ts и окно OwnerSignDialog): закрытый
 * ключ издателя (`keys.update`) лежит в хранилище владельца и не покидает главный процесс
 * Studio — Владелец; раздел получает только готовую подпись. Что именно подписывается,
 * процесс собирает сам из байт пакета (modules/trust/owner.ts), а не берёт готовым из окна.
 */
import crypto from 'node:crypto';
import { publicHexOf, sealEnvelope, type EnvelopeKind } from '../../../modules/trust/envelope';
import {
  buildCertificateClaim, buildOwnerRequestClaim, buildPinClaim, buildPromotionClaim, buildReleaseClaim, buildRevocationClaim,
} from '../../../modules/trust/owner';
import { MODULE_BUNDLE_MAX } from '../../../modules/trust/claims';

const bytesOf = (value: unknown) => {
  const text = String(value || '');
  if (text.length > Math.ceil(MODULE_BUNDLE_MAX / 3) * 4 + 4) throw new Error('Пакет модуля слишком велик');
  return new Uint8Array(Buffer.from(text, 'base64'));
};

/** Что подписать — по виду запроса; всё остальное в нём игнорируется */
export function moduleClaimFor(request: any, ownerHex: string): { kind: EnvelopeKind; claim: unknown } {
  switch (request?.kind) {
    case 'promotion': return { kind: 'promotion', claim: buildPromotionClaim({ releaseSignature: String(request.releaseSignature || ''), rootHex: ownerHex }) };
    case 'release': return { kind: 'release', claim: buildReleaseClaim({ requestId: String(request.requestId || ''),
      requestSignature: String(request.requestSignature || ''), bundle: bytesOf(request.bundle), channel: request.channel,
      notBefore: Number(request.notBefore) || 0 }) };
    case 'owner-edit': return { kind: 'request', claim: buildOwnerRequestClaim({ ownerHex, parentSignature: String(request.parentSignature || ''),
      parentRequestId: String(request.parentRequestId || ''), bundle: bytesOf(request.bundle), comment: String(request.comment || '') }) };
    case 'revocation': return { kind: 'revocation', claim: buildRevocationClaim({ kind: request.target === 'key' ? 'key' : 'release', target: request.value, reason: request.reason }) };
    case 'certificate': return { kind: 'certificate', claim: buildCertificateClaim({ key: request.key, userId: request.userId, name: request.name }) };
    case 'pin': return { kind: 'pin', claim: buildPinClaim({ moduleId: String(request.moduleId || ''), channel: request.channel,
      version: request.version ? String(request.version) : null, reason: String(request.reason || '') }) };
    default: throw new Error('Неизвестное действие подписи');
  }
}

/** Подпись ключом издателя из открытого хранилища; запасное хранилище ключа издателя не содержит */
export function signModule(vault: any, request: any): string {
  if (vault?.kind !== 'main' || !vault.keys?.update?.privatePem) throw new Error('Нужно основное хранилище владельца: в запасном нет ключа издателя.');
  const key = crypto.createPrivateKey(vault.keys.update.privatePem);
  // Проверка до подписи: ошибка в пакете не должна оставлять подпись под чужими байтами
  const preview = moduleClaimFor(request, publicHexOf(key));
  return sealEnvelope(preview.kind, preview.claim, key);
}
