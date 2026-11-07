import React, { useEffect, useState } from 'react';
import { newRequestId } from '../../../feedback/contracts';
import { routeModuleReport, setModuleKnown } from '../../feedback/feedbackApi';
import type { Card } from './FeedbackCard';

/** Ревизия защищает карточку от перезаписи параллельных изменений. */
export default function ModuleFeedbackActions({ card, onChanged }: { card: Card; onChanged: () => Promise<void> }) {
  const [reason, setReason] = useState('');
  const [workaround, setWorkaround] = useState(card.moduleWorkaround || '');
  const [known, setKnown] = useState(!!card.moduleKnown);
  const [routing, setRouting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { setKnown(!!card.moduleKnown); setWorkaround(card.moduleWorkaround || ''); setRouting(false); setReason(''); }, [card.id, card.revision]);
  const save = async (kind: 'routing' | 'known') => {
    if (kind === 'routing' && !reason.trim()) { setError('Объясните, почему проблема относится к Flux'); return; }
    setBusy(true); setError('');
    try {
      const base = { clientRequestId: newRequestId(), expectedRevision: card.revision };
      if (kind === 'routing') await routeModuleReport(card.id, { ...base, toFlux: true, reason: reason.trim() });
      else await setModuleKnown(card.id, { ...base, known, workaround: workaround.trim() });
      await onChanged();
    } catch (e: any) { setError(e?.message || 'Не удалось сохранить'); }
    finally { setBusy(false); }
  };
  return <div className="space-y-2 border-t border-slate-200 dark:border-slate-800 pt-3 text-xs text-slate-700 dark:text-slate-300">
    <label className="flex items-center gap-2"><input type="checkbox" checked={known} onChange={(e) => setKnown(e.target.checked)} /> Известная проблема</label>
    {known && <label className="block">Обход
      <textarea aria-label="Обход" value={workaround} onChange={(e) => setWorkaround(e.target.value)} rows={2}
        className="mt-1 w-full rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-2 text-slate-800 dark:text-slate-100" />
    </label>}
    <button type="button" className="fx-btn" disabled={busy} onClick={() => void save('known')}>Сохранить известную проблему</button>
    {!card.moduleForwarded && (routing ? <div className="space-y-2">
      <label className="block">Почему это ошибка Flux
        <textarea aria-label="Почему это ошибка Flux" value={reason} onChange={(e) => setReason(e.target.value)} rows={2}
          className="mt-1 w-full rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-2 text-slate-800 dark:text-slate-100" />
      </label>
      <button type="button" className="fx-btn" disabled={busy} onClick={() => void save('routing')}>Передать команде Flux</button>
      <button type="button" className="fx-btn ml-2" onClick={() => setRouting(false)}>Отмена</button>
    </div> : <div><button type="button" className="fx-btn" onClick={() => setRouting(true)}>Это ошибка Flux</button></div>)}
    {error && <p className="text-rose-600 dark:text-rose-400">{error}</p>}
  </div>;
}
