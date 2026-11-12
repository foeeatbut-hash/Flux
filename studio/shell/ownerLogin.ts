/**
 * Вход владельца файлом ключа в Flux Studio — те же шаги, что во Flux: выбрать файл .flux-owner, ввести его пароль,
 * сервер присылает одноразовый запрос, главный процесс подписывает его ключом из файла и отправляет подпись.
 *
 * Работает в обеих сборках. Это только вход: закрытый ключ из файла живёт в памяти ровно на время подписи и в
 * окно не попадает, а подписи выпусков и лицензий (сборка владельца) выполняет код studio/owner, которого у
 * разработчика нет (scripts/check-studio-bundle.ts).
 */
import fs from 'node:fs/promises';
import { chooseOwnerKeyFile, signOwnerChallenge, type OpenDialog } from '../shared/ownerKey';
import { ownerSignIn, studioRequest, StudioFailure, type StudioUser } from './api';

export class OwnerKeyLogin {
  private file = '';
  constructor(private readonly dialog: OpenDialog) {}

  /** Выбор файла: окно выбора открыто в папке прежнего хранилища; непригодный файл сбрасывает прежний выбор */
  async select(parent: unknown): Promise<{ canceled: boolean; name?: string; ok?: false; error?: string }> {
    const chosen = await chooseOwnerKeyFile(this.dialog, parent);
    if (chosen.canceled === true) return { canceled: true };
    this.file = '';
    if ('error' in chosen) return { canceled: false, ok: false, error: chosen.error };
    this.file = chosen.file;
    return { canceled: false, name: chosen.name };
  }

  forget(): void { this.file = ''; }

  async login(origin: string, password: string, signal?: AbortSignal): Promise<{ token: string; user: StudioUser; owner: boolean }> {
    if (!this.file) throw new StudioFailure('Сначала выберите файл ключа владельца.');
    if (typeof password !== 'string' || password.length > 1024) throw new StudioFailure('Введите фразу-пароль хранилища (от 12 символов).');
    const challenge = await studioRequest<{ nonce: string; message: string; expiresAt: number }>(origin, 'ownerChallenge', { signal });
    let sig: string;
    try { sig = await signOwnerChallenge(await fs.readFile(this.file, 'utf8'), password, challenge, origin); }
    catch (error: any) { throw new StudioFailure(String(error?.message || 'Не удалось открыть хранилище.').slice(0, 400)); }
    const signed = await ownerSignIn(origin, challenge, sig, signal);
    this.file = '';
    return signed;
  }
}
