/**
 * Подписанные записи модулей: выпуск, запрос на публикацию, сертификат
 * разработчика, отзыв.
 *
 * Зачем подпись, а не строка в таблице: у каждого Flux есть реквизиты SQL
 * общей базы, и любой сотрудник технически может вписать в таблицу модулей
 * что угодно. Поэтому Flux верит только тому, что подписано: выпуск — ключом
 * владельца (корень, зашит в exe), запрос — ключом разработчика, у которого
 * есть сертификат владельца.
 *
 * Формат как у обновлений (`electron/updateSignature.ts`):
 * `ПРЕФИКС.<base64url(json)>.<base64url(подпись Ed25519)>`. Префикс входит в
 * подписанные байты и у каждого вида свой: подпись запроса нельзя выдать за
 * подпись выпуска, а подпись выпуска модуля — за подпись обновления exe, хотя
 * владелец подписывает и то и другое одним ключом издателя.
 *
 * Только Node (crypto): берут сервер, главный процесс и проверки. Окно
 * подписи не проверяет — за него это делает главный процесс.
 */
import crypto from 'node:crypto';

export const ENVELOPE_PREFIX = {
  release: 'FLUXMOD1',
  request: 'FLUXMODREQ1',
  certificate: 'FLUXMODCERT1',
  revocation: 'FLUXMODREV1',
  /** Назначение канала: «рабочий канал не выше версии X» — откат, подписанный владельцем */
  pin: 'FLUXMODPIN1',
  promotion: 'FLUXMODCHANNEL1',
} as const;
export type EnvelopeKind = keyof typeof ENVELOPE_PREFIX;

/** Запрос несёт «что нового», комментарий и отчёт проверок — им нужно место, но не мегабайты */
export const ENVELOPE_MAX = 64 * 1024;
const DER_PUB_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * JSON с упорядоченными ключами: подпись ставится на байты, и один и тот же
 * смысл обязан давать одни и те же байты у Studio, владельца и проверки.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Число вне JSON');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.keys(value as object).sort()
    .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(',')}}`;
}

export function publicKeyFromHex(hex: string): crypto.KeyObject | null {
  if (!/^[0-9a-f]{64}$/i.test(String(hex || ''))) return null;
  try {
    return crypto.createPublicKey({ key: Buffer.concat([DER_PUB_PREFIX, Buffer.from(hex, 'hex')]), format: 'der', type: 'spki' });
  } catch { return null; }
}

export function publicHexOf(key: crypto.KeyObject): string {
  const pub = key.type === 'private' ? crypto.createPublicKey(key) : key;
  return pub.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
}

export function sealEnvelope(kind: EnvelopeKind, payload: unknown, privateKey: crypto.KeyObject): string {
  const signed = `${ENVELOPE_PREFIX[kind]}.${Buffer.from(canonicalJson(payload)).toString('base64url')}`;
  const text = `${signed}.${crypto.sign(null, Buffer.from(signed), privateKey).toString('base64url')}`;
  if (text.length > ENVELOPE_MAX) throw new Error('Подписанная запись слишком велика');
  return text;
}

function parts(kind: EnvelopeKind, text: string): [string, string, string] | null {
  const value = String(text || '').trim();
  if (value.length > ENVELOPE_MAX) return null;
  const split = value.split('.');
  if (split.length !== 3 || split[0] !== ENVELOPE_PREFIX[kind]) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(split[1]) || !/^[A-Za-z0-9_-]{86}$/.test(split[2])) return null;
  // Нестрогий base64 даёт несколько записей одной подписи: «тот же выпуск» перестал бы быть одной строкой
  if (Buffer.from(split[1], 'base64url').toString('base64url') !== split[1]
    || Buffer.from(split[2], 'base64url').toString('base64url') !== split[2]) return null;
  return split as [string, string, string];
}

/** Содержимое без проверки подписи — чтобы узнать, чьим ключом её проверять */
export function peekEnvelope(kind: EnvelopeKind, text: string): unknown | null {
  const p = parts(kind, text);
  if (!p) return null;
  try { return JSON.parse(Buffer.from(p[1], 'base64url').toString('utf8')); } catch { return null; }
}

/** Содержимое, если подпись сходится с ключом `publicHex`; иначе null */
export function openEnvelope(kind: EnvelopeKind, text: string, publicHex: string): unknown | null {
  const p = parts(kind, text), key = publicKeyFromHex(publicHex);
  if (!p || !key) return null;
  try {
    if (!crypto.verify(null, Buffer.from(`${p[0]}.${p[1]}`), key, Buffer.from(p[2], 'base64url'))) return null;
    const value = JSON.parse(Buffer.from(p[1], 'base64url').toString('utf8'));
    // Подписаны байты канонической записи; другая запись того же смысла — не наша
    return canonicalJson(value) === Buffer.from(p[1], 'base64url').toString('utf8') ? value : null;
  } catch { return null; }
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}
