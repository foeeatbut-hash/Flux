import { specOf, type ExportSpec } from './exportSpec';
import { rowsOfSystem, type RowSystem, type RowComponent } from './equipmentRows';
import { classifyAll } from '../../equipment/classes';
import { normalizeSpecs } from './specs';
import type { ExchangeComponent } from './equipmentExchange';

export type ExportTab = 'source' | 'columns' | 'group' | 'templates';
export interface ExportDraft { scope: string; spec: ExportSpec; name: string; personal: boolean; railOpen: boolean; railWidth: number; tab: ExportTab }
export const exportDraftKey = (projectId: string, userId: string) => `flux_export_draft:${encodeURIComponent(userId)}:${encodeURIComponent(projectId)}`;
export const exportBookKey = (projectId: string, userId: string) => `flux_export_workbook:${encodeURIComponent(userId)}:${encodeURIComponent(projectId)}`;

/** Не показываем и не сохраняем источники прежнего проекта во время его переключения. */
export const exportSourcesAreCurrent = (loadedProjectId: string, projectId: string): boolean => !!projectId && loadedProjectId === projectId;
/** Явная ссылка приоритетна; иначе окно остаётся с первоначальным проектом. */
export const exportProjectIdForWindow = (queryId: string, pinnedId: string, activeId: string): string => queryId || pinnedId || activeId;

/** Закрытие книги ждёт запись, начатую командой обновления листа. */
export async function saveAfterExportOperation(pending: Promise<unknown> | null, save: () => Promise<boolean>): Promise<boolean> {
  if (pending) await pending;
  return save();
}

/** У листа остаётся место даже после переноса окна на узкий монитор. */
export function railWidth(value: number, available: number): number {
  return Math.min(Math.max(180, Math.min(480, Math.round(available * .58))), Math.max(240, Number.isFinite(value) ? value : 320));
}

export function parseExportDraft(raw: string | null): ExportDraft | null {
  try {
    const v = JSON.parse(raw || 'null');
    if (!v || typeof v !== 'object' || typeof v.scope !== 'string') return null;
    return { scope: v.scope, spec: specOf(v.spec), name: typeof v.name === 'string' ? v.name : '', personal: v.personal !== false, railOpen: v.railOpen !== false, railWidth: railWidth(Number(v.railWidth), 1200), tab: ['source', 'columns', 'group', 'templates'].includes(v.tab) ? v.tab : 'source' };
  } catch { return null; }
}

export interface ExportSystem extends RowSystem { id: string; category: string; monoblocks: { name: string; components: (RowComponent & { equipClass?: string | null; equipKind?: string | null })[] }[] }
export interface ExportScope { id: string; label: string; count: number }

/** Охват привязан к id установки: одинаковые названия не смешивают оборудование. */
export function buildExportSources(systems: ExportSystem[], categories: { id: string; label: string }[]) {
  const classes = classifyAll(systems.flatMap(s => s.monoblocks.flatMap(m => m.components)));
  const bySystem = new Map<string, ExchangeComponent[]>(systems.map(s => [s.id, rowsOfSystem(s, normalizeSpecs).map(r => ({ ...r, cls: classes.get(r.id)?.cls, kind: classes.get(r.id)?.kind }))]));
  const rows = (scope: string): ExchangeComponent[] => {
    if (scope.startsWith('unit:')) return bySystem.get(scope.slice(5)) || [];
    const selected = scope.startsWith('cat:') ? systems.filter(s => s.category === scope.slice(4)) : scope === 'all' ? systems : [];
    return selected.flatMap(s => bySystem.get(s.id) || []);
  };
  const scopes: ExportScope[] = [{ id: 'all', label: 'Всё оборудование проекта', count: rows('all').length }];
  const names = new Map(categories.map(c => [c.id, c.label]));
  for (const id of new Set(systems.map(s => s.category))) scopes.push({ id: `cat:${id}`, label: names.get(id) || id || 'Без категории', count: rows(`cat:${id}`).length });
  for (const s of systems) scopes.push({ id: `unit:${s.id}`, label: `Установка «${s.name}»`, count: rows(`unit:${s.id}`).length });
  return { scopes, rows };
}
