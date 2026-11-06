/**
 * Что установлено у человека на этом компьютере и какие каналы ему открыты.
 *
 * Хранится в файле рядом с кэшем выпусков и не зависит от связи: установленные
 * подпрограммы запускаются без базы, возврат к прошлой версии тоже. Сервер
 * (таблица ModuleInstall) нужен для списка «ваши подпрограммы» на других
 * компьютерах и журнала — изменения, сделанные без связи, помечаются
 * `dirty` и уходят на сервер при следующей синхронизации.
 *
 * Здесь политика («что человек выбрал»), а не доверие: поставить можно только
 * то, что кэш уже проверил (electron/moduleCache.ts), а запускается оно после
 * ещё одной проверки подписи. Подменённый файл выбора ничего не запустит.
 *
 * Без electron: проверяется скриптом (scripts/test-modules-store.ts).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { MODULE_CHANNELS, MODULE_ID, MODULE_VERSION, type ModuleChannel } from '../modules/trust/claims';

export interface SelectionEntry {
  version: string;
  /** Когда выбрано (ms): по нему сервер и компьютер решают, чья запись новее */
  at: number;
  /** Не дошло до сервера (изменено без связи) */
  dirty?: boolean;
  /** Выключить автообновление этой подпрограммы после возврата версии */
  noAuto?: boolean;
}
interface UserSelection { channels: ModuleChannel[]; installed: Record<string, SelectionEntry> }
interface Saved { active: string; users: Record<string, UserSelection> }

const emptyUser = (): UserSelection => ({ channels: ['production'], installed: {} });
/** Рабочий канал открыт всегда; тестовый — только назначенным */
export function readChannels(value: unknown): ModuleChannel[] {
  const list = (Array.isArray(value) ? value : []).filter((c): c is ModuleChannel => MODULE_CHANNELS.includes(c as ModuleChannel));
  return list.includes('production') ? [...new Set(list)] : ['production', ...new Set(list)];
}

export class ModuleSelection {
  private data: Saved = { active: '', users: {} };
  constructor(private file: string, private now: () => number = Date.now) {}

  async load(): Promise<void> {
    try {
      const saved = JSON.parse(await fs.readFile(this.file, 'utf8'));
      const users: Record<string, UserSelection> = {};
      for (const [id, u] of Object.entries<any>(saved?.users && typeof saved.users === 'object' ? saved.users : {})) {
        const installed: Record<string, SelectionEntry> = {};
        for (const [moduleId, e] of Object.entries<any>(u?.installed && typeof u.installed === 'object' ? u.installed : {})) {
          if (MODULE_ID.test(moduleId) && typeof e?.version === 'string' && MODULE_VERSION.test(e.version)) {
            installed[moduleId] = { version: e.version, at: Number(e.at) || 0, ...(e.dirty ? { dirty: true } : {}), ...(e.noAuto ? { noAuto: true } : {}) };
          }
        }
        users[String(id).slice(0, 80)] = { channels: readChannels(u?.channels), installed };
      }
      this.data = { active: typeof saved?.active === 'string' ? saved.active : '', users };
    } catch { /* первого выбора ещё не было или файл повреждён: начинаем с пустого, кэш выпусков при этом цел */ }
  }

  private async save() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.data));
    await fs.rename(tmp, this.file);
  }

  get active(): string { return this.data.active; }
  private get user(): UserSelection { return this.data.users[this.data.active] || emptyUser(); }
  get channels(): ModuleChannel[] { return this.user.channels; }
  get installed(): Record<string, SelectionEntry> { return this.user.installed; }
  versions(): Record<string, string> { return Object.fromEntries(Object.entries(this.installed).map(([id, e]) => [id, e.version])); }

  /** Вошёл человек: дальше выбор — его. Чужого выбора на этом компьютере это не стирает */
  async activate(userId: string): Promise<void> {
    const id = String(userId || '').slice(0, 80);
    if (!this.data.users[id]) this.data.users[id] = emptyUser();
    this.data.active = id;
    await this.save();
  }

  private mutate(fn: (u: UserSelection) => void): Promise<void> {
    if (!this.data.active) return Promise.reject(new Error('Сначала войдите в программу'));
    const u = (this.data.users[this.data.active] ||= emptyUser());
    fn(u);
    return this.save();
  }

  setChannels(channels: unknown) { return this.mutate((u) => { u.channels = readChannels(channels); }); }

  install(moduleId: string, version: string, opts: { dirty?: boolean; noAuto?: boolean } = {}) {
    if (!MODULE_ID.test(moduleId) || !MODULE_VERSION.test(version)) return Promise.reject(new Error('Недопустимое имя подпрограммы или версии'));
    return this.mutate((u) => {
      u.installed[moduleId] = { version, at: this.now(), ...(opts.dirty ? { dirty: true } : {}), ...(opts.noAuto ? { noAuto: true } : {}) };
    });
  }

  remove(moduleId: string) { return this.mutate((u) => { delete u.installed[moduleId]; }); }

  /** Сервер принял запись: пометка «не дошло» снимается */
  markSynced(moduleId: string, at: number) {
    return this.mutate((u) => { const e = u.installed[moduleId]; if (e && e.at === at) delete e.dirty; });
  }
}
