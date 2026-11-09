/**
 * Журнал подпрограмм со стороны окна: события окна уходят в главный процесс
 * пачкой (он проверяет форму и частоту), а накопленное там — на сервер
 * (`/api/modules/journal`) с подтверждением по номеру. Данные проектов и
 * содержимое вызовов сюда не попадают: передаются виды данных и размеры.
 */
import type { JournalCategory, JournalLevel } from '../../modules/journal/model';
import { bridge, call } from './moduleReleaseService';

export interface JournalInput {
  moduleId: string; version: string; category: JournalCategory; level?: JournalLevel;
  event: string; detail?: string; outcome?: string; ms?: number; bytesIn?: number; bytesOut?: number;
}

let queue: JournalInput[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

async function flushQueue() {
  timer = null;
  const entries = queue.splice(0, 50);
  if (queue.length) timer = setTimeout(() => { void flushQueue(); }, 1000);
  if (entries.length) await bridge()?.invoke('modules:journal-add', { entries: entries.map(e => ({ level: 'info', detail: '', outcome: '', ms: 0, bytesIn: 0, bytesOut: 0, ...e })) }).catch(() => null);
}

/** Событие окна; без главного процесса (веб-окно) журнала нет: подпрограммы там не запускаются из базы */
export function journalEvent(input: JournalInput) {
  if (!bridge()) return;
  // Предел очереди: неисправная подпрограмма не раздувает память окна
  if (queue.length < 500) queue.push(input);
  timer ||= setTimeout(() => { void flushQueue(); }, 1000);
}

let syncing: Promise<void> | null = null;
/** Отправка накопленного на сервер; повтор безопасен — сервер принимает записи по уникальному номеру */
export function syncJournal(): Promise<void> {
  return syncing ||= (async () => {
    const ipc = bridge();
    if (!ipc) return;
    await flushQueue();
    for (let round = 0; round < 5; round++) {
      const pending = await ipc.invoke('modules:journal-pending', {}).catch(() => null);
      const entries: Array<{ seq: number }> = pending?.ok ? pending.entries : [];
      if (!entries.length) return;
      await call('POST', '/journal', { entries: entries.map(({ seq: _seq, ...rest }) => rest) });
      await ipc.invoke('modules:journal-ack', { upTo: entries[entries.length - 1].seq });
      if (entries.length < 200) return;
    }
  })().catch(() => { /* нет связи: записи остаются на компьютере до следующей попытки */ }).finally(() => { syncing = null; });
}
