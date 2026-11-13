/** Состояние раздела «Лицензии»: читается у главного процесса и перечитывается после каждого действия, меняющего реестр */
import { useCallback, useEffect, useState } from 'react';
import { call } from './api';
import type { LicensesState } from './types';

export function useLicenses() {
  const [state, setState] = useState<LicensesState | null>(null);
  const [error, setError] = useState('');
  const reload = useCallback(async () => {
    try { setState(await call<LicensesState>('licensesState')); setError(''); }
    catch (e: any) { setError(e.message); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  return { state, error, reload, setState };
}

export const displayDate = (ms: number) => new Date(ms).toLocaleDateString('ru-RU');
/** Дата окончания через N месяцев (день месяца не выходит за конец месяца) в виде YYYY-MM-DD для поля даты */
export function expiryAfter(months: number): string {
  const date = new Date(), day = date.getDate();
  date.setDate(1); date.setMonth(date.getMonth() + months);
  date.setDate(Math.min(day, new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()));
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}
