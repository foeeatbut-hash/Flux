/**
 * Полоса вкладок Проводника и строка состояния под списком.
 *
 * Вынесено из экрана не «чтобы было меньше строк»: это два разных ответа на
 * два разных вопроса. Вкладки отвечают на «где я и что ещё открыто», строка
 * состояния — на «что я выбрал и что с этим». Оба ответа человек читает не
 * глядя, боковым зрением, и потому оба должны быть одинаковыми всегда.
 *
 * Что именно происходит с вкладками при закрытии и открытии, считает
 * src/lib/explorerTabs.ts — там же и проверки.
 */
import React from 'react';
import { Folder, X, Plus } from 'lucide-react';
import { countOf } from '../../lib/plural';
import { formatSize, statusOf } from './FileItems';
import { FileIcon } from '../icons/FluxIcons';
import { ICON_SIZE } from '../../lib/metrics';
import {
  loadTabs, saveTabs, closeTab, openInTab, moveActive, activeOf, type ExpTab,
} from '../../lib/explorerTabs';

export function ExplorerTabs({ tabs, activeId, onPick, onClose, onNew }: {
  tabs: ExpTab[];
  activeId: string;
  onPick: (tab: ExpTab) => void;
  onClose: (tab: ExpTab) => void;
  onNew: () => void;
}) {
  return (
    <div className="shrink-0 flex items-end gap-0.5 px-1.5 pt-1.5 bg-slate-100/95 dark:bg-slate-900/90
                    border-b border-slate-200 dark:border-slate-800">
      {tabs.map((t) => (
        <div
          key={t.id}
          onClick={(e) => { e.stopPropagation(); onPick(t); }}
          onAuxClick={(e) => {
            // Средняя кнопка закрывает — привычка из браузера
            if (e.button !== 1) return;
            e.preventDefault();
            onClose(t);
          }}
          title={t.name}
          className={`shrink-0 flex items-center gap-1.5 h-7 px-2.5 rounded-t-lg cursor-pointer text-xs max-w-[180px]
                      ${t.id === activeId
                        ? 'bg-white dark:bg-dark-bg text-slate-800 dark:text-slate-100 font-semibold'
                        : 'text-slate-500 dark:text-slate-400 hover:bg-white/60 dark:hover:bg-slate-850'}`}
        >
          <FileIcon kind="folder" size={ICON_SIZE.row} />
          <span className="truncate">{t.name}</span>
          {tabs.length > 1 && (
            <button
              type="button"
              aria-label="Закрыть вкладку"
              onClick={(e) => { e.stopPropagation(); onClose(t); }}
              className="shrink-0 w-4 h-4 rounded flex items-center justify-center
                         hover:bg-slate-300 dark:hover:bg-slate-700"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
      ))}
      <button
        type="button"
        title="Новая вкладка (Ctrl+T)"
        aria-label="Новая вкладка"
        onClick={(e) => { e.stopPropagation(); onNew(); }}
        className="shrink-0 w-6 h-6 mb-0.5 rounded-lg flex items-center justify-center cursor-pointer
                   text-slate-400 hover:bg-white/60 dark:hover:bg-slate-850"
      >
        <Plus className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

export interface StatusLine {
  /** Сколько объектов в папке */
  total: number;
  /** Сколько из них выбрано */
  selected: number;
  /** Сколько весит выбранное */
  size: number;
  /** Что за документ выбран: стадия, ревизия, кто менял */
  detail: string;
}

/**
 * Что написать в строке состояния.
 *
 * Стадию и ревизию человек спрашивает чаще всего, а искать их приходилось в
 * колонках или открытием документа.
 */
export function buildStatus(items: any[], selected: Set<string>): StatusLine {
  const chosen = items.filter((i) => selected.has(i.id));
  const size = chosen.reduce((sum, i) => sum + (Number(i.size) || 0), 0);
  let detail = '';
  if (chosen.length === 1) {
    const it = chosen[0];
    if (it.isFolder) detail = 'папка';
    else {
      const st = statusOf(it.statusCode);
      const who = it.updatedBy?.name || it.createdBy?.name || '';
      detail = [st.label, `ревизия ${it.revision || '1'}`, who && `изменил ${who}`]
        .filter(Boolean).join(', ');
    }
  }
  return { total: items.length, selected: chosen.length, size, detail };
}

/**
 * Всё поведение вкладок одним куском: состояние, переходы, клавиши.
 *
 * Экрану остаётся сказать, где он сейчас и как называется папка, — остальное
 * живёт здесь. Пока это лежало в самом Проводнике, оно тонуло среди загрузки
 * файлов и дерева папок, а Проводник и без того самый большой экран программы.
 *
 * Ctrl+T и Ctrl+W — как в проводнике и в браузере: рука уже привыкла.
 * Последняя вкладка не закрывается: окно без вкладок показывать нечего.
 */
export function useExplorerTabs(opts: {
  currentFolderId: string | null;
  navigateTo: (id: string | null) => void;
  titleOf: (id: string | null) => string;
}) {
  const [tabs, setTabs] = React.useState<ExpTab[]>(() => loadTabs().tabs);
  const [activeId, setActiveId] = React.useState<string>(() => loadTabs().activeId);
  React.useEffect(() => { saveTabs(tabs, activeId); }, [tabs, activeId]);

  const goto = (folderId: string | null) => {
    if (folderId !== opts.currentFolderId) opts.navigateTo(folderId);
  };

  const pick = (t: ExpTab) => { setActiveId(t.id); goto(t.folderId); };

  const close = (t: ExpTab) => {
    const r = closeTab(tabs, t.id, activeId);
    setTabs(r.tabs); setActiveId(r.activeId);
    if (r.activeId !== activeId) goto(activeOf(r.tabs, r.activeId).folderId);
  };

  const add = () => {
    const r = openInTab(tabs, opts.currentFolderId, opts.titleOf(opts.currentFolderId));
    setTabs(r.tabs); setActiveId(r.activeId);
  };

  /** Показанная вкладка переехала вместе с нами */
  const follow = (folderId: string | null) => {
    setTabs((list) => moveActive(list, activeId, folderId, opts.titleOf(folderId)));
  };

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      const k = e.key.toLowerCase();
      if (k === 't') { e.preventDefault(); add(); return; }
      if (k === 'w' && tabs.length > 1) {
        e.preventDefault();
        close(activeOf(tabs, activeId));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return { tabs, activeId, pick, close, add, follow };
}

export function ExplorerStatus({ line }: { line: StatusLine }) {
  return (
    <div className="h-6 bg-[#F3F4F6] dark:bg-dark-surface border-t border-slate-300 dark:border-dark-border
                    flex items-center px-4 text-xs text-slate-600 dark:text-dark-text-muted gap-3 shrink-0 select-none">
      <span>{countOf(line.total, 'элемент')}</span>
      {line.selected > 0 && <span>· выбрано: {line.selected}</span>}
      {!!line.size && <span>· {formatSize(line.size)}</span>}
      {!!line.detail && <span className="truncate">· {line.detail}</span>}
    </div>
  );
}
