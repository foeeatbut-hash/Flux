import type { DiagnosticEvent } from './contracts';
import { cleanFields } from './event';
import { groupIncidents, type Incident } from './incidents';

export interface AutomaticIncident extends Incident { resolvedAt?: string }
export interface AutomaticState {
  cursors: Record<string, { seq: number; at: string }>;
  incidents: AutomaticIncident[];
}
export const emptyAutomaticState = (): AutomaticState => ({ cursors: {}, incidents: [] });

/** Только контрактные поля; источник и сеанс не могут подменить сервер. */
export function automaticEvents(input: unknown, allowed: string[], now = Date.now()): DiagnosticEvent[] {
  if (!Array.isArray(input) || input.length > 1000) return [];
  return input.flatMap((e: any) => {
    if (!e || !allowed.includes(e.source) || !/^[a-z0-9-]{1,80}$/i.test(e.session || '') || !Number.isSafeInteger(e.seq) || e.seq < 0) return [];
    const at = Date.parse(e.time);
    if (!Number.isFinite(at) || at > now + 60000 || at < now - 86400000) return [];
    if (typeof e.event !== 'string' || !e.data || typeof e.data !== 'object' || Array.isArray(e.data)) return [];
    const data = cleanFields(e.event, e.data);
    if (!data) return [];
    return [{ v: 1 as const, time: new Date(at).toISOString(), session: e.session, seq: e.seq, source: e.source, event: e.event, data }];
  });
}

/** Повторный опрос журнала не увеличивает число ошибок. */
export function mergeAutomatic(state: AutomaticState, events: DiagnosticEvent[]): AutomaticState {
  const cursors = { ...state.cursors };
  const fresh = events.slice().sort((a, b) => a.seq - b.seq).filter(e => {
    const key = `${e.source}:${e.session}`;
    if (e.seq <= (cursors[key]?.seq ?? -1)) return false;
    cursors[key] = { seq: e.seq, at: e.time };
    return true;
  });
  const incidents = new Map(state.incidents.map(i => [i.fingerprint, i]));
  for (const item of groupIncidents(fresh, true)) {
    const old = incidents.get(item.fingerprint);
    incidents.set(item.fingerprint, old ? {
      ...item, firstAt: old.firstAt < item.firstAt ? old.firstAt : item.firstAt,
      lastAt: old.lastAt > item.lastAt ? old.lastAt : item.lastAt,
      count: old.count + item.count,
      traces: [...new Set([...old.traces, ...item.traces])].slice(-20),
      evidence: [...old.evidence, ...item.evidence].slice(-20),
      ...(old.resolvedAt && item.lastAt <= old.resolvedAt ? { resolvedAt: old.resolvedAt } : {}),
    } : item);
  }
  return {
    cursors: Object.fromEntries(Object.entries(cursors).sort((a, b) => b[1].at.localeCompare(a[1].at)).slice(0, 32)),
    incidents: [...incidents.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt)).slice(0, 100),
  };
}
