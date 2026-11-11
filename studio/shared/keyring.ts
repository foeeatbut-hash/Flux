/**
 * Ключ разработчика Flux Studio: закрытая часть живёт только в защищённом хранилище ОС.
 *
 * Electron safeStorage шифрует строку ключом, привязанным к учётной записи Windows
 * (DPAPI). Файл на диске содержит шифртекст и открытую часть; расшифровывается закрытый
 * ключ только внутри `sign` на время подписи и никуда не возвращается: ни в окно, ни в
 * журнал, ни в базу. Если защищённого хранилища нет (на Linux Electron в этом случае
 * молча пишет открытым текстом — `basic_text`), ключ не создаётся совсем: безопасная
 * подпись важнее удобства.
 *
 * Без Electron: хранилище приходит параметром, поэтому проверки подставляют своё.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { publicHexOf, sealEnvelope, type EnvelopeKind } from '../../modules/trust/envelope';

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
  /** Есть только на Linux: `basic_text` значит «шифрования на самом деле нет» */
  getSelectedStorageBackend?(): string;
}
export class KeyringFailure extends Error {}

export interface KeyInfo { available: boolean; exists: boolean; publicKey: string; createdAt: number; /** Файл ключа есть, но не читается */ damaged: boolean }
interface KeyFile { v: 1; createdAt: number; publicKey: string; secret: string }

const REQUEST_PREFIX = 'FLUXDEVCERTREQ1';

export class DeveloperKeyring {
  private readonly file: string;
  constructor(dir: string, private readonly storage: SafeStorageLike) { this.file = path.join(dir, 'developer-key.json'); }

  available(): boolean {
    try {
      if (!this.storage.isEncryptionAvailable()) return false;
      return this.storage.getSelectedStorageBackend?.() !== 'basic_text';
    } catch { return false; }
  }

  /** Файла нет — null; файл есть, но не читается — исключение: молча перезаписать его значило бы потерять ключ с выданным сертификатом */
  private read(): KeyFile | null {
    if (!fs.existsSync(this.file)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (data?.v === 1 && /^[0-9a-f]{64}$/.test(data.publicKey) && typeof data.secret === 'string') return data;
    } catch { /* ниже — одна ошибка на оба случая */ }
    throw new KeyringFailure('Файл ключа разработчика повреждён. Ключ не заменён: скопируйте developer-key.json из каталога данных Studio и обратитесь к владельцу.');
  }
  /** Состояние для окна не должно падать на повреждённом файле: об этом сообщает create/sign */
  private readOrNull(): KeyFile | null { try { return this.read(); } catch { return null; } }

  /** Состояние для окна: открытая часть и факт наличия. Закрытой части здесь нет по построению */
  info(): KeyInfo {
    const stored = this.readOrNull();
    return { available: this.available(), exists: !!stored, publicKey: stored?.publicKey || '', createdAt: stored?.createdAt || 0, damaged: fs.existsSync(this.file) && !stored };
  }

  /**
   * Новый ключ. Существующий не затирается: заменить его можно только явным `replace` (окно спрашивает человека),
   * и прежний файл остаётся рядом копией. Повреждённый файл не заменяется вовсе, пока человек не сохранит копию сам.
   */
  create(replace = false): KeyInfo {
    if (!this.available()) {
      throw new KeyringFailure('Защищённое хранилище этого компьютера недоступно, поэтому ключ разработчика не создан: хранить его открытым текстом нельзя. Войдите в Windows своей учётной записью и повторите.');
    }
    const existing = this.read();
    if (existing && !replace) throw new KeyringFailure('Ключ разработчика уже создан. Новый ключ нужен, только если прежний утерян: сертификат прежнего ключа перестанет подходить, и его придётся запрашивать заново.');
    if (existing) fs.copyFileSync(this.file, `${this.file}.${Date.now()}.bak`);
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const file: KeyFile = {
      v: 1, createdAt: Date.now(), publicKey: publicHexOf(privateKey),
      secret: this.storage.encryptString(pem).toString('base64'),
    };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    // Запись сначала во временный файл: оборванная запись не оставит ключ, который не расшифровать
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(file), { mode: 0o600 });
    fs.renameSync(temp, this.file);
    return this.info();
  }

  /** Текст запроса сертификата: владелец вводит из него ключ, профиль и имя в «Выдать сертификат» */
  certificateRequest(person: { userId: string; name: string }): string {
    const stored = this.read();
    if (!stored) throw new KeyringFailure('Сначала создайте ключ разработчика.');
    const body = { v: 1, key: stored.publicKey, userId: String(person.userId).slice(0, 160), name: String(person.name || '').slice(0, 160), iat: Date.now() };
    return `${REQUEST_PREFIX}.${Buffer.from(JSON.stringify(body)).toString('base64url')}`;
  }

  /** Подпись записи ключом разработчика. Закрытый ключ существует только внутри этого вызова */
  sign(kind: EnvelopeKind, payload: unknown): string {
    const stored = this.read();
    if (!stored) throw new KeyringFailure('Ключа разработчика нет: создайте его в разделе «Ключ и сертификат».');
    if (!this.available()) throw new KeyringFailure('Защищённое хранилище недоступно: подписать нельзя.');
    let key: crypto.KeyObject;
    try { key = crypto.createPrivateKey(this.storage.decryptString(Buffer.from(stored.secret, 'base64'))); }
    catch { throw new KeyringFailure('Ключ разработчика не расшифровался на этом компьютере (другая учётная запись Windows?). Подписать нельзя.'); }
    if (publicHexOf(key) !== stored.publicKey) throw new KeyringFailure('Файл ключа повреждён: открытая часть не сходится с закрытой.');
    return sealEnvelope(kind, payload, key);
  }
}

/** Разбор запроса сертификата — для владельца и проверок: пустой результат значит «не наш формат» */
export function parseCertificateRequest(text: string): { key: string; userId: string; name: string } | null {
  const [prefix, body, extra] = String(text || '').trim().split('.');
  if (prefix !== REQUEST_PREFIX || !body || extra !== undefined) return null;
  try {
    const v = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return v?.v === 1 && /^[0-9a-f]{64}$/.test(v.key) && typeof v.userId === 'string' && typeof v.name === 'string'
      ? { key: v.key, userId: v.userId, name: v.name } : null;
  } catch { return null; }
}
