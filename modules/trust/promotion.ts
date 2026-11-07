import { MODULE_ID, MODULE_VERSION, type ModuleChannel, type ReleaseClaim } from './claims';
import { openEnvelope, sha256Hex } from './envelope';

export interface PromotionClaim { v: 1; moduleId: string; version: string; releaseSignatureHash: string; channel: 'production'; iat: number }

export function parsePromotionClaim(value: unknown): PromotionClaim | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const keys = ['v', 'moduleId', 'version', 'releaseSignatureHash', 'channel', 'iat'];
  if (Object.keys(v).length !== keys.length || !keys.every(k => Object.hasOwn(v, k)) || v.v !== 1
    || typeof v.moduleId !== 'string' || !MODULE_ID.test(v.moduleId) || typeof v.version !== 'string' || !MODULE_VERSION.test(v.version)
    || typeof v.releaseSignatureHash !== 'string' || !/^[0-9a-f]{64}$/.test(v.releaseSignatureHash)
    || v.channel !== 'production' || !Number.isSafeInteger(v.iat) || (v.iat as number) < 0) return null;
  return v as unknown as PromotionClaim;
}

export function readPromotions(envelopes: readonly string[], rootHex: string): { claims: PromotionClaim[]; valid: string[] } {
  const claims: PromotionClaim[] = [], valid: string[] = [];
  for (const text of envelopes) {
    const claim = parsePromotionClaim(openEnvelope('promotion', text, rootHex));
    if (claim) { claims.push(claim); valid.push(text); }
  }
  return { claims, valid };
}

export function effectiveChannel(claim: ReleaseClaim, signature: string, promotions: readonly PromotionClaim[]): ModuleChannel {
  return claim.channel === 'test' && promotions.some(p => p.moduleId === claim.moduleId && p.version === claim.version
    && p.releaseSignatureHash === sha256Hex(signature)) ? 'production' : claim.channel;
}
