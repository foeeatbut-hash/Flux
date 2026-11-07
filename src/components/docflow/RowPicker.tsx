import React from 'react';
import { Input } from '../ui';
import type { DocflowConfig } from '../../../shared/docflow/config';
import { same } from '../../../shared/docflow/nameMask';

export interface PickRow {
  id: string; registerId: string; registerName: string; contractorNo: string; ownerNo: string; vendorNo: string;
  titleRu: string; titleEn: string; vdrCode: string; revision: string; status: string;
}
export const cipherOfRow = (config: DocflowConfig, row: PickRow) => String((row as any)[config.masks.cipherSource] || row.contractorNo || row.ownerNo || row.vendorNo || '');

/**
 * Выбор строки реестра проекта поиском по шифру, названию и тегу. Строки, чей
 * шифр совпал с именем файла, идут сверху (docs/docflow-program.md, 3.3).
 */
export default function RowPicker({ projectId, config, cipherHint, selectedId, onPick }: { projectId: string; config: DocflowConfig; cipherHint?: string; selectedId?: string; onPick: (row: PickRow) => void }) {
  const [query, setQuery] = React.useState(cipherHint || '');
  const [rows, setRows] = React.useState<PickRow[]>([]);
  const [state, setState] = React.useState<'loading' | 'ready' | 'error'>('loading');
  React.useEffect(() => {
    let alive = true;
    setState('loading');
    const timer = window.setTimeout(() => {
      void fetch(`/api/vdr/items/search?projectId=${encodeURIComponent(projectId)}&q=${encodeURIComponent(query.trim())}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((body: { items: PickRow[] }) => { if (alive) { setRows(body.items || []); setState('ready'); } })
        .catch(() => { if (alive) setState('error'); });
    }, 200);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [projectId, query]);
  const sorted = React.useMemo(() => [...rows].sort((a, b) => Number(!!cipherHint && same(cipherOfRow(config, b), cipherHint)) - Number(!!cipherHint && same(cipherOfRow(config, a), cipherHint))), [rows, cipherHint, config]);
  return (
    <div className="space-y-2">
      <Input aria-label="Поиск строки реестра" placeholder="Шифр, название или тег" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus />
      <ul role="listbox" aria-label="Строки реестра" className="max-h-52 overflow-auto rounded border border-slate-200 dark:border-slate-700">
        {sorted.map((row) => {
          const hit = !!cipherHint && same(cipherOfRow(config, row), cipherHint);
          return (
            <li key={row.id} role="option" aria-selected={row.id === selectedId}>
              <button type="button" onClick={() => onPick(row)} className={`flex w-full items-baseline gap-2 px-2 py-1.5 text-left text-xs hover:bg-slate-100 dark:hover:bg-slate-800 ${row.id === selectedId ? 'bg-sky-50 dark:bg-sky-950/40' : ''}`}>
                <span className="font-medium">{cipherOfRow(config, row) || '—'}</span>
                <span className="min-w-0 flex-1 truncate text-slate-500 dark:text-slate-400">{row.titleRu || row.titleEn}</span>
                <span className="shrink-0 text-slate-500 dark:text-slate-400">{row.vdrCode} · ред. {row.revision}</span>
                {hit && <span className="shrink-0 rounded bg-emerald-100 px-1 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400">шифр совпал</span>}
              </button>
            </li>
          );
        })}
        {state === 'ready' && !sorted.length && <li className="px-2 py-3 text-xs text-slate-500 dark:text-slate-400">Строк не найдено.</li>}
        {state === 'loading' && !sorted.length && <li className="px-2 py-3 text-xs text-slate-500 dark:text-slate-400">Ищу…</li>}
        {state === 'error' && <li className="px-2 py-3 text-xs text-rose-600 dark:text-rose-400">Не удалось получить строки реестра.</li>}
      </ul>
    </div>
  );
}
