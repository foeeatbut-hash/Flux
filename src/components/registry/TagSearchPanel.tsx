import React, { useState, useEffect, useRef, useMemo } from 'react';
import { parseTagMetadata, getTagOverallStatus, statusConfig } from './tagMeta';

// Панель универсального поиска. Отдельный memo-компонент: ввод текста
// перерисовывает только эту панель, а не весь холст с карточками —
// иначе на больших проектах поиск «залагивал» при каждом символе.
interface TagSearchPanelProps {
  tags: any[];
  selectedTagIds: Set<string>;
  activeTab: string;
  onQueryChange: (q: string) => void;          // дебаунс — для фильтра таблицы/дерева
  onToggleSelect: (tagId: string) => void;
  onOpenResult: (tagId: string) => void;       // клик по строке: выделить и показать
  onShowSelected: () => void;
  onClearSelection: () => void;
}

const TagSearchPanel = React.memo(function TagSearchPanel({
  tags, selectedTagIds, activeTab, onQueryChange, onToggleSelect, onOpenResult, onShowSelected, onClearSelection
}: TagSearchPanelProps) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [onlyDuplicates, setOnlyDuplicates] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Дебаунс наружу: фильтр таблицы/дерева обновляется после паузы в наборе
  const handleInput = (val: string) => {
    setQuery(val);
    setOpen(true);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => onQueryChange(val), 300);
  };

  useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current); }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const duplicateCodes = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const t of tags) {
      const code = (t.identifier || '').trim();
      if (code) counts[code] = (counts[code] || 0) + 1;
    }
    return new Set(Object.keys(counts).filter(c => counts[c] > 1));
  }, [tags]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const dupMode = onlyDuplicates || q === 'дубли' || q === 'дубликаты';
    if (!q && !dupMode) return [];
    let list = tags;
    if (dupMode) list = list.filter(t => duplicateCodes.has((t.identifier || '').trim()));
    const qq = (q === 'дубли' || q === 'дубликаты') ? '' : q;
    if (qq) {
      list = list.filter(t => {
        const meta = parseTagMetadata(t);
        return (t.identifier || '').toLowerCase().includes(qq) ||
          (meta.mainName || '').toLowerCase().includes(qq) ||
          (t.brand || '').toLowerCase().includes(qq) ||
          (t.department || '').toLowerCase().includes(qq) ||
          (t.fluid || '').toLowerCase().includes(qq);
      });
    }
    return list.slice(0, 60);
  }, [tags, query, onlyDuplicates, duplicateCodes]);

  return (
    <div ref={boxRef} className="text-left relative">
      <div className="relative">
        <input
          type="search"
          placeholder="Поиск: тег, название, марка…"
          aria-label="Поиск по разделу"
          value={query}
          onChange={(e) => handleInput(e.target.value)}
          onFocus={() => setOpen(true)}
          className="fx-input"
        />
      </div>

      {open && (query.trim() || onlyDuplicates) && (
        <div className="fx-pop absolute top-full right-0 mt-1 w-[min(94vw,420px)] z-[60] overflow-hidden">
          <div className="px-3 py-2 border-b border-slate-100 dark:border-slate-850 flex items-center justify-between gap-2">
            <span className="text-xs text-slate-400">
              Найдено: {results.length}
            </span>
            <label className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={onlyDuplicates}
                onChange={(e) => setOnlyDuplicates(e.target.checked)}
                className="accent-rose-500"
              />
              Только дубли
            </label>
          </div>
          <div className="max-h-72 overflow-y-auto p-1.5 space-y-0.5">
            {results.length === 0 ? (
              <div className="text-center text-xs text-slate-400 py-5">Ничего не найдено</div>
            ) : results.map(t => {
              const meta = parseTagMetadata(t);
              const st = statusConfig[getTagOverallStatus(t)] || statusConfig.draft;
              const dup = duplicateCodes.has((t.identifier || '').trim());
              const checked = selectedTagIds.has(t.id);
              return (
                <div
                  key={t.id}
                  className={`flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-900 cursor-pointer ${checked ? 'bg-emerald-50 dark:bg-emerald-950/30' : ''}`}
                  onClick={() => {
                    onOpenResult(t.id);
                    setOpen(false);
                  }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => {
                      e.stopPropagation();
                      onToggleSelect(t.id);
                    }}
                    className="accent-emerald-500 shrink-0"
                    title="Отметить для мультивыбора"
                  />
                  <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${st.text} bg-current`} title={`Актуальность: ${st.label}`} />
                  <span className="font-mono font-medium text-xs text-emerald-700 dark:text-emerald-400 truncate">{t.identifier}</span>
                  {dup && (
                    <span className="shrink-0 text-xs font-medium px-1 py-0.5 rounded-full bg-rose-100 dark:bg-rose-950/50 text-rose-600 dark:text-rose-300 border border-rose-200 dark:border-rose-800/60">дубль</span>
                  )}
                  <span className="text-xs text-slate-500 dark:text-slate-400 truncate flex-1">{meta.mainName || ''}</span>
                  {t.brand && <span className="font-mono text-2xs text-slate-400 truncate max-w-[80px] shrink-0">{t.brand}</span>}
                </div>
              );
            })}
          </div>
          {selectedTagIds.size > 0 && (
            <div className="px-3 py-2 border-t border-slate-100 dark:border-slate-850 flex items-center justify-between gap-2 bg-slate-50/60 dark:bg-slate-900/40">
              <span className="text-xs font-medium text-emerald-600 dark:text-emerald-300">Отмечено: {selectedTagIds.size}</span>
              <div className="flex items-center gap-1.5">
                <button type="button"
                  onClick={() => {
                    onShowSelected();
                    setOpen(false);
                  }}
                  className="px-2 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold cursor-pointer"
                >
                  Показать
                </button>
                <button type="button"
                  onClick={onClearSelection}
                  className="px-2 py-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-900 text-slate-400 text-xs cursor-pointer"
                >
                  Сбросить
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
});

export default TagSearchPanel;
