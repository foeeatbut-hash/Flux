import { PLAY_ENTITLEMENTS } from '../../play/features';
import { FEATURES, OPEN_BY_DEFAULT, type PermMap } from './permissions';

/** Карточка сотрудника сохраняет рабочие и игровые права по разным правилам. */
export function cleanUserPermissions(draft: PermMap): PermMap {
  const result: PermMap = {};
  for (const f of FEATURES) {
    const entry = draft[f.id];
    if (entry?.enabled) result[f.id] = { enabled: true, until: entry.until ?? null };
    // Право, открытое по умолчанию, запрещается только явной записью: выброси
    // её — и снятая в карточке галочка ничего бы не запретила
    else if (entry && OPEN_BY_DEFAULT.includes(f.id)) result[f.id] = { enabled: false, until: null };
  }
  for (const f of PLAY_ENTITLEMENTS) {
    const entry = draft[f.id];
    if (entry) result[f.id] = {
      enabled: entry.enabled,
      until: entry.until ?? null,
      mode: entry.mode ?? (entry.enabled ? 'ALLOW' : 'DENY'),
    };
  }
  return result;
}
