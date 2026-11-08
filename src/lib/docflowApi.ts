/**
 * Запросы программы «Документооборот» к серверу: настройки проекта, шаблоны,
 * перенос стандартов, связи файлов со строками ВДР.
 *
 * Ответ — всегда `{ ok, status, data }`: экран сам решает, что показать на
 * 409 (перечитать и сказать «уже изменили»), а что — на 403 (нет права).
 */
import type { DocflowConfig } from '../../shared/docflow/config';
import type { DocLinkDto, IssueDto, LinkedItemBrief } from '../../shared/docflow/links';
import type { NameCheck, RowForCheck } from '../../shared/docflow/nameMask';

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
export const copyPlan = (projectId: string, from: CopySource, sections: string[], includeCatalog = false) =>
  docflowCall<{ source: SettingsSourceView; expected: string | null; sections: Array<{ key: string; label: string; lines: string[] }>; catalogToken?: string }>('POST', '/api/docflow/settings/copy-plan', { projectId, from, sections, includeCatalog });
export const copyApply = (projectId: string, from: CopySource, sections: string[], expectedUpdatedAt: string | null, includeCatalog = false, catalogToken?: string) =>
  docflowCall<SettingsView>('POST', '/api/docflow/settings/copy-apply', { projectId, from, sections, expectedUpdatedAt, includeCatalog, catalogToken });
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

// ── Связи файлов со строками ВДР (server/routes/docflowLinks.ts) ──
export interface LinksView { links: DocLinkDto[]; items: Record<string, LinkedItemBrief>; issues: IssueDto[] }
export interface LinkPlan { check: NameCheck; expectedName: string; blocked: boolean; reason: string; sameRevisionFile: DocLinkDto | null; /** Строка так, как её видит проверка имени: из неё собираются имя файла и подпапка. */ row: RowForCheck }
export interface LinkRequest {
  itemId: string; role?: 'file' | 'remarks'; toLinkId?: string; folderKey: string; relativePath: string; fileName: string;
  sha256?: string; size?: number; reviewCode?: string; receivedAt?: string | null; timeZone?: string; replace?: boolean;
}
export interface TrackUpdate { itemId: string; linkId: string; folderKey?: string; relativePath?: string; fileName?: string; sha256?: string; size?: number; lost?: boolean }

export const getLinks = (projectId: string) => docflowCall<LinksView>('GET', `/api/docflow/links?projectId=${encodeURIComponent(projectId)}`);
export const getItemLinks = (itemId: string) => docflowCall<LinksView>('GET', `/api/docflow/links?itemId=${encodeURIComponent(itemId)}&history=1`);
export const planLink = (itemId: string, fileName: string) => docflowCall<LinkPlan>('POST', '/api/docflow/links/plan', { itemId, fileName });
/** Отказ 422 несёт `check` с расхождениями по полям, 409 — `replaceable`, если у строки уже есть файл этой ревизии. */
export const createLink = (body: LinkRequest) => docflowCall<{ link: DocLinkDto; replaced: DocLinkDto | null; check: NameCheck | null; replaceable?: boolean; linkId?: string }>('POST', '/api/docflow/links', body);
export const unlinkLink = (itemId: string, linkId: string, reason?: string) => docflowCall<{ links: DocLinkDto[] }>('POST', '/api/docflow/links/unlink', { itemId, linkId, reason });
export const trackLinks = (updates: TrackUpdate[]) => docflowCall<{ links: DocLinkDto[] }>('POST', '/api/docflow/links/track', { updates });
