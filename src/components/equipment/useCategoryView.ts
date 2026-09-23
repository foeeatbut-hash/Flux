import { useCallback, useEffect, useState } from 'react';
import { parseView, settingKey, type CategoryView } from '../../lib/categoryView';

/**
 * Вид категории: чтение и запись общей или личной настройки.
 *
 * Правило «для кого вид» — прежнее, из профиля видимости: администратор в
 * режиме «для всех» пишет общий вид, остальные — свой. Своего нет — читается
 * общий: сотрудник, ещё ничего не настроивший, видит то, что настроил отдел.
 *
 * Прежде у сотрудника без прав администратора личная правка писалась, но не
 * читалась (читался общий вид, пока режим не переключён на «только для
 * меня»), и казалось, что галочка не сохраняется. Здесь личный вид читается
 * всегда, когда он есть.
 */
export function useCategoryView(categoryId: string, userId: string | undefined, personal: boolean) {
  const [view, setView] = useState<CategoryView>({});

  const load = useCallback(async () => {
    if (!categoryId) { setView({}); return; }
    try {
      const q = userId ? `?userId=${encodeURIComponent(userId)}` : '';
      const r = await fetch(`/api/settings/${encodeURIComponent(settingKey(categoryId))}${q}`);
      const d = await r.json();
      setView(parseView(personal && d.user ? d.user : d.global));
    } catch (_) { setView({}); }
  }, [categoryId, userId, personal]);

  useEffect(() => { load(); }, [load]);

  const save = useCallback(async (next: CategoryView) => {
    setView(next);
    if (!categoryId) return;
    await fetch(`/api/settings/${encodeURIComponent(settingKey(categoryId))}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: personal ? userId || null : null, value: JSON.stringify(next) }),
    }).catch(() => { /* сервер не ответил — вид останется до перезагрузки */ });
  }, [categoryId, userId, personal]);

  return { view, save, reload: load };
}
