import { useEffect, useState } from 'react';

/**
 * «Карточку изменил кто-то ещё».
 *
 * Двое правят одну карточку — молча побеждает последний. Сливать правки для
 * карточек незачем (они точечные), но узнать, что данные под тобой уже другие,
 * человек обязан: иначе он сохранит поверх чужой работы, ничего не заметив.
 *
 * Своих правок не показываем: программа и так знает, что это был я, а
 * сообщение «вы изменили карточку» — шум.
 */
export interface EntityChange { kind: string; id: string; by: string; at: number }

export function useEntityChanged(kind: string, id: string | null | undefined, myUserId?: string): {
  change: EntityChange | null;
  clear: () => void;
} {
  const [change, setChange] = useState<EntityChange | null>(null);

  useEffect(() => {
    setChange(null);
    if (!id) return;
    const onChanged = (e: Event) => {
      const d = (e as CustomEvent).detail || {};
      if (d.kind !== kind || (d.id !== id && !(Array.isArray(d.ids) && d.ids.includes(id)))) return;
      if (myUserId && d.byId === myUserId) return;
      setChange({ kind: d.kind, id, by: String(d.by || ''), at: Number(d.at) || Date.now() });
    };
    window.addEventListener('socket:entity:changed', onChanged as EventListener);
    return () => window.removeEventListener('socket:entity:changed', onChanged as EventListener);
  }, [kind, id, myUserId]);

  return { change, clear: () => setChange(null) };
}
