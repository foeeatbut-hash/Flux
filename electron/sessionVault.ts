import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export interface SessionEncryption {
  available(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}
/** The server origin is part of the filename; a different server gets no token. */
export function createSessionVault(directory: string, origin: string, encryption: SessionEncryption) {
  const file = path.join(directory, `session-${crypto.createHash('sha256').update(origin).digest('hex')}.enc`);
  const read = (): string => {
    if (!encryption.available()) return '';
    try {
      const encrypted = fs.readFileSync(file);
      if (encrypted.length > 16384) return '';
      const token = encryption.decrypt(encrypted);
      return token.length <= 4096 ? token : '';
    } catch { return ''; }
  };
  const write = (token: unknown): { persisted: boolean } => {
    if (typeof token !== 'string' || token.length > 4096) throw new Error('Некорректная сессия.');
    if (!token || !encryption.available()) { fs.rmSync(file, { force: true }); return { persisted: false }; }
    fs.mkdirSync(directory, { recursive: true });
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, encryption.encrypt(token), { mode: 0o600 });
    fs.renameSync(temporary, file);
    return { persisted: true };
  };
  return { read, write };
}
