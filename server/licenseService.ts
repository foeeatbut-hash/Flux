import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { performance } from 'node:perf_hooks';
import type { RequestHandler } from 'express';
import { getPrisma, onDatabaseSwapped, broadcast } from './context.js';
import { LICENSE_PUBLIC_KEY_HEX, readLicense, personLicense, publicHexOf, type LicensePayload, type PersonLicense } from '../license/node/core.js';
import { readRevocations, acceptsRevocations, type RevocationPayload } from '../license/node/revocation.js';
import { LICENSE_SIGNING_PUBLIC_KEY_HEX } from '../license/ownerKey.js';
import { administratorPermission } from './accessPolicy.js';

const INSTALL_ID = 'flux-license-install-id';
const KEYS_ID = 'flux-person-license-keys';
const REVOKED_ID = 'flux-license-revocations';
type Snapshot = { inst: string; keys: LicensePayload[]; revoked: RevocationPayload | null };
export interface PersonLicenseStatus extends PersonLicense { installationId: string; readOnly: boolean; canActivate: boolean; testMode?: boolean }
let installation: Promise<string> | null = null;
let cache: { at: number; value: Snapshot } | null = null;
let pending: Promise<Snapshot> | null = null;
let generation = 0;
let trustedNow = () => Date.now();
let testKey: string | null = null;
let automaticTestLicense = false;
// Уже проверенный отзыв нельзя откатить прямой правкой БД в работающем процессе.
// Это локальное наблюдение: новый компьютер не знает ранее удалённых записей.
const observedRevocations = new Map<string, string>();

/** Разрешение тестового ключа передаётся исходным запуском, а не переменной среды portable. */
export function configureLicenseService(deps: { trustedNow: () => number; fromSource?: boolean; automaticTestLicense?: boolean }): void {
  trustedNow = deps.trustedNow;
  testKey = null;
  automaticTestLicense = deps.fromSource === true && deps.automaticTestLicense === true && process.env.FLUX_TEST_LICENSE === '1' && process.env.FLUX_TEST_LICENSE_AUTO === '1';
  if (deps.fromSource === true && process.env.FLUX_TEST_LICENSE === '1') {
    const fixture = fs.readFileSync(path.join(process.cwd(), 'scripts/fixtures/license-test-key.txt'), 'utf8');
    testKey = publicHexOf(crypto.createPrivateKey(fixture));
  }
  invalidateLicenseCache();
}

export function invalidateLicenseCache(): void { generation++; cache = null; pending = null; }
onDatabaseSwapped(() => { installation = null; invalidateLicenseCache(); });
const signingKeys = () => [...new Set([LICENSE_SIGNING_PUBLIC_KEY_HEX, LICENSE_PUBLIC_KEY_HEX, testKey].filter((v): v is string => !!v && /^[a-f0-9]{64}$/i.test(v)))];
const verifiedLicense = (code: string): LicensePayload | null => signingKeys().map(key => readLicense(code, key)).find(Boolean) || null;
const verifiedRevocations = (code: string): RevocationPayload | null => signingKeys().map(key => readRevocations(code, key)).find(Boolean) || null;
const parseArray = (value: string | undefined): string[] => { try { const a = JSON.parse(value || '[]'); return Array.isArray(a) ? a.filter(v => typeof v === 'string').slice(0, 10000) : []; } catch (_) { return []; } };

export async function licenseInstallationId(): Promise<string> {
  if (!installation) installation = (async () => {
    const prisma = getPrisma();
    const existing = await prisma.appSetting.findFirst({ where: { key: 'license.install_id', userId: null } });
    if (existing?.value) return existing.value;
    const row = await prisma.appSetting.upsert({ where: { id: INSTALL_ID }, update: {}, create: { id: INSTALL_ID, key: 'license.install_id', userId: null, value: crypto.randomUUID() } });
    return row.value;
  })().catch(e => { installation = null; throw e; });
  return installation;
}

async function snapshot(): Promise<Snapshot> {
  if (cache && performance.now() - cache.at < 5000) return cache.value;
  if (pending) return pending;
  const current = generation;
  const operation = (async () => {
    const prisma = getPrisma();
    const [inst, keyRow, revokeRow] = await Promise.all([
      licenseInstallationId(), prisma.appSetting.findUnique({ where: { id: KEYS_ID } }), prisma.appSetting.findUnique({ where: { id: REVOKED_ID } }),
    ]);
    const keys = parseArray(keyRow?.value).map(verifiedLicense).filter((v): v is LicensePayload => !!v);
    const revoked = revokeRow?.value ? verifiedRevocations(revokeRow.value) : null;
    if (revoked && revoked.inst !== inst) throw new Error('Список отзыва не соответствует установке');
    // Повреждённый подписанный список не превращается в пустой и не возвращает доступ.
    if (revokeRow?.value && !revoked) throw new Error('Не удалось проверить список отзыва лицензий');
    if (current !== generation) return snapshot();
    const observedCode = observedRevocations.get(inst);
    const observed = observedCode ? verifiedRevocations(observedCode) : null;
    if (observed && (!revoked || (revokeRow.value !== observedCode && !acceptsRevocations(revoked, observed, inst)))) {
      throw new Error('Из базы удалён или откатан ранее проверенный список отзыва лицензий');
    }
    if (revoked) {
      if (!observedRevocations.has(inst) && observedRevocations.size >= 16) throw new Error('Слишком много установок в одном процессе проверки лицензий');
      observedRevocations.set(inst, revokeRow.value);
    }
    const value = { inst, keys, revoked };
    if (current === generation) cache = { at: performance.now(), value };
    return value;
  })();
  pending = operation;
  try { return await operation; } finally { if (pending === operation) pending = null; }
}

export async function licenseForUser(user: any): Promise<PersonLicenseStatus> {
  const canActivate = administratorPermission(user, 'admin.license.activate', trustedNow());
  if (automaticTestLicense) return { licensed: true, reason: '', expiresAt: null, daysLeft: null, warn: false, installationId: await licenseInstallationId(), readOnly: false, canActivate, testMode: true };
  if (user?.role === 'OWNER') return { licensed: true, reason: '', expiresAt: null, daysLeft: null, warn: false, installationId: await licenseInstallationId(), readOnly: false, canActivate: true };
  const s = await snapshot();
  const result = personLicense(user?.symbol || '', s.inst, s.keys, trustedNow(), new Set(s.revoked?.ids || []));
  return { ...result, installationId: s.inst, canActivate, readOnly: result.reason === 'expired' };
}

export const canActivateLicense = (user: any): boolean => administratorPermission(user, 'admin.license.activate', trustedNow());

export async function installedLicenses(): Promise<Snapshot> { return snapshot(); }

export async function activatePersonKey(code: string): Promise<LicensePayload> {
  const key = verifiedLicense(code);
  if (!key) throw new Error('Подпись ключа неверна. Скопируйте ключ FLUX2 целиком.');
  if (key.inst !== await licenseInstallationId()) throw new Error('Ключ выдан для другой установки компании.');
  if (key.exp <= trustedNow()) throw new Error('Срок действия этого ключа уже истёк.');
  const s = await snapshot();
  if (s.revoked?.ids.includes(key.id)) throw new Error('Этот ключ отозван владельцем.');
  const prisma = getPrisma();
  // Сравнение прежней строки не даёт параллельным активациям потерять ключ друг друга.
  for (let attempt = 0; attempt < 5; attempt++) {
    const row = await prisma.appSetting.upsert({ where: { id: KEYS_ID }, update: {}, create: { id: KEYS_ID, key: 'license.person_keys', userId: null, value: '[]' } });
    const codes = parseArray(row.value);
    if (codes.some(v => verifiedLicense(v)?.id === key.id)) return key;
    if (codes.length >= 10000) throw new Error('Достигнут предел выпусков лицензии. Обратитесь к владельцу.');
    const updated = await prisma.appSetting.updateMany({ where: { id: KEYS_ID, value: row.value }, data: { value: JSON.stringify([...codes, code.replace(/\s+/g, '')]) } });
    if (updated.count) { invalidateLicenseCache(); broadcast('license:changed', {}); return key; }
  }
  throw new Error('Другой администратор изменил лицензии. Повторите активацию.');
}

export async function activateRevocations(code: string): Promise<RevocationPayload> {
  const next = verifiedRevocations(code);
  if (!next) throw new Error('Подпись списка отзыва FLUXREV1 неверна.');
  const inst = await licenseInstallationId();
  if (next.inst !== inst) throw new Error('Список отзыва выдан для другой установки.');
  if (next.iat > trustedNow() + 300000) throw new Error('Список отзыва выпущен в будущем. Проверьте время сервера.');
  const prisma = getPrisma();
  for (let attempt = 0; attempt < 5; attempt++) {
    const row = await prisma.appSetting.upsert({ where: { id: REVOKED_ID }, update: {}, create: { id: REVOKED_ID, key: 'license.revocations', userId: null, value: '' } });
    const previous = row.value ? verifiedRevocations(row.value) : null;
    if (row.value && !previous) throw new Error('Существующий список отзыва повреждён. Доступ не восстановлен.');
    if (row.value === code.replace(/\s+/g, '')) return next;
    if (!acceptsRevocations(next, previous, inst)) throw new Error('Нельзя применить старый список или вернуть ранее отозванные ключи.');
    const changed = await prisma.appSetting.updateMany({ where: { id: REVOKED_ID, value: row.value }, data: { value: code.replace(/\s+/g, '') } });
    if (changed.count) { invalidateLicenseCache(); broadcast('license:changed', {}); return next; }
  }
  throw new Error('Список изменился параллельно. Повторите действие.');
}

/** Проверки чтения POST явно перечисляются сервером, а не угадываются по телу запроса. */
export function personLicenseMiddleware(options: { allowed: (method: string, path: string) => boolean; readOnlyPost?: (path: string) => boolean }): RequestHandler {
  return async (req, res, next) => {
    if (options.allowed(req.method, req.path)) return next();
    const user = (req as any).authUser;
    if (!user) return next();
    try {
      const state = await licenseForUser(user);
      (req as any).personLicense = state;
      if (state.licensed || (state.readOnly && (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || (req.method === 'POST' && options.readOnlyPost?.(req.path))))) return next();
      return res.status(402).json({ error: state.readOnly ? 'Лицензия истекла. Доступно только чтение. Обратитесь к владельцу Flux для продления.' : 'Для работы нужна лицензия сотрудника. Обратитесь к администратору компании.', code: 'PERSON_LICENSE_REQUIRED', license: state });
    } catch (_) { return res.status(503).json({ error: 'Не удалось проверить лицензию в базе компании. Повторите после восстановления связи.', code: 'LICENSE_UNAVAILABLE' }); }
  };
}
