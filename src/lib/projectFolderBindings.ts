/** Привязки каталога к проекту. В путь попадает только относительная часть корня. */
export interface ProjectFolderBinding {
  id: string;
  actorId: string;
  deviceId: string;
  rootId: string;
  canonicalFolderId: string;
  relativePath: string;
  projectId: string;
}

export interface ProjectFolderBindingLedger {
  revision: number;
  bindings: ProjectFolderBinding[];
  undo: Array<{ id: string; beforeRevision: number; afterRevision: number; before: ProjectFolderBinding[]; after: ProjectFolderBinding[] }>;
}

export interface ProjectIdentity {
  rootId: string;
  canonicalFileId: string;
  relativePath: string;
}

const cleanPath = (value: string) => value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');

export function normalizedBindingPath(value: string): string {
  return cleanPath(value).split('/').filter(Boolean).join('/').toLocaleLowerCase('en-US');
}

export function isSafeBindingPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 4096) return false;
  const path = cleanPath(value);
  if (path.startsWith('/') || /^[a-z]:/i.test(path) || path.includes('\0')) return false;
  return path.split('/').every(part => part !== '..' && part !== '.');
}

export function validateBinding(binding: ProjectFolderBinding): void {
  for (const [label, value] of Object.entries({ id: binding.id, actorId: binding.actorId, deviceId: binding.deviceId, rootId: binding.rootId, canonicalFolderId: binding.canonicalFolderId, projectId: binding.projectId })) {
    if (!value || value.length > 256) throw new Error(`Некорректный идентификатор ${label}`);
  }
  if (!isSafeBindingPath(binding.relativePath)) throw new Error('Некорректный относительный путь папки');
}

/** Привязка действует в границах одного компонента пути и выбирается по ближайшей папке. */
export function resolveBoundProject(bindings: readonly ProjectFolderBinding[], file: ProjectIdentity): string | null {
  const path = cleanPath(file.relativePath).toLocaleLowerCase('en-US');
  let nearest: ProjectFolderBinding | null = null;
  for (const binding of bindings) {
    if (binding.rootId !== file.rootId || !isSafeBindingPath(binding.relativePath)) continue;
    const boundary = cleanPath(binding.relativePath).toLocaleLowerCase('en-US');
    const covers = boundary === '' || path === boundary || path.startsWith(`${boundary}/`);
    if (!covers) continue;
    if (!nearest || cleanPath(binding.relativePath).length > cleanPath(nearest.relativePath).length) nearest = binding;
  }
  return nearest?.projectId || null;
}

/** Ручные назначения файла имеют приоритет; наследование заполняет лишь пустое поле. */
export function effectiveProjectIds(manualProjectIds: readonly string[] | null | undefined, inheritedProjectId: string | null): string[] {
  const manual = [...new Set((manualProjectIds || []).filter(id => typeof id === 'string' && id.length > 0))];
  return manual.length ? manual : inheritedProjectId ? [inheritedProjectId] : [];
}

/** Перенос канонической identity обновляет якорь; старый путь сам по себе не переносит привязку. */
export function reanchorBinding(binding: ProjectFolderBinding, identity: ProjectIdentity): ProjectFolderBinding {
  if (binding.rootId !== identity.rootId || binding.canonicalFolderId !== identity.canonicalFileId) return binding;
  if (!isSafeBindingPath(identity.relativePath)) throw new Error('Некорректный новый путь папки');
  return { ...binding, relativePath: cleanPath(identity.relativePath) };
}
