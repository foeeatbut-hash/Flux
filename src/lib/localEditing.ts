/**
 * Какие файлы сейчас открыты на правку в редакторах этого Flux (docs/docflow-program.md, 7.1).
 * Учёт только локальный: у сервера нет сведений о том, что открыто у коллег на их компьютерах,
 * и новый учёт ради выпуска не строился — ограничение записано в PR и методологии.
 */
import type { WindowsFileRef } from './windowsFiles';

const open = new Map<number, WindowsFileRef>();
const keyOf = (ref: WindowsFileRef) => `${ref.rootId}\n${ref.relativePath.replace(/\\/g, '/').toLowerCase()}`;

export const markEditing = (session: number, ref: WindowsFileRef) => { open.set(session, ref); };
export const unmarkEditing = (session: number) => { open.delete(session); };
export const isEditedHere = (ref: WindowsFileRef): boolean => { const wanted = keyOf(ref); for (const r of open.values()) if (keyOf(r) === wanted) return true; return false; };
