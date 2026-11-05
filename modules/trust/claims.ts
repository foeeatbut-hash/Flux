/**
 * Что именно подписывается: поля выпуска, запроса, сертификата и отзыва и их
 * разбор. Разбор строгий — лишнее или неверное поле делает запись
 * недействительной: подпись на «почти правильной» записи не должна ничего
 * разрешать.
 *
 * Без зависимостей: берут и Node (проверка), и окно (показ очереди владельцу).
 */
export const MODULE_CHUNK_BYTES = 256 * 1024;
/** Модуль — исходники, форма и собранный runtime.js: десятков мегабайт ему не нужно */
export const MODULE_BUNDLE_MAX = 32 * 1024 * 1024;
export const MODULE_CHANNELS = ['test', 'production'] as const;
export type ModuleChannel = typeof MODULE_CHANNELS[number];

export interface BundleDigest {
  /** Размер пакета в байтах */
  size: number;
  /** SHA-256 всего пакета */
  sha256: string;
  /** SHA-256 каждого куска по MODULE_CHUNK_BYTES, по порядку */
  chunks: string[];
}
export interface RequestMeta {
  changelog: string;
  comment: string;
  /** Какой канал просит разработчик; решает владелец */
  channel: ModuleChannel;
  /** Отчёт проверок Studio как текст (JSON): владельцу показывается как есть */
  checks: string;
  fluxVersion: string;
  contractVersion: number;
}
/** Запрос на публикацию: подписан ключом разработчика (или владельца — «изменения владельца») */
export interface RequestClaim extends BundleDigest {
  v: 1;
  moduleId: string;
  version: string;
  /** Выпуск, от которого считается разница; null — новая подпрограмма */
  baseRelease: string | null;
  /** Запрос, который этот заменяет или правит; null — первый */
  parentRequest: string | null;
  /** Открытый ключ автора, hex */
  author: string;
  meta: RequestMeta;
  iat: number;
}
/** Выпуск: подписан только ключом владельца — иначе Flux его не запускает */
export interface ReleaseClaim extends BundleDigest {
  v: 1;
  moduleId: string;
  version: string;
  contractVersion: number;
  channel: ModuleChannel;
  /** Раньше этого времени (unix ms) выпуск не запускается: «выпустить в выбранное время» */
  notBefore: number;
  /** Запрос, из которого выпуск сделан (для истории; содержимое связано хешами) */
  request: string;
  /** Ключ разработчика — отзыв его сертификата останавливает и этот выпуск */
  author: string;
  iat: number;
}
/** Сертификат: «ключ разработчика X может присылать запросы», подписан владельцем */
export interface CertificateClaim { v: 1; key: string; userId: string; name: string; iat: number }
/** Отзыв выпуска (`moduleId@version`) или ключа разработчика, подписан владельцем */
export interface RevocationClaim { v: 1; kind: 'release' | 'key'; target: string; reason: string; iat: number }

/**
 * Назначение канала (откат): выпуски модуля в этом канале выше `version` не
 * запускаются. `version: null` снимает ограничение. Для канала действует
 * запись с наибольшим `iat`: старую запись, подсунутую вместо новой, Flux
 * не принимает.
 */
export interface PinClaim { v: 1; moduleId: string; channel: ModuleChannel; version: string | null; reason: string; iat: number }

const HEX64 = /^[0-9a-f]{64}$/;
export const MODULE_ID = /^[a-z][a-z0-9-]{0,63}$/;
export const MODULE_VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;
const REF = /^[A-Za-z0-9_.@-]{1,120}$/;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exactKeys = (v: Record<string, unknown>, keys: string[]) =>
  Object.keys(v).length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(v, k));
const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const time = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const ref = (v: unknown) => v === null || (typeof v === 'string' && REF.test(v));

export const releaseKey = (moduleId: string, version: string) => `${moduleId}@${version}`;

function digest(v: Record<string, unknown>): boolean {
  return Number.isSafeInteger(v.size) && (v.size as number) > 0 && (v.size as number) <= MODULE_BUNDLE_MAX
    && typeof v.sha256 === 'string' && HEX64.test(v.sha256)
    && Array.isArray(v.chunks) && v.chunks.length === Math.ceil((v.size as number) / MODULE_CHUNK_BYTES)
    && v.chunks.every((c) => typeof c === 'string' && HEX64.test(c));
}

export function parseRequestClaim(v: unknown): RequestClaim | null {
  if (!isObject(v) || !exactKeys(v, ['v', 'moduleId', 'version', 'baseRelease', 'parentRequest', 'author', 'meta', 'iat', 'size', 'sha256', 'chunks'])) return null;
  const m = v.meta;
  if (v.v !== 1 || typeof v.moduleId !== 'string' || !MODULE_ID.test(v.moduleId) || typeof v.version !== 'string' || !MODULE_VERSION.test(v.version)
    || !ref(v.baseRelease) || !ref(v.parentRequest) || typeof v.author !== 'string' || !HEX64.test(v.author) || !time(v.iat) || !digest(v)) return null;
  if (!isObject(m) || !exactKeys(m, ['changelog', 'comment', 'channel', 'checks', 'fluxVersion', 'contractVersion'])
    || !str(m.changelog, 4000) || !str(m.comment, 4000) || !MODULE_CHANNELS.includes(m.channel as ModuleChannel)
    || !str(m.checks, 16000) || !str(m.fluxVersion, 40) || !Number.isSafeInteger(m.contractVersion)) return null;
  return v as unknown as RequestClaim;
}

export function parseReleaseClaim(v: unknown): ReleaseClaim | null {
  if (!isObject(v) || !exactKeys(v, ['v', 'moduleId', 'version', 'contractVersion', 'channel', 'notBefore', 'request', 'author', 'iat', 'size', 'sha256', 'chunks'])) return null;
  if (v.v !== 1 || typeof v.moduleId !== 'string' || !MODULE_ID.test(v.moduleId) || typeof v.version !== 'string' || !MODULE_VERSION.test(v.version)
    || !Number.isSafeInteger(v.contractVersion) || !MODULE_CHANNELS.includes(v.channel as ModuleChannel) || !time(v.notBefore)
    || typeof v.request !== 'string' || !REF.test(v.request) || typeof v.author !== 'string' || !HEX64.test(v.author) || !time(v.iat) || !digest(v)) return null;
  return v as unknown as ReleaseClaim;
}

export function parseCertificateClaim(v: unknown): CertificateClaim | null {
  if (!isObject(v) || !exactKeys(v, ['v', 'key', 'userId', 'name', 'iat'])) return null;
  if (v.v !== 1 || typeof v.key !== 'string' || !HEX64.test(v.key) || typeof v.userId !== 'string' || !REF.test(v.userId)
    || !str(v.name, 200) || !time(v.iat)) return null;
  return v as unknown as CertificateClaim;
}

export function parseRevocationClaim(v: unknown): RevocationClaim | null {
  if (!isObject(v) || !exactKeys(v, ['v', 'kind', 'target', 'reason', 'iat'])) return null;
  if (v.v !== 1 || (v.kind !== 'release' && v.kind !== 'key') || !str(v.reason, 2000) || !time(v.iat)) return null;
  if (v.kind === 'key' ? !(typeof v.target === 'string' && HEX64.test(v.target))
    : !(typeof v.target === 'string' && /^[a-z][a-z0-9-]{0,63}@\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(v.target))) return null;
  return v as unknown as RevocationClaim;
}

export function parsePinClaim(v: unknown): PinClaim | null {
  if (!isObject(v) || !exactKeys(v, ['v', 'moduleId', 'channel', 'version', 'reason', 'iat'])) return null;
  if (v.v !== 1 || typeof v.moduleId !== 'string' || !MODULE_ID.test(v.moduleId) || !MODULE_CHANNELS.includes(v.channel as ModuleChannel)
    || !(v.version === null || (typeof v.version === 'string' && MODULE_VERSION.test(v.version))) || !str(v.reason, 2000) || !time(v.iat)) return null;
  return v as unknown as PinClaim;
}
