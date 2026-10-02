import { BrowserWindow, dialog, ipcMain } from 'electron';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { trustedAuthSender } from './authStorage';
import { decrypt, inspectVault } from '../tools/flux-owner/src/vault.cjs';

const MAX_BYTES = 12 * 1024 * 1024;

/** Приватный ключ остаётся в главном процессе; окно получает только подпись одноразового входа. */
export async function signOwnerChallenge(serialized: string, password: string, packet: any, origin: string): Promise<string> {
  if (typeof password !== 'string' || password.length < 12 || password.length > 1024) throw new Error('Введите фразу-пароль хранилища (от 12 символов).');
  if (typeof serialized !== 'string' || serialized.length > MAX_BYTES) throw new Error('Файл хранилища слишком велик.');
  let message: any;
  try { message = JSON.parse(packet.message); } catch { throw new Error('Некорректный запрос входа от сервера.'); }
  const now = Date.now();
  if (packet.message.length > 4000 || typeof packet.nonce !== 'string' || packet.nonce.length < 16 || packet.nonce.length > 200 || message.purpose !== 'flux-owner-login' || message.version !== 1 || message.nonce !== packet.nonce || message.origin !== origin || message.expiresAt !== packet.expiresAt || !Number.isSafeInteger(message.expiresAt) || message.expiresAt <= now || message.expiresAt > now + 65000 || typeof message.installationId !== 'string' || !message.installationId || message.installationId.length > 200) throw new Error('Запрос входа относится к другому серверу или уже истёк.');
  // Единый читатель исключает расхождение паролей и форматов между Flux и Flux Owner.
  const payload = await decrypt(serialized, password);
  try {
    const owner = payload.keys?.owner;
    const privateKey = crypto.createPrivateKey(owner.privatePem);
    return crypto.sign(null, Buffer.from(packet.message), privateKey).toString('base64');
  } finally { for (const entry of Object.values(payload.keys) as any[]) entry.privatePem = ''; }
}

export function setupOwnerLogin(configuredServer: () => string) {
  const selected = new Map<number, string>();
  const signing = new Set<number>();
  ipcMain.handle('owner:select-key', async event => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || !trustedAuthSender(event)) throw new Error('Вход владельца доступен только в основном окне.');
    const result = await dialog.showOpenDialog(window, { title: 'Основное или запасное хранилище владельца Flux', defaultPath: path.join(os.homedir(), '.flux-owner', 'vault.flux-owner'), properties: ['openFile'], filters: [{ name: 'Хранилище владельца', extensions: ['flux-owner'] }] });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    const file = result.filePaths[0];
    selected.delete(event.sender.id);
    try {
      if ((await fs.stat(file)).size > MAX_BYTES) throw new Error('Файл хранилища слишком велик.');
      inspectVault(await fs.readFile(file, 'utf8'));
    } catch (e: any) { return { ok: false, error: e.message || 'Не удалось прочитать файл хранилища.' }; }
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
    catch (e: any) { return { ok: false, error: e.message || 'Не удалось открыть хранилище.' }; }
    finally { signing.delete(event.sender.id); }
  });
}
