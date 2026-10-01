import crypto from 'crypto';

export const OWNER_CHALLENGE_TTL = 60_000;
const PUBLIC_DER_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export interface OwnerChallenge {
  nonce: string; message: string; expiresAt: number;
}

/** Ограниченное хранилище одноразовых вызовов. Любая попытка расходует nonce. */
export class OwnerChallenges {
  private pending = new Map<string, OwnerChallenge>();
  constructor(private keys: readonly string[], private clock = Date.now) {}
  issue(installationId: string, origin: string): OwnerChallenge {
    const now = this.clock();
    for (const [nonce, c] of this.pending) if (c.expiresAt <= now) this.pending.delete(nonce);
    if (this.pending.size >= 1000) throw new Error('Слишком много незавершенных запросов входа');
    const nonce = crypto.randomBytes(32).toString('base64url');
    const expiresAt = now + OWNER_CHALLENGE_TTL;
    const c = { nonce, expiresAt, message: JSON.stringify({ purpose: 'flux-owner-login', version: 1, installationId, origin, nonce, expiresAt }) };
    this.pending.set(nonce, c);
    return c;
  }
  verify(nonce: unknown, sig: unknown, installationId: string, origin: string): boolean {
    if (typeof nonce !== 'string') return false;
    const c = this.pending.get(nonce);
    this.pending.delete(nonce);
    if (!c || c.expiresAt <= this.clock() || typeof sig !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(sig)) return false;
    const context = JSON.parse(c.message);
    if (context.installationId !== installationId || context.origin !== origin) return false;
    const signature = Buffer.from(sig, 'base64');
    if (signature.length !== 64) return false;
    return this.keys.some(hex => {
      if (!/^[a-f0-9]{64}$/i.test(hex)) return false;
      try {
        const publicKey = crypto.createPublicKey({ key: Buffer.concat([PUBLIC_DER_PREFIX, Buffer.from(hex, 'hex')]), type: 'spki', format: 'der' });
        return crypto.verify(null, Buffer.from(c.message, 'utf8'), publicKey, signature);
      } catch (_) { return false; }
    });
  }
}
