/**
 * Журнал запуска в памяти: подключения и вызовы программ пишут сюда те же записи, что во Flux, но на диск они не попадают.
 *
 * Зачем отдельный класс: ModuleConnections и ModuleProgramCalls требуют только `add` (electron/moduleJournal.ts пишет файл Flux),
 * а запуск в Studio не должен ни читать, ни писать данные Flux. Окно показывает человеку свои строки журнала запуска; записи отсюда
 * нужны проверкам и отладке (метаданные без содержимого вызовов), поэтому кольцо небольшое.
 */
import type { JournalEntry } from '../../modules/journal/model';

export type RunJournalInput = Omit<JournalEntry, 'id' | 'at'> & { at?: number };
const RING = 200;

export class RunJournal {
  private list: Array<RunJournalInput & { at: number }> = [];
  add(input: RunJournalInput): boolean {
    this.list.push({ ...input, at: input.at ?? Date.now() });
    if (this.list.length > RING) this.list.splice(0, this.list.length - RING);
    return true;
  }
  get entries(): ReadonlyArray<RunJournalInput & { at: number }> { return this.list; }
  clear(): void { this.list = []; }
}
