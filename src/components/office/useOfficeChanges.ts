import { useCallback, useEffect, useRef, useState } from 'react';
import type { OfficeChangesResult } from '../../../office/changes';
import { officeDataApi, type OfficeFileSource } from './fluxData';

/** Документ записал заполнение: полоса «данные устарели» и панель изменений проверяют его заново */
export const OFFICE_APPLIED_EVENT = 'flux-office-applied';

/**
 * Что в документе устарело относительно данных проекта.
 *
 * Спрашивает сервер (он читает сохранённые байты файла и источники) при
 * открытии, при возвращении в окно, раз в минуту и после каждого заполнения —
 * человеку не нужно ничего нажимать, чтобы узнать, что данные в документе
 * уже не те. Ошибка проверки не мешает работе: полосы просто нет.
 */
export function useOfficeChanges(source: OfficeFileSource | null, enabled = true, intervalMs = 60_000) {
  const [result, setResult] = useState<OfficeChangesResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const live = useRef({ source, enabled });
  live.current = { source, enabled };
  const seq = useRef(0);
  const sourceKey = typeof source === 'string' ? source : source ? 'local' : '';

  const check = useCallback(async () => {
    const { source: current, enabled: on } = live.current;
    if (!current || !on) return null;
    const mine = ++seq.current;
    setLoading(true);
    try {
      const next = await officeDataApi.changes(current);
      if (mine !== seq.current) return null;
      setResult(next); setError('');
      return next;
    } catch (reason: any) {
      if (mine === seq.current) setError(String(reason?.message || reason));
      return null;
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!sourceKey || !enabled) return;
    setResult(null);
    void check();
    const timer = window.setInterval(() => { if (!document.hidden) void check(); }, intervalMs);
    const onFocus = () => void check();
    const onApplied = () => void check();
    window.addEventListener('focus', onFocus);
    window.addEventListener(OFFICE_APPLIED_EVENT, onApplied);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', onFocus); window.removeEventListener(OFFICE_APPLIED_EVENT, onApplied); seq.current++; };
  }, [sourceKey, enabled, intervalMs, check]);

  return { result, loading, error, check };
}
