/**
 * Привязка папки к проекту — общая для всех, кто видит проект.
 *
 * Папки проектов лежат в сетевых ресурсах, а буква диска и rootId у каждого
 * компьютера свои. Поэтому привязка хранит не rootId и не путь, а «ключ места»
 * (locationKey): sha256 от канонического сетевого пути `\\сервер\ресурс\папка`,
 * который считает main-процесс Electron. Абсолютный путь из main не выходит,
 * наружу идёт только хеш.
 */
export interface ProjectFolderBinding {
  id: string;
  /** sha256 (hex) нормализованного сетевого пути папки. */
  locationKey: string;
  projectId: string;
  /** Только имя папки: путь к ресурсу другим людям не нужен и в базу не пишется. */
  label: string;
  actorId: string;
  /** Когда привязали (ISO). */
  at: string;
}

export interface ProjectFolderBindingLedger {
  revision: number;
  bindings: ProjectFolderBinding[];
  undo: Array<{ id: string; beforeRevision: number; afterRevision: number; before: ProjectFolderBinding[]; after: ProjectFolderBinding[] }>;
}

/** Ответ GET/POST: что видит конкретный человек и вправе ли он менять привязки. */
export interface ProjectFolderBindingView {
  revision: number;
  canManage: boolean;
  bindings: ProjectFolderBinding[];
  undo: Array<{ id: string; afterRevision: number }>;
}

/** Цепочка ключей папки от неё самой через родителей до корня ресурса. */
export type LocationChain = readonly string[];

export const isLocationKey = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);

export function validateBinding(binding: ProjectFolderBinding): void {
  for (const [label, value] of Object.entries({ id: binding.id, actorId: binding.actorId, projectId: binding.projectId })) {
    if (typeof value !== 'string' || !value || value.length > 256) throw new Error(`Некорректный идентификатор ${label}`);
  }
  if (!isLocationKey(binding.locationKey)) throw new Error('Некорректный ключ места папки');
  if (typeof binding.label !== 'string' || !binding.label.trim() || binding.label.length > 255 || /[\u0000-\u001f]/u.test(binding.label)) throw new Error('Некорректное имя папки');
  if (typeof binding.at !== 'string' || Number.isNaN(Date.parse(binding.at))) throw new Error('Некорректное время привязки');
}

/** Ближайшая к файлу привязка: чем раньше ключ в цепочке, тем папка ближе к файлу. */
export function nearestBinding(bindings: readonly ProjectFolderBinding[], chain: LocationChain | null | undefined): { binding: ProjectFolderBinding; depth: number } | null {
  if (!chain?.length || !bindings.length) return null;
  const byKey = new Map<string, ProjectFolderBinding>();
  for (const binding of bindings) byKey.set(binding.locationKey, binding);
  for (let depth = 0; depth < chain.length; depth++) {
    const binding = byKey.get(chain[depth]);
    if (binding) return { binding, depth };
  }
  return null;
}

export function resolveBoundProject(bindings: readonly ProjectFolderBinding[], chain: LocationChain | null | undefined): string | null {
  return nearestBinding(bindings, chain)?.binding.projectId || null;
}

/** Ручные назначения файла имеют приоритет; наследование заполняет лишь пустое поле. */
export function effectiveProjectIds(manualProjectIds: readonly string[] | null | undefined, inheritedProjectId: string | null): string[] {
  const manual = [...new Set((manualProjectIds || []).filter(id => typeof id === 'string' && id.length > 0))];
  return manual.length ? manual : inheritedProjectId ? [inheritedProjectId] : [];
}
