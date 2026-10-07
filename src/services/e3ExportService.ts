import { ENV_CONFIG } from '../config/env';
import type { Binding } from '../../e3/exportTypes';
import type { JournalEntry } from '../../e3/exportRun';

export type ExportState = 'PLANNED' | 'RUNNING' | 'DONE' | 'INTERRUPTED' | 'UNDONE';
export interface E3Link { id: string; fluxProjectId: string; key: string; name: string; path: string; e3Version: string; partsDb: string }
export interface E3ExportInfo { id: string; sheet: string; at: string; state: ExportState; steps: number; done: number; summary: Record<string, number>; classifierVersion: number }
export interface E3ExportFull extends E3ExportInfo { plan: { steps: any[] }; journal: JournalEntry[]; report: any }

/** Проект E3 занят другой выгрузкой (С18): окно ждёт и пробует снова */
export class E3BusyExport extends Error { constructor(message: string, public exportId: string) { super(message); } }

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${ENV_CONFIG.apiUrl}${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw res.status === 409 && data.busy ? new E3BusyExport(data.error, data.exportId) : new Error(data.error || `Ошибка ${res.status}`);
  return data;
}
const P = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/e3`;

export const e3ExportService = {
  projects: (projectId: string) => call<E3Link[]>('GET', `${P(projectId)}/projects`),
  link: (projectId: string, body: { key: string; name: string; path?: string; e3Version?: string }) => call<E3Link>('PUT', `${P(projectId)}/link`, body),
  bindings: (projectId: string, e3ProjectId: string) => call<Binding[]>('GET', `${P(projectId)}/projects/${e3ProjectId}/bindings`),
  exports: (projectId: string, e3ProjectId: string) => call<E3ExportInfo[]>('GET', `${P(projectId)}/projects/${e3ProjectId}/exports`),
  create: (projectId: string, e3ProjectId: string, body: { sheet: string; plan: unknown; classifierVersion: number; profile?: unknown }) => call<E3ExportFull>('POST', `${P(projectId)}/projects/${e3ProjectId}/exports`, body),
  get: (id: string) => call<E3ExportFull>('GET', `/e3-exports/${id}`),
  start: (id: string) => call<E3ExportFull>('POST', `/e3-exports/${id}/start`, {}),
  resume: (id: string) => call<{ export: E3ExportFull; remaining: number[] }>('POST', `/e3-exports/${id}/resume`, {}),
  steps: (id: string, results: JournalEntry[]) => call<E3ExportFull>('POST', `/e3-exports/${id}/steps`, { results }),
  finish: (id: string, body: { state: 'DONE' | 'INTERRUPTED'; bindings?: Binding[]; report?: unknown }) => call<E3ExportFull>('POST', `/e3-exports/${id}/finish`, body),
  undo: (id: string, body: { removed: string[]; kept: { positionId: string; reason: string }[] }) => call<E3ExportFull>('POST', `/e3-exports/${id}/undo`, body),
};
