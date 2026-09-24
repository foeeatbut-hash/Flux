import React, { useMemo, useState } from 'react';
import { Plus, Search, Tag as TagIcon, X } from 'lucide-react';
import { useEscapeClose } from '../../lib/useDismiss';
import { useTagCheck, tagHint, tagPrefixOf } from './useTagCheck';

/**
 * Привязать тег к позиции: найти в реестре или завести новый.
 *
 * Уехало из `screens/Equipment.tsx` и получило «Создать и привязать»: раньше
 * тег, которого ещё нет в реестре, приходилось сначала заводить в разделе
 * «Теги», потом возвращаться сюда и искать его. Теперь набранное написание
 * проверяется на лету тем же правилом, по которому запишется (код проекта,
 * похожие буквы, занятость), и заводится одной кнопкой.
 *
 * Поиск пустой — в поле подставлена приставка от тега родителя
 * («3700-B01-»): человеку остаётся дописать код оборудования и номер.
 */

export interface PickerTag {
  id: string; identifier: string; department?: string; metadata?: string;
  componentElements?: { id: string; name: string; itemCode: string }[];
}

interface Props {
  projectId: string;
  tags: PickerTag[];
  currentComponentId: string;
  /** Тег родителя позиции — от него берётся приставка нового тега */
  parentTag?: string;
  onPick: (tagId: string) => void;
  /** Завести по написанию и привязать; вернуть текст ошибки или пусто */
  onCreate: (identifier: string) => Promise<string>;
  onClose: () => void;
}

const tagName = (t: PickerTag): string => {
  try { return t.metadata ? (JSON.parse(t.metadata).mainName || '') : ''; } catch { return ''; }
};

export default function TagPickerModal({ projectId, tags, currentComponentId, parentTag, onPick, onCreate, onClose }: Props) {
  useEscapeClose(true, onClose);
  const [query, setQuery] = useState(() => tagPrefixOf(parentTag || ''));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const check = useTagCheck(projectId, query);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? tags.filter(t =>
          t.identifier.toLowerCase().includes(q) ||
          (t.department || '').toLowerCase().includes(q) ||
          tagName(t).toLowerCase().includes(q))
      : tags;
    // Свободные теги сверху, занятые — в конце списка
    return [...list].sort((a, b) => {
      const aBusy = (a.componentElements?.length || 0) > 0 ? 1 : 0;
      const bBusy = (b.componentElements?.length || 0) > 0 ? 1 : 0;
      if (aBusy !== bBusy) return aBusy - bBusy;
      return a.identifier.localeCompare(b.identifier, 'ru');
    });
  }, [tags, query]);

  // «Создать» предлагается, только когда такого тега в реестре нет: иначе
  // его надо выбрать из списка, а не заводить второй
  const canCreate = check.state === 'ok' && !check.existing;

  const create = async () => {
    setBusy(true);
    setError('');
    const why = await onCreate(query.trim());
    setBusy(false);
    if (why) setError(why);
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 fx-backdrop" onClick={onClose}>
      <div className="fx-dialog w-full max-w-lg p-5" onClick={e => e.stopPropagation()}
        role="dialog" aria-label="Привязать тег">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold">Привязать тег</h3>
          <button type="button" title="Закрыть" onClick={onClose} className="p-1 text-slate-400 hover:text-rose-500 cursor-pointer"><X className="w-5 h-5" /></button>
        </div>
        <div className="relative mb-1">
          <Search className="w-4 h-4 absolute left-2.5 top-2.5 text-slate-400" />
          <input
            autoFocus
            type="search"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setError(''); }}
            onKeyDown={(e) => { if (e.key === 'Enter' && canCreate && !filtered.length) create(); }}
            placeholder="Поиск или новый тег: 3700-B01-TE-001"
            className="w-full pl-8 pr-3 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-xs focus:outline-none focus:border-emerald-500 text-slate-800 dark:text-slate-100"
          />
        </div>
        <div className={`min-h-[18px] text-2xs mb-2 ${check.state === 'bad' || error ? 'text-rose-600 dark:text-rose-400' : check.corrected ? 'text-amber-600 dark:text-amber-400' : 'text-slate-400'}`}>
          {error || tagHint(check)}
        </div>
        {canCreate && (
          <button type="button" onClick={create} disabled={busy}
            className="w-full mb-2 flex items-center gap-2 px-3 py-2 rounded-lg text-left text-xs border border-dashed border-emerald-400 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-950/30 cursor-pointer disabled:opacity-50">
            <Plus className="w-3.5 h-3.5 shrink-0" />
            {busy ? 'Завожу…' : <>Создать «<b className="font-mono">{check.identifier}</b>» и привязать</>}
          </button>
        )}
        <p className="text-2xs text-slate-400 mb-2">Один тег — одно изделие: занятые теги показаны серым, сначала отвяжите их на текущем месте.</p>
        <div className="max-h-80 overflow-y-auto space-y-1">
          {tags.length === 0 ? (
            <p className="text-xs text-slate-400">В проекте пока нет тегов — наберите новый тег выше.</p>
          ) : filtered.length === 0 ? (
            <p className="text-xs text-slate-400 text-center py-4">В реестре нет «{query}».</p>
          ) : filtered.map(t => {
            const holder = (t.componentElements || []).find(c => c.id !== currentComponentId);
            const linkedHere = (t.componentElements || []).some(c => c.id === currentComponentId);
            const taken = !!holder || linkedHere;
            const name = tagName(t);
            return (
              <button type="button"
                key={t.id}
                disabled={taken}
                onClick={() => onPick(t.id)}
                title={linkedHere ? 'Уже привязан к этому изделию' : holder ? `Занят: ${holder.name || holder.itemCode}` : 'Привязать'}
                className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left text-xs ${taken
                  ? 'opacity-45 cursor-not-allowed'
                  : 'hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer'}`}
              >
                <TagIcon className={`w-3.5 h-3.5 shrink-0 ${taken ? 'text-slate-400' : 'text-emerald-500'}`} />
                <span className="font-mono font-medium shrink-0">{t.identifier}</span>
                {name && <span className="text-slate-400 truncate">{name}</span>}
                <span className="ml-auto flex items-center gap-1.5 shrink-0">
                  {t.department && <span className="text-2xs text-slate-400">{t.department}</span>}
                  {linkedHere && <span className="text-xs font-medium px-1.5 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-950/50 text-emerald-600">привязан</span>}
                  {holder && <span className="text-xs font-medium px-1.5 py-0.5 rounded-full bg-slate-200 dark:bg-slate-800 text-slate-500" title={`Занят: ${holder.name || holder.itemCode}`}>занят · {holder.name || holder.itemCode}</span>}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
