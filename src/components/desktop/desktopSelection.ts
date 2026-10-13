export type DesktopSelection = { ids: string[]; anchor: string | null };
export function desktopClickSelection(current: DesktopSelection, ordered: string[], id: string, modifiers: { ctrl?: boolean; shift?: boolean }): DesktopSelection {
  if (modifiers.shift) {
    const start = ordered.indexOf(current.anchor || id), end = ordered.indexOf(id);
    const range = start < 0 || end < 0 ? [id] : ordered.slice(Math.min(start, end), Math.max(start, end) + 1);
    return { ids: modifiers.ctrl ? [...new Set([...current.ids, ...range])] : range, anchor: current.anchor || id };
  }
  if (modifiers.ctrl) return { ids: current.ids.includes(id) ? current.ids.filter((item) => item !== id) : [...current.ids, id], anchor: current.anchor || id };
  return { ids: [id], anchor: id };
}
export function desktopMarqueeSelection(current: DesktopSelection, hits: string[], modifiers: { ctrl?: boolean; shift?: boolean }): DesktopSelection {
  return !modifiers.ctrl && !modifiers.shift ? { ids: hits, anchor: hits[0] || null } : { ids: [...new Set([...current.ids, ...hits])], anchor: current.anchor || hits[0] || null };
}
export const desktopSelectAll = (ordered: string[]): DesktopSelection => ({ ids: [...ordered], anchor: ordered[0] || null });
