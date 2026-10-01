import React, { useEffect, useState } from 'react';
import FeedbackIncidentSummary from './FeedbackIncidentSummary';
import type { AutomaticIncident } from '../../../diagnostics/automatic';
import { Btn } from '../ui';

type Item = AutomaticIncident & { ownerId: string | null; origin: string };
export default function AutomaticIncidentsCard() {
  const [items, setItems] = useState<Item[]>([]);
  const [triage, setTriage] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [limited, setLimited] = useState(false);
  const load = async () => {
    try {
      const r = await fetch('/api/feedback/automatic-incidents'); const body = await r.json();
      if (!r.ok) throw new Error(body.error?.message || 'Не удалось прочитать список');
      setItems(body.data.items); setTriage(body.data.triage); setLimited(body.data.limited); setError('');
    } catch (e: any) { setError(e.message); }
  };
  useEffect(() => { void load(); const timer = setInterval(() => { void load(); }, 60000); return () => clearInterval(timer); }, []);
  const resolve = async (item: Item) => {
    setBusy(true);
    try {
      const r = await fetch(`/api/feedback/automatic-incidents/${encodeURIComponent(item.id)}/resolve`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ownerId: item.ownerId }) });
      if (!r.ok) { const body = await r.json(); throw new Error(body.error?.message || 'Не удалось изменить состояние'); }
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };
  const active = items.filter(i => !i.resolvedAt);
  return <div className="fx-set-group space-y-2">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="text-xs font-medium text-slate-800 dark:text-slate-150">Автоматически найденные проблемы · {active.length}</div>
      <Btn size="sm" tone="ghost" onClick={load}>Обновить</Btn>
    </div>
    <p className="text-xs text-slate-600 dark:text-slate-400">Анализ технического журнала раз в минуту, без отправки обращения. Повторные ошибки объединяются; отмена, конфликты и ожидаемые ответы 4xx исключаются. Новый сбой снова открывает отмеченную проблему.</p>
    {error && <p role="alert" className="text-xs text-rose-600 dark:text-rose-400">{error}</p>}
    {!error && !active.length && <p className="text-xs text-slate-500">В сохранённых технических событиях проблем не обнаружено. Это не гарантирует отсутствие ошибок вне журнала.</p>}
    {limited && <p className="text-xs text-amber-600 dark:text-amber-400">Показаны последние 100 источников.</p>}
    {active.slice(0, 20).map(item => <div key={`${item.ownerId}:${item.fingerprint}`} className="space-y-1">
      <div className="flex flex-wrap items-center justify-between gap-2 text-2xs text-slate-500">
        <span>{item.origin} · {new Date(item.lastAt).toLocaleString('ru-RU')}</span>
        {triage && <Btn size="sm" tone="ghost" disabled={busy} onClick={() => resolve(item)}>Проверено</Btn>}
      </div>
      <FeedbackIncidentSummary incidents={[item]} />
    </div>)}
    {active.length > 20 && <p className="text-xs text-slate-500">Показаны последние 20 из {active.length} проблем.</p>}
  </div>;
}
