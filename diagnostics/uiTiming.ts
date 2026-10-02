/** Pure timing helpers for visible renderer activity. Times are performance.now() values. */
export interface VisibleTimer { expectedAt: number | null }

export function armVisibleTimer(now: number, visible: boolean, intervalMs = 1000): VisibleTimer {
  return { expectedAt: visible ? now + intervalMs : null };
}

export function tickVisibleTimer(state: VisibleTimer, now: number, visible: boolean, intervalMs = 1000): { state: VisibleTimer; lagMs: number | null } {
  if (!visible || state.expectedAt === null) return { state: armVisibleTimer(now, visible, intervalMs), lagMs: null };
  const lagMs = Math.max(0, now - state.expectedAt);
  return { state: { expectedAt: now + intervalMs }, lagMs };
}

/** Returns a gap only when consecutive animation-frame samples are visible. */
export function frameGap(previousAt: number | null, now: number, visible: boolean): { previousAt: number | null; gapMs: number | null } {
  if (!visible) return { previousAt: null, gapMs: null };
  return { previousAt: now, gapMs: previousAt === null ? null : Math.max(0, now - previousAt) };
}
