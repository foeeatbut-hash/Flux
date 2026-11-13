/**
 * Замечания владельца к строкам, привязанные к снимку отправки.
 *
 * Владелец писал замечание к строке версии, которую получил, то есть к снимку отправки (studio/shared/history.ts). С тех пор
 * разработчик правил файл: строки сдвинулись, а нужная могла измениться или пропасть. Здесь замечание переносится на
 * сегодняшний файл по построчной разнице (`modules/trust/diff.ts`, тот же код, что считает разницу владельцу) и помечается
 * «строка изменилась», если исходной строки в файле больше нет. Без снимка отправки привязка невозможна: замечание остаётся на
 * своём номере и ничего не утверждает про изменения.
 */
import { diffLines } from '../../modules/trust/diff';

export interface OwnerNote { path: string; line: number | null; text: string }
export interface AnchoredNote extends OwnerNote {
  /** Где строка сейчас; null — файла больше нет или замечание относится ко всему файлу */
  currentLine: number | null;
  /** Строка с тех пор изменилась или исчезла */
  changed: boolean;
  /** Есть снимок отправки, по которому замечание привязано */
  anchored: boolean;
  /** Файла замечания в проекте больше нет */
  fileGone: boolean;
}

/** Строка `line` (с 1) старого текста в новом: куда переехала и осталась ли такой же */
export function locateLine(before: string, after: string, line: number): { line: number; changed: boolean } {
  let oldN = 0, newN = 0;
  for (const part of diffLines(before, after)) {
    if (part.op === '+') { newN++; continue; }
    oldN++;
    if (part.op === ' ') newN++;
    if (oldN === line) return part.op === ' ' ? { line: newN, changed: false } : { line: newN + 1, changed: true };
  }
  return { line: Math.max(1, newN), changed: true };
}

/** `snapshot` — тексты файлов снимка отправки (null — снимка нет); `current` — текст файла сейчас (null — файла нет) */
export function anchorNotes(notes: OwnerNote[], snapshot: ((path: string) => string | null) | null, current: (path: string) => string | null): AnchoredNote[] {
  return notes.map((n): AnchoredNote => {
    const now = current(n.path);
    if (now === null) return { ...n, currentLine: null, changed: snapshot !== null, anchored: snapshot !== null, fileGone: true };
    if (n.line === null) return { ...n, currentLine: null, changed: false, anchored: snapshot !== null, fileGone: false };
    const then = snapshot ? snapshot(n.path) : null;
    if (then === null) return { ...n, currentLine: n.line, changed: false, anchored: false, fileGone: false };
    const at = locateLine(then, now, n.line);
    return { ...n, currentLine: at.line, changed: at.changed, anchored: true, fileGone: false };
  });
}
