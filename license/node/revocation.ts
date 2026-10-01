import crypto from 'crypto';
import { b64url, publicKeyOf } from './core.js';

export const REVOCATION_PREFIX = 'FLUXREV1';
export interface RevocationPayload { v: 1; inst: string; ids: string[]; iat: number; seq: number }

/** Список накопительный: следующий выпуск не может вернуть ранее отозванный ключ. */
export function signRevocations(payload: Omit<RevocationPayload, 'v'>, privateKey: crypto.KeyObject): string {
  const p: RevocationPayload = { v: 1, ...payload, ids: [...new Set(payload.ids)] };
  const signed = `${REVOCATION_PREFIX}.${b64url(JSON.stringify(p))}`;
  return `${signed}.${b64url(crypto.sign(null, Buffer.from(signed), privateKey))}`;
}

export function readRevocations(code: string, keyHex: string): RevocationPayload | null {
  try {
    if (typeof code !== 'string' || code.length > 2000000) return null;
    const p = code.replace(/\s+/g, '').split('.');
    const key = publicKeyOf(keyHex);
    if (!key || p.length !== 3 || p[0] !== REVOCATION_PREFIX || !/^[A-Za-z0-9_-]+$/.test(p[1]) || !/^[A-Za-z0-9_-]{86}$/.test(p[2])) return null;
    if (!crypto.verify(null, Buffer.from(`${p[0]}.${p[1]}`), key, Buffer.from(p[2], 'base64url'))) return null;
    const j = JSON.parse(Buffer.from(p[1], 'base64url').toString('utf8'));
    if (j?.v !== 1 || typeof j.inst !== 'string' || !j.inst.trim() || j.inst.length > 200 || !Number.isSafeInteger(j.seq) || j.seq < 1 || !Number.isSafeInteger(j.iat) || j.iat < 0 || !Array.isArray(j.ids) || j.ids.length > 10000 || !j.ids.every((id: unknown) => typeof id === 'string' && !!id && id.length <= 128 && !/[\x00-\x1f]/.test(id))) return null;
    return { v: 1, inst: j.inst, ids: [...new Set<string>(j.ids)], iat: j.iat, seq: j.seq };
  } catch (_) { return null; }
}

export function acceptsRevocations(next: RevocationPayload, previous: RevocationPayload | null, inst: string): boolean {
  return next.inst === inst && (!previous || (next.seq > previous.seq && next.iat >= previous.iat && previous.ids.every(id => next.ids.includes(id))));
}
