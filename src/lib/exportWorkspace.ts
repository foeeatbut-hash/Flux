import { rowsOfSystem, type RowSystem, type RowComponent } from './equipmentRows';
import { classifyAll } from '../../equipment/classes';
import { normalizeSpecs } from './specs';
import type { ExchangeComponent } from './equipmentExchange';

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
