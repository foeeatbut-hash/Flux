/**
 * Запомненный адрес общей базы.
 *
 * Адрес содержит пароль базы, поэтому на диск он попадает только зашифрованным защищённым хранилищем ОС
 * (то же, что хранит ключ разработчика). Окну отдаётся лишь безопасное описание «сервер/база» без пароля.
 * Если защищённого хранилища нет, адрес не запоминается совсем: хранить пароль открытым текстом нельзя,
 * а подключиться можно и так — просто адрес придётся вводить при каждом запуске.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { SafeStorageLike } from '../shared/keyring';

interface Saved { v: 1; display: string; secret: string }

export class RememberedBase {
  private readonly file: string;
  constructor(dir: string, private readonly storage: SafeStorageLike) { this.file = path.join(dir, 'database-address.json'); }

  private usable(): boolean {
    try { return this.storage.isEncryptionAvailable() && this.storage.getSelectedStorageBackend?.() !== 'basic_text'; } catch { return false; }
  }

  /** Что показать на экране подключения; пусто — ничего не запомнено */
  display(): string {
    try { const saved = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Saved; return saved.v === 1 ? String(saved.display || '') : ''; } catch { return ''; }
  }

  /** Запомнить; возвращает false, если защищённого хранилища нет (адрес не записан) */
  save(uri: string, display: string): boolean {
    if (!this.usable()) return false;
    const saved: Saved = { v: 1, display: display.slice(0, 200), secret: this.storage.encryptString(uri).toString('base64') };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(saved), { mode: 0o600 });
    fs.renameSync(temp, this.file);
    return true;
  }

  /** Адрес для подключения; пустая строка — нет запомненного или он не расшифровался (другая учётная запись) */
  load(): string {
    if (!this.usable()) return '';
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Saved;
      return saved.v === 1 ? this.storage.decryptString(Buffer.from(saved.secret, 'base64')) : '';
    } catch { return ''; }
  }

  forget(): void { fs.rmSync(this.file, { force: true }); }
}
