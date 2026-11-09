import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/**
 * Хранение пароля от чужого почтового ящика.
 *
 * Это единственное место в программе, где чужой секрет лежит в восстановимом
 * виде: пароль от почты нельзя хешировать, его надо предъявлять серверу при
 * каждом соединении. Отсюда все решения ниже.
 *
 * Шифр — AES-256-GCM: он не только скрывает пароль, но и заверяет его. Если
 * файл базы правили руками, расшифровка честно откажет, а не выдаст мусор,
 * который потом уйдёт на почтовый сервер как пароль.
 *
 * Ключ берётся в таком порядке:
 *  1. safeStorage Electron — на Windows это DPAPI, ключ привязан к учётной
 *     записи Windows. Скопированная на другую машину база не расшифруется.
 *  2. Файл рядом с настройками, права 600. Слабее, но работает и когда
 *     программа поднята без Electron — например, сервером в конторе.
 *
 * Наружу пароль не отдаётся никогда: ни в ответе маршрута, ни в журнале, ни в
 * тексте ошибки. Раздел знает только «задан» или «не задан».
 */

const ALGO = 'aes-256-gcm';
const KEY_FILE = 'mail.key';

let cachedKey: Buffer | null = null;
let cachedSource: 'system' | 'file' | null = null;
let configuredDir = '';

/**
 * Каталог данных, который знает сервер (server.ts). Свой расчёт ниже остаётся
 * запасным: в разработке сервер берёт каталог рядом с проектом, и ключ почты
 * лежал совсем в другом месте.
 */
export function setSecretDataDir(dir: string): void {
  if (dir && dir !== configuredDir) { configuredDir = dir; cachedKey = null; cachedSource = null; }
}

/** Каталог данных программы — тот же, где база и файлы Чата. */
function legacyDataDir(): string {
  const fromEnv = process.env.VENT_APP_DATA;
  if (fromEnv) return fromEnv;
  const home = process.env.HOME || process.env.USERPROFILE || '.';
  if (process.platform === 'win32') return path.join(process.env.APPDATA || home, 'pdm-app');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'pdm-app');
  return path.join(home, '.config', 'pdm-app');
}
function dataDir(): string { return configuredDir || legacyDataDir(); }

function safeStorageOf(): any {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const safe = require('electron')?.safeStorage;
    return safe && safe.isEncryptionAvailable() ? safe : null;
  } catch (_) { return null; }
}

/**
 * Ключ из safeStorage, если программа запущена внутри Electron.
 * Требовать electron жёстко нельзя: сервер собирается и запускается отдельно,
 * и обычный import уронил бы его на старте.
 *
 * Файл mail.key.enc, который не удаётся расшифровать, — ошибка, а не повод
 * тихо перейти на файловый ключ: тогда пароли ящиков стали бы нечитаемыми без
 * объяснения.
 */
function keyFromSafeStorage(): Buffer | null {
  const safe = safeStorageOf();
  if (!safe) return null;
  const file = path.join(dataDir(), 'mail.key.enc');
  if (fs.existsSync(file)) {
    let key = '';
    try { key = safe.decryptString(fs.readFileSync(file)); } catch (e: any) {
      throw new Error(`Не удалось расшифровать ключ паролей почты (${file}): ${e?.message || e}. Файл не изменён.`);
    }
    if (!key) throw new Error(`Ключ паролей почты (${file}) пуст. Файл не изменён.`);
    return Buffer.from(key, 'base64');
  }
  // Первый запуск: заводим ключ и отдаём его на хранение системе
  const fresh = crypto.randomBytes(32).toString('base64');
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(file, safe.encryptString(fresh));
  return Buffer.from(fresh, 'base64');
}

/**
 * Запасной ключ: файл с правами 600.
 *
 * Новый ключ заводится ТОЛЬКО когда файла нет. Битый файл раньше молча
 * заменялся, и пароли всех ящиков становились нечитаемыми без объяснения;
 * теперь он откладывается рядом под другим именем, а сервер говорит об этом
 * владельцу.
 */
function keyFromFile(): Buffer {
  const dir = dataDir();
  const file = path.join(dir, KEY_FILE);
  if (fs.existsSync(file)) {
    let key: Buffer | null = null;
    try { key = Buffer.from(fs.readFileSync(file, 'utf-8').trim(), 'base64'); } catch (e: any) {
      throw new Error(`Не удалось прочитать ключ паролей почты (${file}): ${e?.message || e}. Файл не изменён.`);
    }
    if (key.length === 32) return key;
    const kept = `${file}.bad-${Date.now()}`;
    try { fs.copyFileSync(file, kept); } catch (_) { /* копию не сделать — файл всё равно не трогаем */ }
    throw new Error(`Ключ паролей почты (${file}) повреждён, пароли ящиков расшифровать нельзя. Файл сохранён как ${kept}; верните исправный mail.key или введите пароли ящиков заново, удалив повреждённый файл.`);
  }
  // Ключа в новом каталоге нет, а в прежнем (расчёт самого модуля) есть — берём его
  const old = path.join(legacyDataDir(), KEY_FILE);
  if (configuredDir && old !== file && fs.existsSync(old)) {
    try {
      const k = Buffer.from(fs.readFileSync(old, 'utf-8').trim(), 'base64');
      if (k.length === 32) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, k.toString('base64'), { encoding: 'utf-8', mode: 0o600 });
        return k;
      }
    } catch (_) { /* прежний ключ негоден — заводим новый */ }
  }

  const fresh = crypto.randomBytes(32);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, fresh.toString('base64'), { encoding: 'utf-8', mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch (_) { /* на Windows прав нет — там работает DPAPI */ }
  return fresh;
}

/** Источник выбирается один раз и запоминается: ключ из разных мест за один запуск недопустим */
function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const system = keyFromSafeStorage();
  if (system) { cachedSource = 'system'; cachedKey = system; }
  else { cachedSource = 'file'; cachedKey = keyFromFile(); }
  return cachedKey;
}

/** Где именно лежит ключ — показываем в разделе, чтобы человек знал. Ничего не создаёт. */
export function keySource(): 'system' | 'file' {
  if (cachedSource) return cachedSource;
  return safeStorageOf() ? 'system' : 'file';
}

export interface Sealed { secret: string; nonce: string }

/** Зашифровать пароль. Пустая строка остаётся пустой — «пароль не задан». */
export function seal(plain: string): Sealed {
  if (!plain) return { secret: '', nonce: '' };
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Метка подлинности хранится вместе с шифротекстом — иначе её негде взять
  return { secret: Buffer.concat([enc, tag]).toString('base64'), nonce: iv.toString('base64') };
}

/**
 * Расшифровать. Возвращает пустую строку, если пароля нет или он не сходится:
 * вызывающий обязан считать это «войти нельзя», а не «пароль пустой».
 */
export function unseal(sealed: string, nonce: string): string {
  if (!sealed || !nonce) return '';
  try {
    const raw = Buffer.from(sealed, 'base64');
    const tag = raw.subarray(raw.length - 16);
    const enc = raw.subarray(0, raw.length - 16);
    const decipher = crypto.createDecipheriv(ALGO, getKey(), Buffer.from(nonce, 'base64'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf-8');
  } catch (_) {
    return '';
  }
}

/**
 * Ящик в том виде, в каком его можно отдать в браузер: без пароля, но со
 * знанием, задан ли он. Через эту функцию обязан проходить каждый ответ
 * маршрута — иначе пароль однажды уедет в браузер по недосмотру.
 */
export function publicAccount(a: any) {
  if (!a) return null;
  const { secret, secretNonce, ...rest } = a;
  return { ...rest, hasSecret: Boolean(secret) };
}
