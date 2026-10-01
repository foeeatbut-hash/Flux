import type { DiagnosticEvent } from './contracts';
import { cleanFields } from './event';

export type IncidentSeverity = 'error' | 'warning';
export interface IncidentEvidence {
  event: string;
  at: string;
  source: string;
  code?: string;
  status?: string;
  route?: string;
}
export interface Incident {
  id: string;
  fingerprint: string;
  key: string;
  title: string;
  severity: IncidentSeverity;
  firstAt: string;
  lastAt: string;
  count: number;
  sources: string[];
  routes: string[];
  traces: string[];
  codes: string[];
  frames: string[];
  evidence: IncidentEvidence[];
  nextSteps: string[];
}

const SOURCES = new Set(['renderer', 'server', 'electron']);
const ALWAYS_ERROR = new Set([
  'fetch.error', 'socket.error', 'log.error', 'renderer.error', 'renderer.rejection',
  'process.uncaught', 'renderer.gone', 'child.gone', 'window.load-error',
]);
const OMIT_OUTCOMES = new Set(['cancelled', 'conflict', 'skipped']);
const SAFE = /^[A-Za-z0-9_.:/-]{1,80}$/;

function safe(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE.test(value) ? value : undefined;
}
function millis(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
function fnv1a(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

interface Candidate { event: DiagnosticEvent; severity: IncidentSeverity; route?: string; code?: string; status?: string; source: string; at: string; trace?: string }

function candidate(event: DiagnosticEvent): Candidate | undefined {
  if (!event || !SOURCES.has(event.source) || typeof event.event !== 'string' || !event.data || typeof event.data !== 'object') return;
  const d = event.data;
  if (OMIT_OUTCOMES.has(String(d.outcome ?? ''))) return;
  const route = safe(d.route);
  const code = safe(d.code) || safe(d.error);
  const status = safe(typeof d.status === 'number' ? String(d.status) : d.status);
  const numericStatus = Number(status);
  if (event.event === 'http.end' || event.event === 'fetch.headers') {
    if (Number.isFinite(numericStatus) && numericStatus >= 400 && numericStatus < 500) return;
    if (Number.isFinite(numericStatus) && numericStatus >= 500) {
      return { event, severity: 'error', route, code: status, status, source: event.source, at: event.time, trace: safe(d.trace) };
    }
  }
  if (event.event === 'db.op' && code === 'P2024') {
    return { event, severity: 'error', route, code, source: event.source, at: event.time, trace: safe(d.trace) };
  }
  if (ALWAYS_ERROR.has(event.event) || d.outcome === 'error' || d.ok === false) {
    return { event, severity: 'error', route, code, status, source: event.source, at: event.time, trace: safe(d.trace) };
  }
  if (event.event === 'ui.stall' && millis(d.durationMs) !== undefined) {
    return { event, severity: 'warning', route, code, source: event.source, at: event.time, trace: safe(d.trace) };
  }
  if (event.event === 'http.end' && (millis(d.durationMs) ?? 0) >= 5000) {
    return { event, severity: 'warning', route, code: status, status, source: event.source, at: event.time, trace: safe(d.trace) };
  }
  return;
}

function titleFor(c: Candidate): { title: string; nextSteps: string[] } {
  if (c.event.event === 'ui.stall') return { title: 'Повторяются длительные паузы интерфейса', nextSteps: ['Проверить длительные задачи интерфейса и нагрузку главного потока.'] };
  if (c.event.event === 'http.end' && c.severity === 'warning') return { title: 'Повторяются медленные HTTP-запросы', nextSteps: ['Проверить время ответа и связанные операции базы данных для этого маршрута.'] };
  if (c.event.event === 'db.op' && c.code === 'P2024') return { title: 'Тайм-аут ожидания соединения с базой данных (P2024)', nextSteps: ['Проверить доступность базы данных, пул соединений и длительные запросы.'] };
  if (c.event.event === 'http.end' || c.event.event === 'fetch.headers') return { title: `Сервер возвращает ошибку HTTP${c.status ? ` ${c.status}` : ''}`, nextSteps: ['Проверить обработчик маршрута и связанные записи сервера.'] };
  if (c.event.event === 'db.op') return { title: 'Операция базы данных завершилась ошибкой', nextSteps: ['Проверить код ошибки и состояние базы данных.'] };
  if (c.event.event.startsWith('fetch.')) return { title: 'Ошибка сетевого запроса', nextSteps: ['Проверить доступность сервера и сетевое соединение.'] };
  if (c.event.event.startsWith('renderer.')) return { title: 'Ошибка в окне приложения', nextSteps: ['Проверить безопасные сведения события и соответствующий участок интерфейса.'] };
  if (c.event.event === 'process.uncaught') return { title: 'Необработанная ошибка процесса', nextSteps: ['Проверить безопасные кадры стека и журналы процесса.'] };
  return { title: 'Ошибка диагностического события', nextSteps: ['Проверить тип события и безопасный код ошибки.'] };
}

/** Группирует только разрешённые технические поля; свободный текст не попадает в результат. */
export function groupIncidents(events: DiagnosticEvent[], includeSingleWarnings = false): Incident[] {
  const groups = new Map<string, Candidate[]>();
  for (const event of events) {
    const c = candidate(event);
    if (!c) continue;
    const clean = cleanFields(c.event.event, c.event.data);
    const tuple = [c.event.event, c.route ?? '', c.code ?? '', c.source, String(clean?.frame1 || ''), String(clean?.model || ''), String(clean?.operation || '')];
    const fingerprint = JSON.stringify(tuple);
    const list = groups.get(fingerprint) ?? [];
    list.push(c);
    groups.set(fingerprint, list);
  }
  const incidents: Incident[] = [];
  for (const [fingerprint, all] of groups) {
    const first = all[0];
    const severity = first.severity;
    if (severity === 'warning' && all.length < 2 && !includeSingleWarnings) continue;
    const ordered = [...all].sort((a, b) => a.at.localeCompare(b.at));
    const { title, nextSteps } = titleFor(first);
    const tuple = JSON.parse(fingerprint) as string[];
    const code = tuple[2];
    const route = tuple[1];
    const key = `${tuple[3]}|${tuple[0]}|${route}|${code}`;
    const values = (select: (c: Candidate) => string | undefined) => [...new Set(all.map(select).filter((v): v is string => Boolean(v)))].sort();
    incidents.push({
      id: `inc-${fnv1a(fingerprint)}`, fingerprint, key, title, severity,
      firstAt: ordered[0].at, lastAt: ordered[ordered.length - 1].at, count: all.length,
      sources: values(c => c.source), routes: values(c => c.route), traces: values(c => c.trace), codes: values(c => c.code),
      frames: [...new Set(all.flatMap(c => { const clean = cleanFields(c.event.event, c.event.data); return [clean?.frame1, clean?.frame2, clean?.frame3].filter((f): f is string => typeof f === 'string' && !!f); }))].slice(0, 10),
      evidence: ordered.slice(0, 20).map(c => ({ event: c.event.event, at: c.at, source: c.source, ...(c.code ? { code: c.code } : {}), ...(c.status ? { status: c.status } : {}), ...(c.route ? { route: c.route } : {}) })),
      nextSteps,
    });
  }
  return incidents.sort((a, b) => (a.severity === b.severity ? a.firstAt.localeCompare(b.firstAt) || a.id.localeCompare(b.id) : a.severity === 'error' ? -1 : 1)).slice(0, 100);
}
