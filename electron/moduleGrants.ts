/**
 * Решения человека о подключениях программ: «разрешить всегда», «не разрешать», «только сейчас».
 *
 * Второй шаг двухступенчатого разрешения: владелец допустил подключение в
 * подписанном выпуске (допуск), а человек решает сам при первом обращении.
 * Решение хранится здесь, в главном процессе, для связки «человек — программа —
 * подключение» на этом компьютере, и привязано к тексту разрешения: новая версия
 * с новым адресом или с доступом «изменять» вместо «читать» даёт другой ключ
 * разрешения, и прежний выбор на неё не действует. Окно программы решение
 * записать не может: запись идёт только из окна Flux после нажатия человеком.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export type StoredDecision = 'always' | 'never';
export type GrantState = 'allowed' | 'denied' | 'ask';
interface Row { decision: StoredDecision; spec: string; at: number }

const GRANTS_MAX = 2000;

export class ModuleGrants {
  private rows = new Map<string, Row>();
  /** «Только сейчас»: до закрытия окна программы; в файл не пишется */
  private once = new Set<string>();
  /** Политика администратора: запрещено роли этого человека; сильнее его выбора */
  private denied = new Set<string>();
  private loaded: Promise<void> | null = null;
  constructor(private file: string) {}

  load(): Promise<void> {
    return this.loaded ||= (async () => {
      try {
        const file = JSON.parse(await fs.readFile(this.file, 'utf8')) as { rows?: Record<string, Row>; policy?: string[] };
        // Политика хранится рядом с решениями: без связи с сервером запрет администратора не пропадает после перезапуска
        this.denied = new Set((Array.isArray(file.policy) ? file.policy : []).filter(v => typeof v === 'string').slice(0, 1000));
        const data = file.rows || {};
        for (const [key, row] of Object.entries(data).slice(0, GRANTS_MAX)) {
          if (row && (row.decision === 'always' || row.decision === 'never') && typeof row.spec === 'string') this.rows.set(key, { decision: row.decision, spec: row.spec, at: Number(row.at) || 0 });
        }
      } catch { /* решений ещё нет */ }
    })();
  }

  static key = (userId: string, moduleId: string, connection: string) => `${userId}|${moduleId}|${connection}`;

  /** Что сейчас действует для подключения с этим текстом разрешения */
  state(userId: string, moduleId: string, connection: string, spec: string, session: string): GrantState {
    const key = ModuleGrants.key(userId, moduleId, connection);
    if (this.denied.has(`${moduleId}|${connection}`)) return 'denied';
    const row = this.rows.get(key);
    // Прежний выбор действует только на то же самое разрешение: новый адрес или более широкий доступ спрашивается снова
    if (row && row.spec === spec) return row.decision === 'always' ? 'allowed' : 'denied';
    return this.once.has(`${key}|${spec}|${session}`) ? 'allowed' : 'ask';
  }

  async decide(userId: string, moduleId: string, connection: string, spec: string, session: string, decision: 'always' | 'once' | 'never' | 'ask') {
    const key = ModuleGrants.key(userId, moduleId, connection);
    if (decision === 'once') { this.once.add(`${key}|${spec}|${session}`); return; }
    for (const item of [...this.once]) if (item.startsWith(`${key}|`)) this.once.delete(item);
    if (decision === 'ask') this.rows.delete(key);
    else this.rows.set(key, { decision, spec, at: Date.now() });
    await this.save();
  }

  /** Окно программы закрыто: «только сейчас» кончилось */
  endSession(session: string) { for (const item of [...this.once]) if (item.endsWith(`|${session}`)) this.once.delete(item); }

  async resetAll(userId: string, moduleId?: string) {
    for (const key of [...this.rows.keys()]) if (key.startsWith(`${userId}|${moduleId ? `${moduleId}|` : ''}`)) this.rows.delete(key);
    await this.save();
  }

  setPolicy(denied: Array<{ moduleId: string; connection: string }>) {
    this.denied = new Set(denied.slice(0, 1000).map(d => `${d.moduleId}|${d.connection}`));
    void this.save();
  }
  isDeniedByPolicy(moduleId: string, connection: string) { return this.denied.has(`${moduleId}|${connection}`); }

  /** Все решения человека — для списка «Разрешения» */
  list(userId: string): Array<{ moduleId: string; connection: string; decision: StoredDecision; spec: string; at: number }> {
    const out = [];
    for (const [key, row] of this.rows) {
      const [user, moduleId, connection] = key.split('|');
      if (user === userId) out.push({ moduleId, connection, decision: row.decision, spec: row.spec, at: row.at });
    }
    return out;
  }

  private async save() {
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify({ rows: Object.fromEntries(this.rows), policy: [...this.denied] }));
      await fs.rename(tmp, this.file);
    } catch { /* решение действует до перезапуска, если диск недоступен */ }
  }
}
