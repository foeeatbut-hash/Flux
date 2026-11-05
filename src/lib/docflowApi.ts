/**
 * Запросы программы «Документооборот» к серверу: настройки проекта, шаблоны,
 * перенос стандартов, связи файлов со строками ВДР.
 *
 * Ответ — всегда `{ ok, status, data }`: экран сам решает, что показать на
 * 409 (перечитать и сказать «уже изменили»), а что — на 403 (нет права).
 */
import type { DocflowConfig } from '../../shared/docflow/config';

export interface ApiAnswer<T = any> { ok: boolean; status: number; data: T & { error?: string } }

export async function docflowCall<T = any>(method: string, url: string, body?: unknown): Promise<ApiAnswer<T>> {
  try {
    const r = await fetch(url, {
      method, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data };
  } catch (err: any) {
    return { ok: false, status: 0, data: { error: err?.message || 'Нет связи с сервером' } as any };
  }
}

export interface SettingsSourceView { kind: 'project' | 'template' | 'standard' | 'default'; name: string; at: string }
export interface SettingsView {
  projectId: string; config: DocflowConfig; source: SettingsSourceView | null; stored: boolean;
  updatedAt: string | null; canUndo: boolean; undoLabel: string;
}
export interface TemplateView { id: string; name: string; updatedAt: string | null; types: number }

export const getSettings = (projectId: string) => docflowCall<SettingsView>('GET', `/api/docflow/settings?projectId=${encodeURIComponent(projectId)}`);
export const putSettings = (projectId: string, config: DocflowConfig, expectedUpdatedAt: string | null) =>
  docflowCall<SettingsView & { current?: SettingsView }>('PUT', '/api/docflow/settings', { projectId, config, expectedUpdatedAt });
export type CopySource = { projectId?: string; templateId?: string };
export const copyPlan = (projectId: string, from: CopySource, sections: string[]) =>
  docflowCall<{ source: SettingsSourceView; expected: string | null; sections: Array<{ key: string; label: string; lines: string[] }> }>('POST', '/api/docflow/settings/copy-plan', { projectId, from, sections });
export const copyApply = (projectId: string, from: CopySource, sections: string[], expectedUpdatedAt: string | null) =>
  docflowCall<SettingsView>('POST', '/api/docflow/settings/copy-apply', { projectId, from, sections, expectedUpdatedAt });
export const undoSettings = (projectId: string) => docflowCall<SettingsView>('POST', '/api/docflow/settings/undo', { projectId });
export const listTemplates = () => docflowCall<{ templates: TemplateView[] }>('GET', '/api/docflow/templates');
export const saveTemplate = (projectId: string, name: string) => docflowCall<{ template: { id: string; name: string } }>('POST', '/api/docflow/templates', { projectId, name });
export const deleteTemplate = (id: string) => docflowCall('DELETE', `/api/docflow/templates/${encodeURIComponent(id)}`);

export interface MigrationPlan {
  projects: Array<{ projectId: string; projectName: string; standardId: string | null; standardName: string; registers: number; note: string }>;
  templates: number; applied: { at: string; created: Array<{ projectId: string }> } | null;
}
export const migrationPlan = () => docflowCall<MigrationPlan>('GET', '/api/docflow/migration');
export const migrationApply = (projectIds: string[]) => docflowCall<MigrationPlan>('POST', '/api/docflow/migration/apply', { projectIds });
export const migrationUndo = () => docflowCall<{ kept: string[]; plan: MigrationPlan }>('POST', '/api/docflow/migration/undo', {});
