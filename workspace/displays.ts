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
/**
 * Каким должно быть общее окно Flux.
 *
 * `rect` — охват рабочих областей (workArea), а не границ (bounds) мониторов:
 * системная панель Windows лежит вне workArea, поэтому окно её просто не
 * касается и не прячет «полноэкранным» перекрытием монитора. Когда мониторы
 * одной высоты или стоят вровень, рабочие области сплошь заполняют охват
 * (`exact`), и окно остаётся обычным прямоугольником без нативной формы.
 * Если охват шире их объединения (мониторы разной высоты или со смещением),
 * `shape` — те же рабочие области в координатах окна: форма вырезает только
 * пустоту и панели, а панель Flux каждого монитора по-прежнему стоит у нижнего
 * края его workArea.
 */
export interface WorkspaceFrame { rect: DisplayRect; shape: DisplayRect[] | null; exact: boolean }
/** Щель уже этого — округление DIP при дробном масштабе, а не пустое место. */
export const FRAME_TOLERANCE = 2;
export function workspaceFrame(displays: WorkspaceDisplay[]): WorkspaceFrame {
  if (!displays.length) return { rect: { ...EMPTY_WORKSPACE.bounds }, shape: null, exact: true };
  const areas = displays.map(d => d.workArea);
  const x = Math.min(...areas.map(a => a.x));
  const y = Math.min(...areas.map(a => a.y));
  const rect = { x, y, w: Math.max(...areas.map(a => a.x + a.w)) - x, h: Math.max(...areas.map(a => a.y + a.h)) - y };
  // Сетка из границ рабочих областей: клетка шире допуска и не накрытая ни
  // одной областью — настоящая пустота, а не шов в 1 px.
  const xs = [...new Set(areas.flatMap(a => [a.x, a.x + a.w]))].sort((a, b) => a - b);
  const ys = [...new Set(areas.flatMap(a => [a.y, a.y + a.h]))].sort((a, b) => a - b);
  let exact = true;
  for (let i = 0; i + 1 < xs.length && exact; i++) for (let j = 0; j + 1 < ys.length && exact; j++) {
    if (xs[i + 1] - xs[i] <= FRAME_TOLERANCE || ys[j + 1] - ys[j] <= FRAME_TOLERANCE) continue;
    const cx = (xs[i] + xs[i + 1]) / 2, cy = (ys[j] + ys[j + 1]) / 2;
    if (!areas.some(a => containsPoint(a, cx, cy))) exact = false;
  }
  return { rect, exact, shape: exact ? null : areas.map(a => ({ x: a.x - x, y: a.y - y, w: a.w, h: a.h })) };
}
/** Равны ли прямоугольники с допуском: Windows при 125 % округляет границы окна. */
export function sameRect(a: DisplayRect, b: DisplayRect, tolerance = FRAME_TOLERANCE): boolean {
  return Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance
    && Math.abs(a.w - b.w) <= tolerance && Math.abs(a.h - b.h) <= tolerance;
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
