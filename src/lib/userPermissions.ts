import { FEATURES, ADMIN_FEATURES, OPEN_BY_DEFAULT, type PermMap } from './permissions';

/** Карточка сотрудника сохраняет рабочие права. */
export function cleanUserPermissions(draft: PermMap): PermMap {
  const result: PermMap = {};
  for (const f of [...FEATURES, ...ADMIN_FEATURES]) {
    const entry = draft[f.id];
    if (entry?.enabled) result[f.id] = { enabled: true, until: entry.until ?? null };
    // Право, открытое по умолчанию, запрещается только явной записью: выброси
    // её — и снятая в карточке галочка ничего бы не запретила
    else if (entry && OPEN_BY_DEFAULT.includes(f.id)) result[f.id] = { enabled: false, until: null };
  }
  return result;
}
