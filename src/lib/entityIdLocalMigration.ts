import { useStore } from '../store/store';

export interface EntityIdMapping {
  model: string;
  oldId: string;
  newId: string;
  projectId?: string;
}

interface EntityIdMigrationHistoryRow {
  migrationId: string;
  state: 'APPLIED' | 'UNDONE';
  createdAt?: string;
  mappings: EntityIdMapping[];
}

const EQUIPMENT_SOURCES_KEY = 'flux.equipmentSources.local.v1';

export function reverseEntityIdMappings(rows: EntityIdMapping[]): EntityIdMapping[] {
  const projects = new Map((rows || []).filter((row) => modelKey(row.model) === 'project').map((row) => [row.oldId, row.newId]));
  return (rows || []).map(({ model, oldId, newId, projectId }) => ({
    model, oldId: newId, newId: oldId,
    ...(projectId && modelKey(model) !== 'project' ? { projectId: projects.get(projectId) || projectId } : {}),
  }));
}

function modelKey(model: string): string {
  return String(model).replace(/[^a-z]/giu, '').toLowerCase();
}

function mappedId(mappings: Map<string, Map<string, string>>, model: string, id: unknown, projectId?: string): string | undefined {
  if (typeof id !== 'string' || !id) return undefined;
  const modelMappings = mappings.get(modelKey(model));
  return modelKey(model) === 'project'
    ? modelMappings?.get(`*\u0000${id}`)
    : modelMappings?.get(`${projectId || '*'}\u0000${id}`) || modelMappings?.get(`*\u0000${id}`);
}

function makeMap(rows: EntityIdMapping[]): Map<string, Map<string, string>> {
  const result = new Map<string, Map<string, string>>();
  for (const row of rows || []) {
    if (!row?.model || !row.oldId || !row.newId || row.oldId === row.newId) continue;
    const model = modelKey(row.model);
    if (!result.has(model)) result.set(model, new Map());
    const scope = model === 'project' ? '*' : (row.projectId || '*');
    result.get(model)!.set(`${scope}\u0000${row.oldId}`, row.newId);
  }
  return result;
}

/**
 * Обновляет только известные клиенту ссылки на сущности. Доступы к файлам и
 * пути копируются без изменений; журнал сервера можно перечитывать при запуске,
 * поскольку после переноса прежние значения уже не совпадают.
 */
export function applyEntityIdMappingsLocally(rows: EntityIdMapping[]): { activeProjectChanged: boolean; equipmentSourcesChanged: number; warnings: string[] } {
  if (typeof window === 'undefined' || !rows?.length) return { activeProjectChanged: false, equipmentSourcesChanged: 0, warnings: [] };
  const mappings = makeMap(rows);
  const store = useStore.getState();
  const userId = store.user?.id;
  let activeProjectChanged = false;
  const warnings: string[] = [];

  if (userId) {
    const storageKey = `max_active_project_${userId}`;
    try {
      const raw = localStorage.getItem(storageKey);
      const project = raw ? JSON.parse(raw) : null;
      const id = mappedId(mappings, 'Project', project?.id);
      if (id) localStorage.setItem(storageKey, JSON.stringify({ ...project, id }));
    } catch { warnings.push('Не удалось обновить сохранённый выбор проекта.'); }

    const id = mappedId(mappings, 'Project', store.activeProject?.id);
    if (id && store.activeProject) {
      useStore.setState({ activeProject: { ...store.activeProject, id } });
      activeProjectChanged = true;
    }
  }

  let equipmentSourcesChanged = 0;
  try {
    const raw = localStorage.getItem(EQUIPMENT_SOURCES_KEY);
    const all = raw ? JSON.parse(raw) : null;
    if (!all || typeof all !== 'object' || Array.isArray(all)) return { activeProjectChanged, equipmentSourcesChanged, warnings };

    const next: Record<string, any> = {};
    for (const [oldKey, value] of Object.entries(all)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) { next[oldKey] = value; continue; }
      const binding = value as Record<string, any>;
      const migrated: Record<string, any> = {
        ...binding,
        projectId: mappedId(mappings, 'Project', binding.projectId) || binding.projectId,
        systemId: mappedId(mappings, 'EquipmentSystem', binding.systemId, binding.projectId) || binding.systemId,
        elementId: mappedId(mappings, 'ComponentElement', binding.elementId, binding.projectId) || binding.elementId,
        tagId: mappedId(mappings, 'Tag', binding.tagId, binding.projectId) || binding.tagId,
      };
      const changed = migrated.projectId !== binding.projectId || migrated.systemId !== binding.systemId
        || migrated.elementId !== binding.elementId || migrated.tagId !== binding.tagId;
      if (!changed) { next[oldKey] = value; continue; }
      equipmentSourcesChanged++;
      const user = String(migrated.userId || decodeURIComponent(oldKey.split(':', 1)[0] || ''));
      const newKey = [user, migrated.projectId, migrated.sourceId, migrated.elementId || ''].map((part) => encodeURIComponent(String(part || ''))).join(':');
      let targetKey = newKey;
      for (let duplicate = 1; targetKey in next; duplicate++) targetKey = `${newKey}:retained:${duplicate}`;
      next[targetKey] = migrated;
    }
    if (equipmentSourcesChanged) localStorage.setItem(EQUIPMENT_SOURCES_KEY, JSON.stringify(next));
  } catch { warnings.push('Не удалось обновить локальные связи с XML-файлами; они сохранены без изменений.'); }

  return { activeProjectChanged, equipmentSourcesChanged, warnings };
}

/** Подписывается на уведомления и обновляет ссылки только из доступного пользователю журнала. */
export function syncEntityIdMigrationHistory(apiUrl: string): () => void {
  let active = true;
  let latestRequest = 0;
  const refresh = async () => {
    const request = ++latestRequest;
    try {
      const response = await fetch(`${apiUrl}/settings/entity-id-migration/history`);
      if (!response.ok) return;
      const result = await response.json() as { migrations?: EntityIdMigrationHistoryRow[] };
      if (!active || request !== latestRequest || !Array.isArray(result?.migrations)) return;
      const migrations = [...result.migrations].sort((a, b) => Date.parse(a.createdAt || '') - Date.parse(b.createdAt || ''));
      for (const migration of migrations) {
        const mappings = migration.state === 'UNDONE' ? reverseEntityIdMappings(migration.mappings) : migration.mappings;
        applyEntityIdMappingsLocally(mappings);
      }
    } catch { /* Журнал обновится при следующем событии или входе. */ }
  };
  const onMigrated = () => { void refresh(); };
  window.addEventListener('socket:entity:ids:migrated', onMigrated);
  void refresh();
  return () => {
    active = false;
    latestRequest++;
    window.removeEventListener('socket:entity:ids:migrated', onMigrated);
  };
}
