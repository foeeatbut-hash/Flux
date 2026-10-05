/** Координаты Electron screen — DIP: scaleFactor не применяется повторно. */
export interface DisplayRect { x: number; y: number; w: number; h: number }
export interface WorkspaceDisplay {
  id: number; label: string; primary: boolean; scaleFactor: number;
  bounds: DisplayRect; workArea: DisplayRect;
}
export interface DisplayWorkspace {
  enabled: boolean; displays: WorkspaceDisplay[]; bounds: DisplayRect;
  primaryId: number; mixedScale: boolean;
}
export const EMPTY_WORKSPACE: DisplayWorkspace = {
  enabled: false, displays: [], bounds: { x: 0, y: 0, w: 1280, h: 800 }, primaryId: 0, mixedScale: false,
};
export function unionDisplays(displays: WorkspaceDisplay[]): DisplayRect {
  if (!displays.length) return { ...EMPTY_WORKSPACE.bounds };
  const x = Math.min(...displays.map(d => d.bounds.x));
  const y = Math.min(...displays.map(d => d.bounds.y));
  return { x, y, w: Math.max(...displays.map(d => d.bounds.x + d.bounds.w)) - x,
    h: Math.max(...displays.map(d => d.bounds.y + d.bounds.h)) - y };
}
export function localDisplayAreas(state: DisplayWorkspace, reservedTaskbarHeight = 0): WorkspaceDisplay[] {
  return state.displays.map(d => ({ ...d,
      bounds: { ...d.bounds, x: d.bounds.x - state.bounds.x, y: d.bounds.y - state.bounds.y },
      // Даже старое сохранённое предпочтение не может занять место панели Windows.
      workArea: { ...d.workArea, x: d.workArea.x - state.bounds.x, y: d.workArea.y - state.bounds.y,
        h: Math.max(1, d.workArea.h - reservedTaskbarHeight) },
  }));
}
export function containsPoint(r: DisplayRect, x: number, y: number): boolean {
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
}
const distance = (r: DisplayRect, x: number, y: number) => {
  const dx = Math.max(r.x - x, 0, x - (r.x + r.w));
  const dy = Math.max(r.y - y, 0, y - (r.y + r.h));
  return dx * dx + dy * dy;
};
export function displayAt(displays: WorkspaceDisplay[], x: number, y: number): WorkspaceDisplay | null {
  return displays.find(d => containsPoint(d.workArea, x, y)) || displays.reduce<WorkspaceDisplay | null>(
    (best, d) => !best || distance(d.workArea, x, y) < distance(best.workArea, x, y) ? d : best, null,
  );
}
export function displayForRect(displays: WorkspaceDisplay[], rect: DisplayRect): WorkspaceDisplay | null {
  // Заголовок, а не середина большого документа: перенос определяется тем,
  // на каком экране человек удерживает окно.
  return displayAt(displays, rect.x + rect.w / 2, rect.y + 17);
}
export function recoverRect<T extends DisplayRect>(rect: T, displays: WorkspaceDisplay[]): T {
  if (!displays.length) return rect;
  const title = { x: rect.x, y: rect.y, w: rect.w, h: Math.min(34, rect.h) };
  if (displays.some(d => {
    const r = d.workArea;
    return Math.min(title.x + title.w, r.x + r.w) - Math.max(title.x, r.x) >= Math.min(96, rect.w)
      && title.y >= r.y && title.y + title.h <= r.y + r.h;
  })) return rect;
  const d = displayForRect(displays, rect)!;
  const r = d.workArea;
  const w = Math.min(rect.w, r.w), h = Math.min(rect.h, r.h);
  return { ...rect, w, h, x: Math.max(r.x, Math.min(rect.x, r.x + r.w - w)),
    y: Math.max(r.y, Math.min(rect.y, r.y + r.h - h)) };
}
export function rebaseRect<T extends DisplayRect>(rect: T, previous: DisplayRect, next: DisplayRect): T {
  return { ...rect, x: rect.x + previous.x - next.x, y: rect.y + previous.y - next.y };
}
export function displaySnap(zone: 'left' | 'right' | 'top', area: DisplayRect): DisplayRect {
  if (zone === 'top') return { ...area };
  const w = Math.round(area.w / 2);
  return { x: zone === 'left' ? area.x : area.x + area.w - w, y: area.y, w, h: area.h };
}
