/**
 * Подпись обновления: кто выпустил этот exe.
 *
 * Прежняя проверка («начинается с MZ и не слишком мал») отличала программу от
 * страницы с ошибкой, но не программу владельца от чужой. Выпуски лежат в общей
 * базе, публикует их любой администратор, — значит, любой администратор или
 * любой, кто дотянулся до базы, мог разослать всем свой exe, и его запустили бы
 * на каждом компьютере при нажатии «Обновить».
 *
 * Теперь к выпуску прикладывается описание, подписанное закрытым ключом
 * владельца: версия, размер и SHA-256 файла. Главный процесс проверяет подпись
 * открытым ключом, зашитым в программу, и сверяет файл с описанием ДО запуска.
 * Подделать описание без закрытого ключа нельзя, подменить файл под настоящим
 * описанием — тоже: не сойдётся отпечаток.
 *
 * Откат на старую версию запрещён: старый подписанный выпуск с известной
 * уязвимостью иначе стал бы способом её вернуть.
 *
 * Модуль без Electron — проверяется скриптом scripts/test-update-signature.ts.
 */
import crypto from 'crypto';
import { UPDATE_PUBLIC_KEY_HEX } from './updateKey';

export const UPDATE_SIG_PREFIX = 'FLUXUPD1';

export interface UpdateManifest {
  /** Номер выпуска, как в package.json */
  version: string;
  /** Размер exe в байтах */
  size: number;
  /** SHA-256 exe, hex в нижнем регистре */
  sha256: string;
  /** Когда подписано, unix ms — для журнала, не для проверки */
  iat?: number;
}

const DER_PUB_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const b64url = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function publicKey(hex: string): crypto.KeyObject | null {
  if (!/^[0-9a-f]{64}$/i.test(hex)) return null;
  return crypto.createPublicKey({ key: Buffer.concat([DER_PUB_PREFIX, Buffer.from(hex, 'hex')]), format: 'der', type: 'spki' });
}

/** Разобрать и проверить подпись. null — подпись не принята */
export function readUpdateSignature(sig: string, keyHex = UPDATE_PUBLIC_KEY_HEX): UpdateManifest | null {
  try {
    const key = publicKey(keyHex);
    if (!key) return null;
    const parts = String(sig || '').trim().split('.');
    if (String(sig).length > 4096 || parts.length !== 3 || parts[0] !== UPDATE_SIG_PREFIX) return null;
    if (!/^[A-Za-z0-9_-]+$/.test(parts[1]) || !/^[A-Za-z0-9_-]{86}$/.test(parts[2])) return null;
    if (b64url(parts[1]).toString('base64url') !== parts[1] || b64url(parts[2]).toString('base64url') !== parts[2]) return null;
    if (!crypto.verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key, b64url(parts[2]))) return null;
    const m = JSON.parse(b64url(parts[1]).toString('utf-8'));
    if (!m || typeof m.version !== 'string' || m.version.length > 40 || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(m.version)
      || typeof m.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(m.sha256)
      || !Number.isSafeInteger(m.size) || m.size < 1024 || m.size > 800 * 1024 * 1024
      || (m.iat !== undefined && (!Number.isSafeInteger(m.iat) || m.iat < 0))) return null;
    return { version: m.version, size: m.size, sha256: m.sha256.toLowerCase(), iat: m.iat };
  } catch (_) {
    return null;
  }
}

/** Сравнение номеров выпуска «1.17.2»; хвост после дефиса не учитывается */
export function compareVersions(a: string, b: string): number {
  const pa = String(a || '').split('-')[0].split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '').split('-')[0].split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * Можно ли запускать скачанное. Пустая строка — можно; иначе причина словами.
 * `version` — какой выпуск просили, `current` — какая версия работает сейчас.
 */
export function updateRefusal(p: {
  signature: string; version: string; current: string; size: number; sha256: string; keyHex?: string;
}): string {
  const keyHex = p.keyHex ?? UPDATE_PUBLIC_KEY_HEX;
  if (!keyHex) return 'В этой сборке не задан ключ издателя: обновления не ставятся. Установите новую версию вручную.';
  if (!String(p.signature || '').trim()) return 'У выпуска нет подписи владельца программы. Такое обновление не ставится.';
  const m = readUpdateSignature(p.signature, keyHex);
  if (!m) return 'Подпись выпуска не подтверждена. Обновление не ставится: его выпустил не владелец программы.';
  if (m.version !== p.version) return `Подпись относится к версии ${m.version}, а скачана ${p.version}.`;
  if (compareVersions(m.version, p.current) <= 0) return `Выпуск ${m.version} не новее установленного ${p.current}: откат не ставится.`;
  if (m.size !== p.size || m.sha256 !== String(p.sha256 || '').toLowerCase()) {
    return 'Скачанный файл не совпадает с подписанным выпуском. Обновление не ставится.';
  }
  return '';
}

/** SHA-256 файла потоком: exe весит больше сотни мегабайт */
export function sha256File(file: string): Promise<string> {
  const fs = require('fs');
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (c: Buffer) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}
