/**
 * Что делать с открытой вкладкой, когда файл изменился на диске снаружи.
 *
 * `saved` — текст, как он был на диске при последнем чтении или сохранении из Studio; `edited` — то, что сейчас в
 * редакторе; `disk` — что на диске сейчас. Тихо терять правки нельзя: пока в редакторе есть несохранённое и диск
 * отличается от прочитанного, Studio спрашивает «перечитать / оставить моё».
 */
export type ExternalChange = 'same' | 'reload' | 'ask' | 'removed';

export function reconcile(saved: string, edited: string, disk: string | null): ExternalChange {
  if (disk === null) return 'removed';
  if (disk === saved) return 'same';
  // Диск изменился: если своих несохранённых правок нет (или они совпали с диском) — показываем новое молча
  if (edited === saved || edited === disk) return 'reload';
  return 'ask';
}
