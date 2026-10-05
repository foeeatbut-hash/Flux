import crypto from 'node:crypto';
import { UPDATE_PUBLIC_KEY_HEX } from './updateKey';
import { readUpdateSignature } from './updateSignature';

export interface UpdateDelegation {
  v: 1; id: string; inst: string; userId: string; publicKey: string;
  issuedAt: number; expiresAt: number; maxTargets: number; maxMinutes: number;
}
export interface UpdateCommand {
  v: 1; id: string; inst: string; actor: string; issuedAt: number; deadline: number;
  action: 'schedule' | 'cancel'; version: string; generation: string; sha256: string;
  targets: { deviceId: string; userId: string; previous: string | null }[];
}
export interface SignedUpdateCommand { command: string; delegation: string; releaseSignature: string }
const id = (s: unknown) => typeof s === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(s);
const time = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) > 0;
const pub = (hex: string) => crypto.createPublicKey({ format: 'der', type: 'spki', key: Buffer.from(`302a300506032b6570032100${hex}`, 'hex') });

// Формат подписывается целиком: повторная сериализация JSON не определяет доверие.
export function signUpdateEnvelope(prefix: string, value: unknown, key: crypto.KeyObject): string {
  const body = `${prefix}.${Buffer.from(JSON.stringify(value)).toString('base64url')}`;
  return `${body}.${crypto.sign(null, Buffer.from(body), key).toString('base64url')}`;
}
export function readUpdateEnvelope(code: string, prefix: string, keyHex: string): any | null {
  try {
    if (!/^[a-f0-9]{64}$/i.test(keyHex) || typeof code !== 'string' || code.length > 512000) return null;
    const parts = code.split('.');
    if (parts.length !== 3 || parts[0] !== prefix || !/^[A-Za-z0-9_-]+$/.test(parts[1]) || !/^[A-Za-z0-9_-]{86}$/.test(parts[2])) return null;
    const bytes = Buffer.from(parts[1], 'base64url'), sig = Buffer.from(parts[2], 'base64url');
    if (bytes.toString('base64url') !== parts[1] || sig.toString('base64url') !== parts[2]
      || !crypto.verify(null, Buffer.from(`${prefix}.${parts[1]}`), pub(keyHex), sig)) return null;
    return JSON.parse(bytes.toString('utf8'));
  } catch { return null; }
}
export function readUpdateDelegation(code: string, key = UPDATE_PUBLIC_KEY_HEX): UpdateDelegation | null {
  const d = readUpdateEnvelope(code, 'FLUXUPDAUTH1', key);
  if (!d || d.v !== 1 || !id(d.id) || !id(d.inst) || !id(d.userId) || !/^[a-f0-9]{64}$/i.test(d.publicKey)
    || !time(d.issuedAt) || !time(d.expiresAt) || d.expiresAt <= d.issuedAt || d.expiresAt - d.issuedAt > 366 * 86400000
    || !Number.isInteger(d.maxTargets) || d.maxTargets < 1 || d.maxTargets > 2000
    || !Number.isInteger(d.maxMinutes) || d.maxMinutes < 5 || d.maxMinutes > 1440) return null;
  return d;
}
export function verifyUpdateCommand(envelope: SignedUpdateCommand, context: {
  inst: string; deviceId?: string; userId?: string; keyHex?: string;
}): UpdateCommand | null {
  const d = readUpdateDelegation(envelope?.delegation, context.keyHex);
  if (!d || d.inst !== context.inst) return null;
  const c = readUpdateEnvelope(envelope.command, 'FLUXUPDCMD1', d.publicKey);
  const release = readUpdateSignature(envelope.releaseSignature, context.keyHex);
  if (!c || c.v !== 1 || !id(c.id) || c.inst !== d.inst || c.actor !== d.userId
    || !time(c.issuedAt) || c.issuedAt < d.issuedAt || c.issuedAt > d.expiresAt
    || !time(c.deadline) || !['schedule', 'cancel'].includes(c.action)
    || (c.action === 'schedule' && (c.deadline - c.issuedAt < 5 * 60000 || c.deadline - c.issuedAt > d.maxMinutes * 60000))
    || (c.action === 'cancel' && c.deadline !== c.issuedAt)
    || !release || c.version !== release.version || c.sha256 !== release.sha256
    || typeof c.generation !== 'string' || !/^[a-f0-9-]{36}$/.test(c.generation)
    || !Array.isArray(c.targets) || !c.targets.length || c.targets.length > d.maxTargets) return null;
  const devices = new Set<string>();
  for (const t of c.targets) {
    if (!t || !id(t.deviceId) || !id(t.userId) || (t.previous !== null && !id(t.previous)) || devices.has(`${t.deviceId}:${t.userId}`)) return null;
    devices.add(`${t.deviceId}:${t.userId}`);
  }
  if (context.deviceId && !c.targets.some((t: any) => t.deviceId === context.deviceId && (!context.userId || t.userId === context.userId))) return null;
  return c;
}

// История должна идти без пропусков. Удаление команды из БД не превращает её отмену в новую команду.
export function verifiedDeviceChain(envelopes: SignedUpdateCommand[], context: {
  inst: string; deviceId: string; userId: string; knownId?: string | null; keyHex?: string;
}): { command: UpdateCommand; envelope: SignedUpdateCommand } | null {
  let head: string | null = null, latest: ReturnType<typeof verifiedDeviceChain> = null, seenKnown = !context.knownId;
  const seen = new Set<string>();
  for (const envelope of envelopes) {
    const command = verifyUpdateCommand(envelope, context);
    if (!command) return null;
    const target = command.targets.find(t => t.deviceId === context.deviceId && t.userId === context.userId)!;
    if (target.previous !== head || seen.has(command.id)) return null;
    seen.add(command.id); head = command.id;
    if (head === context.knownId) seenKnown = true;
    latest = { command, envelope };
  }
  return seenKnown ? latest : null;
}
