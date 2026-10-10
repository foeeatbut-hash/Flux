import { useEffect, useRef, useState } from 'react';
import { ENV_CONFIG } from '../../config/env';
import { applyEntityIdMappingsLocally, reverseEntityIdMappings, type EntityIdMapping } from '../../lib/entityIdLocalMigration';

interface MigrationPlan {
  planToken: string;
  migrationId?: string;
  mappings: EntityIdMapping[];
  counts: Record<string, number>;
  blockers: Array<{ code: string; message: string; projectId?: string; details?: unknown }>;
}

const countLabels: Record<string, string> = {
  projects: 'Проекты', equipmentSystems: 'Установки', monoblocks: 'Моноблоки',
  componentElements: 'Позиции оборудования', tags: 'Теги', dictionaries: 'Справочники',
  dictionaryItems: 'Элементы справочников', scalarReferences: 'Ссылки в полях', jsonReferences: 'Ссылки в данных',
};

const modelLabels: Record<string, string> = {
  Project: 'Проект', project: 'Проект', EquipmentSystem: 'Установка', equipmentSystem: 'Установка', System: 'Установка',
  Monoblock: 'Моноблок', monoblock: 'Моноблок', ComponentElement: 'Позиция оборудования', componentElement: 'Позиция оборудования',
  Component: 'Позиция оборудования', component: 'Позиция оборудования', Tag: 'Тег', tag: 'Тег',
  Dictionary: 'Справочник', dictionary: 'Справочник', DictionaryItem: 'Элемент справочника', dictionaryItem: 'Элемент справочника', Field: 'Элемент справочника',
};

interface MigrationHistoryRow {
  migrationId: string;
  state: 'APPLIED' | 'UNDONE';
  undoAvailable: boolean;
  createdAt?: string;
  mappings: EntityIdMapping[];
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${ENV_CONFIG.apiUrl}/settings/entity-id-migration${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.message || body?.error || 'Не удалось выполнить перенос идентификаторов.');
  return body as T;
}

export default function EntityIdMigrationPanel() {
  const [plan, setPlan] = useState<MigrationPlan | null>(null);
  const [migrationId, setMigrationId] = useState('');
  const [appliedMappings, setAppliedMappings] = useState<EntityIdMapping[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [undoAvailable, setUndoAvailable] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const historyRequestId = useRef(0);

  useEffect(() => {
    let current = true;
    const requestId = ++historyRequestId.current;
    void request<{ migrations?: MigrationHistoryRow[] }>('/history').then((result) => {
      const latestApplied = [...(result.migrations || [])]
        .sort((a, b) => Date.parse(b.createdAt || '') - Date.parse(a.createdAt || ''))
        .find((row) => row.state === 'APPLIED' && row.undoAvailable);
      if (!current || requestId !== historyRequestId.current || !latestApplied) return;
      setMigrationId(latestApplied.migrationId); setAppliedMappings(latestApplied.mappings || []); setUndoAvailable(true);
    }).catch(() => {});
    return () => { current = false; };
  }, []);

  const preview = async () => {
    setBusy(true); setError(''); setStatus(''); setConfirmed(false); setPlan(null);
    try { setPlan(await request<MigrationPlan>('/preview', { method: 'POST', body: '{}' })); }
    catch (e) { setError(e instanceof Error ? e.message : 'Не удалось подготовить сопоставление.'); }
    finally { setBusy(false); }
  };

  const download = () => {
    if (!plan) return;
    const blob = new Blob([JSON.stringify({ counts: plan.counts, blockers: plan.blockers, mappings: plan.mappings }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = `flux-entity-id-mapping-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click(); URL.revokeObjectURL(url);
  };

  const apply = async () => {
    if (!plan || !confirmed || plan.blockers.length) return;
    historyRequestId.current++;
    setBusy(true); setError(''); setStatus('');
    try {
      const result = await request<{ migrationId: string; mappings: EntityIdMapping[]; counts?: Record<string, number>; undoAvailable: boolean }>('/apply', { method: 'POST', body: JSON.stringify({ planToken: plan.planToken }) });
      setMigrationId(result.migrationId); setAppliedMappings(result.mappings); setUndoAvailable(result.undoAvailable);
      const local = applyEntityIdMappingsLocally(result.mappings);
      setStatus(local.warnings.length ? `Перенос применён. ${local.warnings.join(' ')}` : 'Перенос применён. Локальные связи с файлами сохранены.'); setPlan(null); setConfirmed(false);
    } catch (e) { setError(e instanceof Error ? e.message : 'Перенос не выполнен.'); }
    finally { setBusy(false); }
  };

  const undo = async () => {
    if (!migrationId || !undoAvailable) return;
    historyRequestId.current++;
    setBusy(true); setError(''); setStatus('');
    try {
      await request(`/undo`, { method: 'POST', body: JSON.stringify({ migrationId }) });
      const local = applyEntityIdMappingsLocally(reverseEntityIdMappings(appliedMappings));
      setUndoAvailable(false); setStatus(local.warnings.length ? `Перенос отменён. ${local.warnings.join(' ')}` : 'Перенос отменён.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось отменить перенос.'); }
    finally { setBusy(false); }
  };

  return <section className="border-t border-slate-200 dark:border-slate-800 pt-4 space-y-3">
    <div>
      <h3 className="text-sm font-semibold">Связи проекта и оборудования</h3>
      <p className="fx-hint mt-1 max-w-2xl">Проект получает постоянный номер, например «PRJ-000014»; установки, позиции и теги получают номер с его префиксом. Проверьте сопоставление перед применением. Названия останутся прежними; связи, сохранённые в E3, потребуют отдельной проверки.</p>
    </div>
    <div className="flex flex-wrap gap-2">
      <button type="button" className="fx-btn" disabled={busy} onClick={() => void preview()}>{busy && !plan ? 'Подготовка…' : 'Проверить сопоставление'}</button>
      {plan && <button type="button" className="fx-btn fx-btn-quiet" disabled={busy} onClick={download}>Скачать сопоставление</button>}
      {undoAvailable && <button type="button" className="fx-btn fx-btn-danger" disabled={busy} onClick={() => void undo()}>Отменить перенос</button>}
    </div>

    {plan && <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-5 gap-y-1 text-xs">
        {Object.entries(plan.counts || {}).map(([key, count]) => <div key={key} className="flex justify-between gap-3 border-b border-slate-100 dark:border-slate-800 py-1"><span className="text-slate-600 dark:text-slate-400">{countLabels[key] || key}</span><strong className="tabular-nums">{count}</strong></div>)}
      </div>
      {plan.blockers.length > 0 && <div className="fx-error space-y-1" role="alert"><p className="font-semibold">Сейчас переносить нельзя:</p>{plan.blockers.map((blocker, index) => <p key={`${blocker.code}-${index}`}>{blocker.message}{blocker.projectId ? ` (${blocker.projectId})` : ''}</p>)}</div>}
      <div className="max-h-[min(55vh,28rem)] overflow-auto border border-slate-200 dark:border-slate-700 rounded-md">
        <table className="hidden sm:table w-full text-xs text-left">
          <thead className="sticky top-0 bg-slate-50 dark:bg-slate-900"><tr><th className="p-2">Запись</th><th className="p-2">Прежний номер</th><th className="p-2">Новый номер</th></tr></thead>
          <tbody>{plan.mappings.map((row, index) => <tr key={`${row.model}:${row.oldId}:${index}`} className="border-t border-slate-100 dark:border-slate-800"><td className="p-2">{modelLabels[row.model] || row.model}</td><td className="p-2 font-mono break-all">{row.oldId}</td><td className="p-2 font-mono break-all">{row.newId}</td></tr>)}</tbody>
        </table>
        <div className="sm:hidden divide-y divide-slate-100 dark:divide-slate-800">{plan.mappings.map((row, index) => <article key={`${row.model}:${row.oldId}:${index}`} className="p-2.5 space-y-1.5 text-xs">
          <p className="font-medium">{modelLabels[row.model] || row.model}</p>
          <p><span className="text-slate-500 dark:text-slate-400">Прежний номер</span><br /><code className="font-mono break-all">{row.oldId}</code></p>
          <p><span className="text-slate-500 dark:text-slate-400">Новый номер</span><br /><code className="font-mono break-all">{row.newId}</code></p>
        </article>)}</div>
        {!plan.mappings.length && <p className="p-3 text-xs text-slate-500">Изменять номера не требуется.</p>}
      </div>
      <label className="flex items-start gap-2 text-xs text-slate-700 dark:text-slate-300">
        <input type="checkbox" checked={confirmed} disabled={busy || plan.blockers.length > 0} onChange={(event) => setConfirmed(event.target.checked)} className="mt-0.5" />
        <span>Я проверил количество записей и сопоставление прежних и новых номеров.</span>
      </label>
      <button type="button" className="fx-btn fx-btn-danger-fill disabled:opacity-40 disabled:cursor-not-allowed" disabled={busy || !confirmed || plan.blockers.length > 0 || !plan.mappings.length} onClick={() => void apply()}>{busy ? 'Перенос…' : 'Применить перенос'}</button>
    </div>}
    {error && <p role="alert" className="fx-error">{error}</p>}
    {status && <p role="status" className="fx-hint">{status}</p>}
  </section>;
}
