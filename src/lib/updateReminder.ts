/**
 * Когда напоминать об обновлении, которое сотрудник отложил кнопкой «Позже».
 *
 * Решение руководителя (владелец не подтверждал): после «Позже» напоминание приходит при следующем
 * запуске Flux и не чаще раза в сутки в работающей программе. Обязательное обновление отложить
 * нельзя, поэтому записи об откладывании у него не бывает.
 *
 * Без React и сети: правило проверяется скриптом (scripts/test-update-assign-client.ts).
 */

export const REMINDER_DAY_MS = 24 * 3600000;

/** Что человек отложил: выпуск, когда и в каком запуске программы */
export interface Postponed { version: string; at: number; session: string }

/**
 * `launch` — напоминание сразу после нового запуска (сервер пропустит его мимо суточного предела),
 * `daily` — обычное суточное, `none` — пока молчим.
 */
export function reminderPlan(o: { now: number; lastShown: number; postponed: Postponed | null; session: string; version: string }): 'none' | 'daily' | 'launch' {
  const record = o.postponed && o.postponed.version === o.version ? o.postponed : null;
  if (record && record.session !== o.session) return 'launch';
  if (o.now - o.lastShown < REMINDER_DAY_MS) return 'none';
  if (record && o.now - record.at < REMINDER_DAY_MS) return 'none';
  return 'daily';
}

const keyOf = (userId: string) => `flux.update.postponed.${userId}`;

/** Прочитать отложенное: повреждённая запись и недоступное хранилище не мешают, считаются «не откладывал» */
export function readPostponed(userId: string, storage: Pick<Storage, 'getItem'> | null = typeof localStorage === 'undefined' ? null : localStorage): Postponed | null {
  try {
    const r = JSON.parse(storage?.getItem(keyOf(userId)) || 'null');
    return r && typeof r.version === 'string' && Number.isFinite(r.at) && typeof r.session === 'string' ? r : null;
  } catch { return null; }
}

export function writePostponed(userId: string, value: Postponed | null, storage: Pick<Storage, 'setItem' | 'removeItem'> | null = typeof localStorage === 'undefined' ? null : localStorage): void {
  try { if (value) storage?.setItem(keyOf(userId), JSON.stringify(value)); else storage?.removeItem(keyOf(userId)); } catch { /* память таймера продолжает действовать */ }
}
