// Выпуск раньше входил в «вести ВДР»: при разделении прав он не должен
// пропасть у уже работающих сотрудников. Назначение файлов — новое право.
export const DOCFLOW_PERMISSION_ALIASES: Record<string, string> = {
  'docflow.edit': 'vdr.manage',
  'docflow.issue': 'vdr.manage',
  'docflow.settings': 'vdr.standards',
  'docflow.delete': 'vdr.delete',
};

export function translatedDocflowPermissions<T>(source: Record<string, T>): Record<string, T> {
  const result = { ...source };
  for (const [current, legacy] of Object.entries(DOCFLOW_PERMISSION_ALIASES)) {
    if (!(current in result) && legacy in result) result[current] = result[legacy];
  }
  for (const legacy of new Set(Object.values(DOCFLOW_PERMISSION_ALIASES))) delete result[legacy];
  return result;
}
