export type ChatFilter = 'all' | 'unread' | 'groups' | 'direct';

export function passesChatFilter(filter: ChatFilter, kind: 'GROUP' | 'DIRECT', unreadCount: number): boolean {
  if (filter === 'groups' && kind !== 'GROUP') return false;
  if (filter === 'direct' && kind !== 'DIRECT') return false;
  return filter !== 'unread' || unreadCount > 0;
}

export function employeeMatchesQuery(person: {
  name: string; symbol: string; role: string;
  department?: string; title?: string; position?: string;
}, query: string): boolean {
  const normalized = String(query || '').trim().toLocaleLowerCase('ru-RU');
  if (!normalized) return true;
  return [person.name, person.symbol, person.role, person.department, person.title, person.position]
    .some((value) => String(value || '').toLocaleLowerCase('ru-RU').includes(normalized));
}
