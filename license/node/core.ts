/**
 * Лицензия Flux на сотрудников — формат, подпись и проверка.
 *
 * Прежняя лицензия была на компьютер и проверялась только в окне программы:
 * сервер работал без неё вовсе, а лицензия одной машины открывала программу
 * всем, кто заходил на её сервер через браузер. Теперь лицензия выдаётся на
 * людей (логины) конкретной установки и проверяется сервером при каждом
 * запросе.
 *
 * Как это ходит, чтобы действий было меньше:
 *  1. Администратор компании одним нажатием получает КОД ЗАПРОСА сразу на всех
 *     сотрудников без лицензии (FLUXREQ1…). Секретов в нём нет.
 *  2. Владелец вставляет его в программу владельца, выбирает срок и получает
 *     один КЛЮЧ на всех перечисленных (FLUX2…).
 *  3. Администратор вставляет ключ — лицензия у всех сразу.
 *
 * Ключ подписан закрытым ключом владельца (Ed25519). В программе и на сервере
 * только открытый: правка данных в базе не создаёт правильную подпись.
 * Правка самого проверяющего кода на подконтрольной машине обходит проверку. Ключ привязан к установке (номер создаётся в базе при первом
 * старте): чужой компании он не подойдёт.
 *
 * Без базы, сети и Electron, но на node:crypto — поэтому в license/node/. Его читают сервер, программа
 * владельца и наборы проверок (scripts/test-license-core.ts).
 */
import crypto from 'crypto';

/** Открытый ключ лицензий — тот же, что у прежних кодов FLUX1 */
export const LICENSE_PUBLIC_KEY_HEX = '034c455f3a226cfa50729e7ed45ba166f76403a738399f82b9df0c64bb3a5b2d';

export const KEY_PREFIX = 'FLUX2';
export const REQUEST_PREFIX = 'FLUXREQ1';

/** За сколько дней до конца предупреждать */
export const WARN_DAYS = 14;

export interface LicenseRequest {
  /** Номер установки (база компании) */
  inst: string;
  /** Название компании — для глаз владельца, в проверке не участвует */
  org: string;
  /** Логины и имена тех, кому нужна лицензия */
  people: Array<{ login: string; name: string }>;
  /** Когда запрос составлен, unix ms */
  at: number;
}

export interface LicensePayload {
  v: 2;
  /** Номер ключа — чтобы различать выпуски в журнале владельца */
  id: string;
  inst: string;
  org: string;
  /** Логины в нижнем регистре */
  logins: string[];
  /** До какого момента действует, unix ms */
  exp: number;
  /** Когда выпущен, unix ms */
  iat: number;
}

const validText = (s: unknown, limit: number): s is string => typeof s === 'string' && !!s.trim() && s.length <= limit && !/[\x00-\x1f]/.test(s);

const DER_PUB_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export const b64url = (b: Buffer | string) =>
  Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s: string) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

export const normLogin = (s: string) => String(s || '').trim().toLowerCase();

export function publicKeyOf(hex: string): crypto.KeyObject | null {
  if (!/^[0-9a-f]{64}$/i.test(hex)) return null;
  return crypto.createPublicKey({ key: Buffer.concat([DER_PUB_PREFIX, Buffer.from(hex, 'hex')]), format: 'der', type: 'spki' });
}

/** Открытая половина закрытого ключа — hex, как его зашивают в программу */
export function publicHexOf(privateKey: crypto.KeyObject): string {
  const der = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  return der.subarray(der.length - 32).toString('hex');
}

// ── Код запроса ──────────────────────────────────────────────────────────────

export function makeRequest(r: LicenseRequest): string {
  const people = r.people
    .map((p) => ({ login: String(p.login || '').trim(), name: String(p.name || '').trim().slice(0, 120) }))
    .filter((p) => p.login);
  return `${REQUEST_PREFIX}.${b64url(JSON.stringify({ inst: r.inst, org: String(r.org || '').slice(0, 200), people, at: r.at }))}`;
}

export function readRequest(code: string): LicenseRequest | null {
  try {
    if (typeof code !== 'string' || code.length > 2000000) return null;
    const s = code.replace(/\s+/g, '');
    if (!s.startsWith(`${REQUEST_PREFIX}.`)) return null;
    const j = JSON.parse(unb64url(s.slice(REQUEST_PREFIX.length + 1)).toString('utf-8'));
    if (!j || !validText(j.inst, 200) || !Array.isArray(j.people) || j.people.length > 10000 || typeof j.org !== 'string' || j.org.length > 200 || !Number.isSafeInteger(j.at) || j.at < 0) return null;
    const people = j.people
      .filter((p: any) => p && typeof p.login === 'string' && p.login.trim())
      .map((p: any) => ({ login: String(p.login).trim(), name: String(p.name || '') }));
    return { inst: j.inst, org: String(j.org || ''), people, at: Number(j.at) || 0 };
  } catch (_) {
    return null;
  }
}

// ── Ключ ────────────────────────────────────────────────────────────────────

export function signLicense(p: Omit<LicensePayload, 'v' | 'id' | 'iat' | 'logins'> & { logins: string[]; iat?: number },
  privateKey: crypto.KeyObject): string {
  const payload: LicensePayload = {
    v: 2,
    id: crypto.randomBytes(6).toString('hex'),
    inst: p.inst,
    org: p.org,
    logins: [...new Set(p.logins.map(normLogin).filter(Boolean))],
    exp: p.exp,
    iat: p.iat ?? Date.now(),
  };
  const signed = `${KEY_PREFIX}.${b64url(JSON.stringify(payload))}`;
  return `${signed}.${b64url(crypto.sign(null, Buffer.from(signed), privateKey))}`;
}

/** Разобрать и проверить подпись ключа. null — ключ не принят */
export function readLicense(code: string, keyHex = LICENSE_PUBLIC_KEY_HEX): LicensePayload | null {
  try {
    const key = publicKeyOf(keyHex);
    if (!key) return null;
    if (typeof code !== 'string' || code.length > 2000000) return null;
    const parts = code.replace(/\s+/g, '').split('.');
    if (parts.length !== 3 || parts[0] !== KEY_PREFIX || !/^[A-Za-z0-9_-]+$/.test(parts[1]) || !/^[A-Za-z0-9_-]{86}$/.test(parts[2])) return null;
    if (!crypto.verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key, unb64url(parts[2]))) return null;
    const p = JSON.parse(unb64url(parts[1]).toString('utf-8'));
    if (!p || p.v !== 2 || !validText(p.id, 128) || !validText(p.inst, 200) || !Array.isArray(p.logins) || !p.logins.length || p.logins.length > 10000 || !p.logins.every((v: unknown) => validText(v, 120)) || !Number.isSafeInteger(p.exp) || !Number.isSafeInteger(p.iat) || p.iat < 0 || p.exp <= p.iat || typeof p.org !== 'string' || p.org.length > 200) return null;
    return { v: 2, id: String(p.id || ''), inst: p.inst, org: String(p.org || ''), logins: p.logins.map(normLogin), exp: p.exp, iat: Number(p.iat) || 0 };
  } catch (_) {
    return null;
  }
}

// ── Состояние лицензии человека ─────────────────────────────────────────────

export type LicenseReason = '' | 'none' | 'expired' | 'other_install' | 'revoked';

export interface PersonLicense {
  licensed: boolean;
  reason: LicenseReason;
  /** До какого момента, unix ms; null — ключа нет */
  expiresAt: number | null;
  daysLeft: number | null;
  /** Пора предупреждать о конце срока */
  warn: boolean;
}

/**
 * Лицензия человека по всем установленным ключам: берётся самая длинная из
 * подходящих. `now` — надёжное время сервера (перевод часов назад не помогает).
 */
export function personLicense(login: string, inst: string, keys: LicensePayload[], now: number, revokedIds: ReadonlySet<string> = new Set()): PersonLicense {
  const who = normLogin(login);
  const mine = keys.filter((k) => k.logins.includes(who));
  const installed = mine.filter((k) => k.inst === inst);
  const here = installed.filter(k => !revokedIds.has(k.id));
  if (installed.length && !here.length) return { licensed: false, reason: 'revoked', expiresAt: null, daysLeft: null, warn: false };
  if (!here.length) {
    return { licensed: false, reason: mine.length ? 'other_install' : 'none', expiresAt: null, daysLeft: null, warn: false };
  }
  const exp = Math.max(...here.map((k) => k.exp));
  if (exp <= now) return { licensed: false, reason: 'expired', expiresAt: exp, daysLeft: 0, warn: true };
  const daysLeft = Math.ceil((exp - now) / 86400000);
  return { licensed: true, reason: '', expiresAt: exp, daysLeft, warn: daysLeft <= WARN_DAYS };
}

/** Какие из установленных ключей уже никому не нужны: истёк у всех */
export const liveKeys = (keys: LicensePayload[], now: number) => keys.filter((k) => k.exp > now);
