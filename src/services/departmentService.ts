/**
 * Запросы к справочнику подразделений (server/routes/departments.ts).
 *
 * Свой тонкий вызов, а не общий `request` из dataService: тот при сбое подставляет
 * локальные данные, а для перевода людей «ответ сервера не получен» должен
 * остаться ошибкой — иначе человек решит, что перевод прошёл.
 */
import type { DepartmentLite } from '../../shared/departments';

export interface DepartmentRow extends DepartmentLite {
  /** Людей прямо в подразделении */
  people: number;
  /** Людей в нём и во всём, что внутри */
  total: number;
}

export interface DepartmentTreeReply { rootId: string; unassigned: number; departments: DepartmentRow[] }

export interface AssignPlanItem {
  userId: string; symbol: string; name: string; role: string;
  fromId: string | null; toId: string; status: 'move' | 'same' | 'skip'; note?: string;
}

export type TextMatch =
  | { status: 'none' }
  | { status: 'match'; departmentId: string }
  | { status: 'create'; parentId: string; chain: string[] }
  | { status: 'ambiguous'; candidates: string[] };

export interface LegacyGroup { key: string; text: string; count: number; names: string[]; match: TextMatch }
export interface LegacyChoice { key: string; action: 'create' | 'map' | 'skip'; departmentId?: string; parentId?: string; name?: string }

export class DepartmentApiError extends Error {
  status: number;
  data: any;
  constructor(message: string, status: number, data: any) { super(message); this.status = status; this.data = data; }
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/departments${url}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new DepartmentApiError(data?.message || data?.error || `Запрос не выполнен (${res.status})`, res.status, data);
  return data as T;
}

export const departmentService = {
  tree: (archived = false) => call<DepartmentTreeReply>('GET', archived ? '?archived=1' : ''),
  create: (input: { name: string; parentId?: string; kind?: string; city?: string; timezone?: string }) => call<DepartmentLite>('POST', '', input),
  update: (id: string, patch: Partial<{ name: string; shortName: string; city: string; timezone: string; sortOrder: number; kind: string }>) => call<DepartmentLite>('PUT', `/${id}`, patch),
  move: (id: string, parentId: string, sortOrder?: number) => call<DepartmentLite>('PUT', `/${id}/move`, { parentId, sortOrder }),
  archive: (id: string, moveTo?: string) => call<{ archived: number; moved: number; undoToken: string }>('POST', `/${id}/archive`, { moveTo }),
  restore: (id: string) => call<{ restored: number }>('POST', `/${id}/restore`, {}),
  assignPreview: (userIds: string[], departmentId: string) => call<{ department: DepartmentLite; items: AssignPlanItem[] }>('POST', '/assign/preview', { userIds, departmentId }),
  assign: (userIds: string[], departmentId: string, reason?: string) =>
    call<{ moved: number; same: number; skipped: AssignPlanItem[]; undoToken: string | null }>('POST', '/assign', { userIds, departmentId, reason }),
  undo: (undoToken: string) => call<{ success: boolean; restored: number; removed: number }>('POST', '/undo', { undoToken }),
  legacyPlan: (parentId?: string) => call<{ groups: LegacyGroup[]; withoutText: number }>('GET', `/legacy/plan${parentId ? `?parentId=${encodeURIComponent(parentId)}` : ''}`),
  legacyApply: (choices: LegacyChoice[]) => call<{ assigned: number; created: number; undoToken: string | null }>('POST', '/legacy/apply', { choices }),
  history: (userId: string) => call<Array<{ id: string; fromId: string | null; toId: string | null; by: string; at: string; reason: string | null }>>('GET', `/history/${encodeURIComponent(userId)}`),
};
