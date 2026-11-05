/**
 * Подпись владельца для модулей: выпуск, правка владельца, отзыв, сертификат, откат канала.
 *
 * Закрытый ключ — ключ издателя (`keys.update`) из хранилища владельца, тот же
 * файл, что для входа владельца (electron/ownerLogin.ts). Ключ не покидает
 * главный процесс; окно получает только готовую подпись. Хранилище
 * выбирается заново на каждую подпись: выпуск модуля уходит всем, и каждое
 * такое действие — явное решение владельца.
 *
 * Что подписывается, главный процесс собирает сам из байт пакета
 * (modules/trust/owner.ts), а не берёт готовым из окна.
 */
import { BrowserWindow, dialog, ipcMain } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { trustedAuthSender } from './authStorage';
import { decrypt } from '../tools/flux-owner/src/vault.cjs';
import { UPDATE_PUBLIC_KEY_HEX } from './updateKey';
import { publicHexOf, sealEnvelope, type EnvelopeKind } from '../modules/trust/envelope';
import { buildCertificateClaim, buildOwnerRequestClaim, buildPinClaim, buildReleaseClaim, buildRevocationClaim } from '../modules/trust/owner';
import { MODULE_BUNDLE_MAX } from '../modules/trust/claims';

const VAULT_MAX = 12 * 1024 * 1024;
const bytesOf = (value: unknown) => {
  const text = String(value || '');
  if (text.length > Math.ceil(MODULE_BUNDLE_MAX / 3) * 4 + 4) throw new Error('Пакет модуля слишком велик');
  return new Uint8Array(Buffer.from(text, 'base64'));
};

/** Что подписать — по виду запроса окна; всё остальное в нём игнорируется */
export function moduleClaimFor(request: any, ownerHex: string): { kind: EnvelopeKind; claim: unknown } {
  switch (request?.kind) {
    case 'release': return { kind: 'release', claim: buildReleaseClaim({ requestId: String(request.requestId || ''),
      requestSignature: String(request.requestSignature || ''), bundle: bytesOf(request.bundle), channel: request.channel,
      notBefore: Number(request.notBefore) || 0 }) };
    case 'owner-edit': return { kind: 'request', claim: buildOwnerRequestClaim({ ownerHex, parentSignature: String(request.parentSignature || ''),
      parentRequestId: String(request.parentRequestId || ''), bundle: bytesOf(request.bundle), comment: String(request.comment || '') }) };
    case 'revocation': return { kind: 'revocation', claim: buildRevocationClaim({ kind: request.target === 'key' ? 'key' : 'release', target: request.value, reason: request.reason }) };
    case 'certificate': return { kind: 'certificate', claim: buildCertificateClaim({ key: request.key, userId: request.userId, name: request.name }) };
    case 'pin': return { kind: 'pin', claim: buildPinClaim({ moduleId: String(request.moduleId || ''), channel: request.channel,
      version: request.version ? String(request.version) : null, reason: String(request.reason || '') }) };
    default: throw new Error('Неизвестное действие подписи');
  }
}

export function setupModuleSigning() {
  let busy = false;
  ipcMain.handle('modules:sign', async (event, request: any) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || !trustedAuthSender(event)) return { ok: false, error: 'Подпись доступна только в основном окне Flux.' };
    if (busy) return { ok: false, error: 'Подпись уже выполняется.' };
    const password = String(request?.password || '');
    if (password.length < 12 || password.length > 1024) return { ok: false, error: 'Введите фразу-пароль хранилища (от 12 символов).' };
    busy = true;
    let payload: any = null;
    try {
      if (!UPDATE_PUBLIC_KEY_HEX) throw new Error('В этой сборке нет ключа владельца: подписывать нечем проверять.');
      // Сначала проверка того, что подписывается: ошибка в пакете не должна просить хранилище
      const preview = moduleClaimFor(request, UPDATE_PUBLIC_KEY_HEX);
      const picked = await dialog.showOpenDialog(window, { title: 'Хранилище владельца Flux — подпись модуля', defaultPath: path.join(os.homedir(), '.flux-owner', 'vault.flux-owner'),
        properties: ['openFile'], filters: [{ name: 'Хранилище владельца', extensions: ['flux-owner'] }] });
      if (picked.canceled || !picked.filePaths[0]) return { ok: false, canceled: true };
      if ((await fs.stat(picked.filePaths[0])).size > VAULT_MAX) throw new Error('Файл хранилища слишком велик.');
      payload = await decrypt(await fs.readFile(picked.filePaths[0], 'utf8'), password);
      if (payload?.kind !== 'main' || !payload.keys?.update?.privatePem) throw new Error('Нужно основное хранилище владельца: в запасном нет ключа издателя.');
      const key = crypto.createPrivateKey(payload.keys.update.privatePem);
      if (publicHexOf(key) !== UPDATE_PUBLIC_KEY_HEX) throw new Error('Ключ хранилища не совпадает с ключом этой сборки Flux.');
      return { ok: true, signature: sealEnvelope(preview.kind, preview.claim, key) };
    } catch (e: any) {
      return { ok: false, error: e?.message || 'Не удалось подписать.' };
    } finally {
      busy = false;
      for (const entry of Object.values(payload?.keys || {}) as any[]) if (entry) entry.privatePem = '';
    }
  });
}
