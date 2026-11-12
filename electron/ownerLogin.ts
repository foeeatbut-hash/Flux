import { BrowserWindow, dialog, ipcMain } from 'electron';
import fs from 'node:fs/promises';
import { trustedAuthSender } from './authStorage';
import { chooseOwnerKeyFile, signOwnerChallenge } from '../studio/shared/ownerKey';

// Выбор файла, чтение хранилища и подпись — общие с Flux Studio (studio/shared/ownerKey.ts); здесь только каналы окна Flux.
export { signOwnerChallenge };

export function setupOwnerLogin(configuredServer: () => string) {
  const selected = new Map<number, string>();
  const signing = new Set<number>();
  ipcMain.handle('owner:select-key', async event => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || !trustedAuthSender(event)) throw new Error('Вход владельца доступен только в основном окне.');
    const chosen = await chooseOwnerKeyFile(dialog, window);
    // Отмена выбора оставляет прежний выбранный файл; непригодный файл его сбрасывает
    if (chosen.canceled === true) return { canceled: true };
    selected.delete(event.sender.id);
    if ('error' in chosen) return { ok: false, error: chosen.error };
    selected.set(event.sender.id, chosen.file);
    event.sender.once('destroyed', () => { selected.delete(event.sender.id); signing.delete(event.sender.id); });
    return { canceled: false, name: chosen.name };
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
