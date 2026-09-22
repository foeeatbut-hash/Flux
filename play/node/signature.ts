/**
 * Подпись описи сборки: ed25519, тот же способ, что у лицензии.
 *
 * Лежит в `play/node/`, а не рядом с правилами, по той же причине, что и
 * запись диагностики: здесь нужен `node:crypto`, а общий код обязан собираться
 * и в окне тоже. Подпись при этом проверяют трое — оболочка на машине
 * сотрудника, сервер при выкладке и проверочный скрипт, — и три копии одного
 * правила разошлись бы в первый же месяц.
 *
 * Подписывающий ключ в программу не попадает никогда: он живёт у владельца, в
 * том же офлайн-генераторе, что и ключ лицензии. Здесь есть и подписывание —
 * ради проверок и будущего окна выкладки, — но ключ ему передают снаружи.
 */

import crypto from 'node:crypto';
import { canonicalManifest, type BuildManifest } from '../builds.js';

/** Заголовок DER для «сырого» открытого ключа ed25519 (32 байта) */
const DER_PUB_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
/** И для закрытого */
const DER_PRIV_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export const publicKeyOf = (hex: string): crypto.KeyObject => crypto.createPublicKey({
  key: Buffer.concat([DER_PUB_PREFIX, Buffer.from(hex, 'hex')]),
  format: 'der',
  type: 'spki',
});

export const privateKeyOf = (hex: string): crypto.KeyObject => crypto.createPrivateKey({
  key: Buffer.concat([DER_PRIV_PREFIX, Buffer.from(hex, 'hex')]),
  format: 'der',
  type: 'pkcs8',
});

const b64url = (b: Buffer): string => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s: string): Buffer => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/** Подписать опись. Ключ — «сырые» 32 байта шестнадцатеричной строкой. */
export function signManifest(manifest: BuildManifest, privateKeyHex: string): string {
  const data = Buffer.from(canonicalManifest(manifest), 'utf-8');
  return b64url(crypto.sign(null, data, privateKeyOf(privateKeyHex)));
}

/**
 * Сходится ли подпись описи с ключом издателя.
 *
 * Отказ — молчаливый `false`, без подробностей: разница между «подпись не та»
 * и «ключ не тот» интересна только тому, кто подбирает подпись.
 */
export function verifyManifest(manifest: BuildManifest, publicKeyHex: string): boolean {
  try {
    if (!manifest?.signature || !/^[0-9a-f]{64}$/.test(String(publicKeyHex))) return false;
    const data = Buffer.from(canonicalManifest(manifest), 'utf-8');
    return crypto.verify(null, data, publicKeyOf(publicKeyHex), unb64url(manifest.signature));
  } catch (_) { return false; }
}

/** Пара ключей издателя. Закрытый отдаётся вызывающему и нигде не хранится. */
export function newPublisherKeys(): { publicKey: string; privateKey: string } {
  const pair = crypto.generateKeyPairSync('ed25519');
  const pub = pair.publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const priv = pair.privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer;
  return {
    publicKey: pub.subarray(pub.length - 32).toString('hex'),
    privateKey: priv.subarray(priv.length - 32).toString('hex'),
  };
}
