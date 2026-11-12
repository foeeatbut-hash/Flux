/** Ключи и пакеты для проверок цепочки доверия модулей: всё одноразовое, закрытых ключей программы здесь нет. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { packBundle } from '../../modules/trust/bundle';
import { publicHexOf, sealEnvelope } from '../../modules/trust/envelope';
import { describeBundle } from '../../modules/trust/verify';
import type { ModuleChannel } from '../../modules/trust/claims';

export const newKey = () => crypto.generateKeyPairSync('ed25519').privateKey;
export const hexOf = publicHexOf;
const FIXTURE = path.join(__dirname, '..', '..', 'modules', 'fixtures', 'equipment-inspector');

/** Пакет примера-модуля с нужной версией; `extra` — свои файлы поверх */
export function moduleBundle(version: string, extra: Record<string, string> = {}, manifestPatch: Record<string, unknown> = {}) {
  const manifest = { ...JSON.parse(fs.readFileSync(path.join(FIXTURE, 'manifest.json'), 'utf8')), version, ...manifestPatch };
  return packBundle({
    'manifest.json': JSON.stringify(manifest, null, 2),
    'form.json': fs.readFileSync(path.join(FIXTURE, 'form.json'), 'utf8'),
    'logic/main.ts': fs.readFileSync(path.join(FIXTURE, 'logic', 'main.ts'), 'utf8'),
    'examples/basic.json': JSON.stringify({ input: {}, expect: { parameterCount: 0 } }),
    'build/runtime.js': `/* runtime ${version} */`,
    ...extra,
  });
}

export function requestEnvelope(key: crypto.KeyObject, bundle: Uint8Array, p: {
  moduleId?: string; version: string; baseRelease?: string | null; parentRequest?: string | null; channel?: ModuleChannel; changelog?: string; checks?: string;
}) {
  return sealEnvelope('request', {
    v: 1, moduleId: p.moduleId || 'equipment-inspector', version: p.version, baseRelease: p.baseRelease ?? null,
    parentRequest: p.parentRequest ?? null, author: publicHexOf(key), iat: Date.now(),
    meta: { changelog: p.changelog || `Версия ${p.version}`, comment: '', channel: p.channel || 'test', checks: p.checks ?? '{"ok":true}', fluxVersion: '1.0.0', contractVersion: 1 },
    ...describeBundle(bundle),
  }, key);
}

export function releaseEnvelope(key: crypto.KeyObject, bundle: Uint8Array, p: {
  moduleId?: string; version: string; author: string; request?: string; channel?: ModuleChannel; notBefore?: number;
  language?: string; platform?: string; contractVersion?: number;
}) {
  return sealEnvelope('release', {
    v: 1, moduleId: p.moduleId || 'equipment-inspector', version: p.version, contractVersion: p.contractVersion ?? 1, channel: p.channel || 'production',
    notBefore: p.notBefore ?? 0, request: p.request || 'request-1', author: p.author, iat: Date.now(), ...describeBundle(bundle),
    ...(p.language ? { language: p.language, platform: p.platform || 'any' } : {}),
  }, key);
}

export const certificateEnvelope = (root: crypto.KeyObject, devHex: string, userId = 'developer') =>
  sealEnvelope('certificate', { v: 1, key: devHex, userId, name: 'Разработчик', iat: Date.now() }, root);
export const revocationEnvelope = (root: crypto.KeyObject, kind: 'release' | 'key', target: string) =>
  sealEnvelope('revocation', { v: 1, kind, target, reason: 'проверка', iat: Date.now() }, root);
/** Назначение канала (откат) владельца: канал не выше версии; version = null снимает ограничение */
export const pinEnvelope = (root: crypto.KeyObject, moduleId: string, channel: ModuleChannel, version: string | null, iat = Date.now()) =>
  sealEnvelope('pin', { v: 1, moduleId, channel, version, reason: 'проверка', iat }, root);
