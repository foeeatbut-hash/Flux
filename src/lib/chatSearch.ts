/**
 * Поиск по собеседникам и группам в Мессенджере.
 *
 * Одной строкой ищутся и люди, и группы: раньше поиск групп не касался вовсе,
 * и при десятке групп список приходилось перебирать глазами. Правило простое,
 * но у него есть правильный ответ — значит, ему место здесь, а не в разметке.
 */

export interface PersonLike { id: string; name: string; symbol: string; role?: string }
export interface GroupLike { id: string; name?: string; description?: string }

/** Себя в списке собеседников нет: писать самому себе некуда */
export function matchUsers<T extends PersonLike>(list: T[], meId: string | undefined, query: string): T[] {
  const q = String(query || '').trim().toLowerCase();
  return list.filter((u) => {
    if (u.id === meId) return false;
    // Сервисные учётные записи (Flux Guide) — отправители сообщений,
    // а не собеседники: в реестр сотрудников их не показываем
    if (u.role === 'SERVICE') return false;
    if (!q) return true;
    return u.name.toLowerCase().includes(q) || u.symbol.toLowerCase().includes(q);
  });
}

/** Группа находится и по названию, и по описанию: название бывает коротким */
export function matchGroups<T extends GroupLike>(list: T[], query: string): T[] {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return list;
  return list.filter((g) => (g.name || '').toLowerCase().includes(q)
    || (g.description || '').toLowerCase().includes(q));
}
