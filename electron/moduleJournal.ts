/**
 * Журнал программ на этом компьютере: кольцо с ротацией по размеру и сроку.
 *
 * Пишет главный процесс — подключения он видит сам, остальное (запуск, расчёты,
 * чтения, flux.log) присылает окно Flux, но каждая запись проходит здесь ту же
 * проверку формы (`validEntry`) и предел частоты: журнал не может раздуться
 * ни от неисправной программы, ни от окна. На сервер записи уходят пачками
 * через окно (`src/services/moduleJournalSync.ts`) и подтверждаются по
 * номеру: неподтверждённое остаётся на диске, подтверждённое остаётся до
 * конца срока для просмотра на этом компьютере.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { JOURNAL_LIMITS, clipText, validEntry, type JournalEntry } from '../modules/journal/model';

interface Stored { seq: number; sent: number; entries: Array<JournalEntry & { seq: number }> }

export class ModuleJournal {
  private state: Stored = { seq: 0, sent: 0, entries: [] };
  private timer: NodeJS.Timeout | null = null;
  private loaded: Promise<void> | null = null;
  /** Предел частоты записей от окна на одну программу: пачка событий не заменяет лимит */
  private windows = new Map<string, { at: number; n: number }>();
  constructor(private file: string, private now: () => number = Date.now, private ring: number = JOURNAL_LIMITS.ring) {}

  load(): Promise<void> {
    return this.loaded ||= (async () => {
      try {
        const parsed = JSON.parse(await fs.readFile(this.file, 'utf8')) as Stored;
        if (parsed && Array.isArray(parsed.entries)) {
          this.state = { seq: Number(parsed.seq) || 0, sent: Number(parsed.sent) || 0, entries: parsed.entries.filter(e => validEntry(e) && Number.isSafeInteger((e as any).seq)) };
          this.rotate();
        }
      } catch { /* журнала ещё нет или он повреждён: начинаем чистый, программы от этого не страдают */ }
    })();
  }

  /** Срок и размер: старое и лишнее уходит, неотправленное самое старое — тоже, но последним */
  private rotate() {
    const cutoff = this.now() - JOURNAL_LIMITS.localDays * 86_400_000;
    let list = this.state.entries.filter(e => e.at >= cutoff);
    if (list.length > this.ring) list = list.slice(list.length - this.ring);
    this.state.entries = list;
  }

  /** Запись от главного процесса или окна; false — не принята (форма, предел) */
  add(input: Omit<JournalEntry, 'id' | 'at'> & { at?: number }, source: 'main' | 'window' = 'main'): boolean {
    const entry: JournalEntry = {
      id: randomUUID(), at: input.at ?? this.now(), moduleId: input.moduleId, version: input.version, userId: clipText(input.userId, 160),
      category: input.category, level: input.level, event: clipText(input.event, JOURNAL_LIMITS.event), detail: clipText(input.detail, JOURNAL_LIMITS.detail),
      outcome: clipText(input.outcome, JOURNAL_LIMITS.outcome), ms: Math.max(0, Math.round(input.ms) || 0), bytesIn: Math.max(0, Math.round(input.bytesIn) || 0), bytesOut: Math.max(0, Math.round(input.bytesOut) || 0),
    };
    if (!validEntry(entry)) return false;
    if (source === 'window') {
      const key = entry.moduleId, now = this.now(), w = this.windows.get(key);
      if (!w || now - w.at >= 1000) this.windows.set(key, { at: now, n: 1 });
      else if (++w.n > 50) return false;
      if (this.windows.size > 500) this.windows.clear();
    }
    this.state.seq++;
    this.state.entries.push({ ...entry, seq: this.state.seq });
    if (this.state.entries.length > this.ring + 100) this.rotate();
    this.schedule();
    return true;
  }

  /** Ещё не отправленные на сервер, по порядку */
  pending(limit: number = JOURNAL_LIMITS.batch): Array<JournalEntry & { seq: number }> {
    return this.state.entries.filter(e => e.seq > this.state.sent).slice(0, limit);
  }
  ack(upTo: number) {
    if (Number.isSafeInteger(upTo) && upTo > this.state.sent && upTo <= this.state.seq) { this.state.sent = upTo; this.schedule(); }
  }
  /** Для просмотра на этом компьютере: новые сверху */
  recent(limit = 200): JournalEntry[] {
    return this.state.entries.slice(-limit).reverse().map(({ seq: _seq, ...rest }) => rest);
  }
  size() { return this.state.entries.length; }

  /** Запись на диск откладывается: подряд идущие события не пишут файл каждое */
  private schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, 2000);
    this.timer.unref?.();
  }
  async flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(this.state));
      await fs.rename(tmp, this.file);
    } catch { /* диск недоступен: журнал остаётся в памяти до следующей попытки */ }
  }
}
