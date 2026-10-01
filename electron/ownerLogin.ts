import { BrowserWindow, dialog, ipcMain } from 'electron';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { trustedAuthSender } from './authStorage';

const scrypt = (password: string, salt: Buffer, length: number, options: crypto.ScryptOptions): Promise<Buffer> =>
  new Promise((resolve, reject) => crypto.scrypt(password, salt, length, options, (error, key) => error ? reject(error) : resolve(key))); 
const MAX_BYTES = 12 * 1024 * 1024;

/** Приватный ключ остаётся в главном процессе; окно получает только подпись одноразового входа. */
export async function signOwnerChallenge(serialized: string, password: string, packet: any, origin: string): Promise<string> {
  if (typeof password !== 'string' || password.length < 12 || password.length > 1024) throw new Error('Введите фразу-пароль хранилища (от 12 символов).');
  if (typeof serialized !== 'string' || serialized.length > MAX_BYTES) throw new Error('Файл хранилища слишком велик.');
  let message: any;
  try { message = JSON.parse(packet.message); } catch { throw new Error('Некорректный запрос входа от сервера.'); }
  const now = Date.now();
  if (packet.message.length > 4000 || typeof packet.nonce !== 'string' || packet.nonce.length < 16 || packet.nonce.length > 200 || message.purpose !== 'flux-owner-login' || message.version !== 1 || message.nonce !== packet.nonce || message.origin !== origin || message.expiresAt !== packet.expiresAt || !Number.isSafeInteger(message.expiresAt) || message.expiresAt <= now || message.expiresAt > now + 65000 || typeof message.installationId !== 'string' || !message.installationId || message.installationId.length > 200) throw new Error('Запрос входа относится к другому серверу или уже истёк.');
  let key: Buffer | undefined, plain: Buffer | undefined;
  try {
    const vault = JSON.parse(serialized);
    if (vault.format !== 'FLUXOWNER1' || vault.kdf !== 'scrypt-32768-8-1') throw new Error('format');
    const decode = (text: any, min: number, max = min) => {
      if (typeof text !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) throw new Error('base64');
      const data = Buffer.from(text, 'base64');
      if (data.length < min || data.length > max || data.toString('base64') !== text) throw new Error('base64');
      return data;
    };
    key = await scrypt(password, decode(vault.salt, 32), 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }) as Buffer;
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, decode(vault.iv, 12));
    decipher.setAAD(Buffer.from('FLUXOWNER1')); decipher.setAuthTag(decode(vault.tag, 16));
    plain = Buffer.concat([decipher.update(decode(vault.data, 1, 8 * 1024 * 1024)), decipher.final()]);
    const payload = JSON.parse(plain.toString('utf8'));
    if (payload.v !== 1 || !['main', 'backup'].includes(payload.kind)) throw new Error('payload');
    const owner = payload.keys?.owner;
    if (typeof owner?.privatePem !== 'string' || owner.privatePem.length > 1000 || !/^[a-f0-9]{64}$/.test(owner.publicHex || '')) throw new Error('owner');
    const privateKey = crypto.createPrivateKey(owner.privatePem);
    if (privateKey.asymmetricKeyType !== 'ed25519' || crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex') !== owner.publicHex) throw new Error('owner');
    const signature = crypto.sign(null, Buffer.from(packet.message), privateKey).toString('base64');
    owner.privatePem = '';
    return signature;
  } catch (_) { throw new Error('Файл повреждён или фраза-пароль неверна.'); }
  finally { key?.fill(0); plain?.fill(0); }
}

export function setupOwnerLogin(configuredServer: () => string) {
  const selected = new Map<number, string>();
  const signing = new Set<number>();
  ipcMain.handle('owner:select-key', async event => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || !trustedAuthSender(event)) throw new Error('Вход владельца доступен только в основном окне.');
    const result = await dialog.showOpenDialog(window, { title: 'Ключ владельца Flux', properties: ['openFile'], filters: [{ name: 'Хранилище владельца', extensions: ['flux-owner'] }] });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    const file = result.filePaths[0];
    if ((await fs.stat(file)).size > MAX_BYTES) throw new Error('Файл хранилища слишком велик.');
    selected.set(event.sender.id, file);
    event.sender.once('destroyed', () => { selected.delete(event.sender.id); signing.delete(event.sender.id); });
    return { canceled: false, name: path.basename(file) };
  });
  ipcMain.handle('owner:sign-login', async (event, request: any) => {
    if (!trustedAuthSender(event) || !selected.has(event.sender.id)) throw new Error('Сначала выберите файл ключа владельца.');
    if (signing.has(event.sender.id)) throw new Error('Вход уже выполняется.');
    const origin = new URL(configuredServer() || 'http://localhost:3000').origin;
    if (request?.serverUrl !== origin) throw new Error('Выбран другой сервер. Обновите подключение перед входом.');
    signing.add(event.sender.id);
    try { return { sig: await signOwnerChallenge(await fs.readFile(selected.get(event.sender.id)!, 'utf8'), request.password, request.challenge, origin) }; }
    finally { signing.delete(event.sender.id); }
  });
}
