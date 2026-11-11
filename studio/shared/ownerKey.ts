import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { decrypt, inspectVault } from './vaultRead.cjs';

/**
 * Вход владельца файлом ключа — одна реализация для Flux и Flux Studio (обеих сборок).
 *
 * Здесь только вход: выбрать файл .flux-owner, расшифровать его паролем и подписать одноразовый запрос сервера.
 * Приватный ключ не покидает главный процесс. Подписи выпусков, лицензий и обновлений, создание и запись
 * хранилища — в studio/owner/src, в сборке разработчика их нет.
 */
const MAX_BYTES = 12 * 1024 * 1024;

/** Подпись одноразового входа; окно получает только её, содержимое хранилища в окно не попадает. */
export async function signOwnerChallenge(serialized: string, password: string, packet: any, origin: string): Promise<string> {
  if (typeof password !== 'string' || password.length < 12 || password.length > 1024) throw new Error('Введите фразу-пароль хранилища (от 12 символов).');
  if (typeof serialized !== 'string' || serialized.length > MAX_BYTES) throw new Error('Файл хранилища слишком велик.');
  let message: any;
  try { message = JSON.parse(packet.message); } catch { throw new Error('Некорректный запрос входа от сервера.'); }
  const now = Date.now();
  if (packet.message.length > 4000 || typeof packet.nonce !== 'string' || packet.nonce.length < 16 || packet.nonce.length > 200 || message.purpose !== 'flux-owner-login' || message.version !== 1 || message.nonce !== packet.nonce || message.origin !== origin || message.expiresAt !== packet.expiresAt || !Number.isSafeInteger(message.expiresAt) || message.expiresAt <= now || message.expiresAt > now + 65000 || typeof message.installationId !== 'string' || !message.installationId || message.installationId.length > 200) throw new Error('Запрос входа относится к другому серверу или уже истёк.');
  // Единый читатель исключает расхождение паролей и форматов между Flux, Flux Studio и сборкой владельца.
  const payload = await decrypt(serialized, password);
  try {
    const owner = payload.keys?.owner;
    const privateKey = crypto.createPrivateKey(owner.privatePem);
    return crypto.sign(null, Buffer.from(packet.message), privateKey).toString('base64');
  } finally { for (const entry of Object.values(payload.keys) as any[]) entry.privatePem = ''; }
}

export interface OpenDialog {
  showOpenDialog: (window: any, options: any) => Promise<{ canceled: boolean; filePaths: string[] }>;
}

/** Окно выбора файла ключа с прежним расположением по умолчанию (~/.flux-owner); файл сразу проверяется на формат. */
export async function chooseOwnerKeyFile(dialog: OpenDialog, window: unknown): Promise<{ canceled: true } | { canceled: false; ok?: undefined; file: string; name: string } | { canceled: false; ok: false; error: string }> {
  const result = await dialog.showOpenDialog(window, { title: 'Основное или запасное хранилище владельца Flux', defaultPath: path.join(os.homedir(), '.flux-owner', 'vault.flux-owner'), properties: ['openFile'], filters: [{ name: 'Хранилище владельца', extensions: ['flux-owner'] }] });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  const file = result.filePaths[0];
  try {
    if ((await fs.stat(file)).size > MAX_BYTES) throw new Error('Файл хранилища слишком велик.');
    inspectVault(await fs.readFile(file, 'utf8'));
  } catch (e: any) { return { canceled: false, ok: false, error: e.message || 'Не удалось прочитать файл хранилища.' }; }
  return { canceled: false, file, name: path.basename(file) };
}
