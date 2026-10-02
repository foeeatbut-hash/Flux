export interface MenuBounds { x: number; y: number; w: number; h: number }
export interface MenuPoint { left: number; top: number; maxHeight: number; maxWidth: number }

/** Располагает меню по его измеренному размеру внутри рабочего поля монитора. */
export function placeContextMenu(
  x: number, y: number, width: number, height: number, bounds: MenuBounds, inset = 4,
): MenuPoint {
  const maxHeight = Math.max(1, bounds.h - inset * 2);
  const w = Math.min(Math.max(1, width), Math.max(1, bounds.w - inset * 2));
  const h = Math.min(Math.max(1, height), maxHeight);
  return {
    left: Math.max(bounds.x + inset, Math.min(x, bounds.x + bounds.w - w - inset)),
    top: Math.max(bounds.y + inset, Math.min(y, bounds.y + bounds.h - h - inset)),
    maxHeight,
    maxWidth: Math.max(1, bounds.w - inset * 2),
  };
}

/** Подменю раскрывается в свободную сторону и остаётся в пределах монитора. */
export function placeSubmenu(
  parent: MenuBounds, child: MenuBounds, bounds: MenuBounds, gap = 4,
): { side: 'left' | 'right'; left: number; top: number; maxHeight: number } {
  const maxHeight = Math.max(1, bounds.h - gap * 2);
  const h = Math.min(child.h, maxHeight);
  const right = parent.x + parent.w + gap;
  const left = parent.x - child.w - gap;
  const side = right + child.w <= bounds.x + bounds.w - gap ? 'right' : 'left';
  const raw = side === 'right' ? right : left;
  const x = Math.max(bounds.x + gap, Math.min(raw, bounds.x + bounds.w - Math.min(child.w, bounds.w - gap * 2) - gap));
  return {
    side: x <= parent.x ? 'left' : side,
    left: x,
    top: Math.max(bounds.y + gap, Math.min(parent.y - 5, bounds.y + bounds.h - h - gap)),
    maxHeight,
  };
}
