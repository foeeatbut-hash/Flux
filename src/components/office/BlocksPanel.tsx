/**
 * Метки данных документа: что откуда собрано, когда обновлялось и не отстало ли.
 *
 * Пристыкована справа, а не наложена на лист. Прежде она висела поверх полотна
 * и закрывала как раз те строки, ради которых её открывали: человек нажимал
 * «обновить», сдвигал панель, снова открывал. Пристыкованная панель ужимает
 * лист, а не прячет его.
 *
 * Вынесена из экрана вместе с остальной библиотекой: разметка панели
 * самодостаточна и меняется отдельно от редактора.
 */
import React from 'react';
import { RefreshCw, Unlink, X } from 'lucide-react';
import { fmtDate } from '../../lib/officeDocs';
import { countOf } from '../../lib/plural';

export interface DataBlock {
  id: string;
  name: string;
  rows: unknown[];
  overrides: Record<string, unknown>;
  state: { lastRefreshAt: string };
}

export default function BlocksPanel({
  blocks, stale, refreshing, onRefreshAll, onRefresh, onUnlink, onClose, tick,
}: {
  blocks: DataBlock[];
  /** У каких блоков данные проекта успели измениться */
  stale: Record<string, boolean>;
  refreshing: string[];
  onRefreshAll: () => void;
  onRefresh: (id: string) => void;
  onUnlink: (id: string) => void;
  onClose: () => void;
  /** Счётчик перерисовки: блоки живут в ref, и React о них не знает */
  tick?: number;
}) {
  return (
    <div className="shrink-0 w-72 @[900px]:w-80 h-full flex flex-col overflow-hidden
                    bg-white dark:bg-slate-900 border-l border-slate-200 dark:border-slate-800"
      data-tick={tick}>
      <div className="flex items-center justify-between gap-2 px-4 py-2.5 border-b border-slate-200 dark:border-slate-800">
        <span className="text-sm font-bold text-slate-800 dark:text-white">Метки данных</span>
        <div className="flex items-center gap-2 shrink-0">
          <button type="button" onClick={onRefreshAll} disabled={refreshing.length > 0}
            className="text-xs font-bold px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white cursor-pointer flex items-center gap-1">
            <RefreshCw className={`w-3 h-3 ${refreshing.length ? 'animate-spin' : ''}`} /> Все
          </button>
          <button type="button" onClick={onClose} aria-label="Закрыть"
            className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-white cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-auto divide-y divide-slate-100 dark:divide-slate-850">
        {blocks.length === 0 && (
          <p className="px-4 py-6 text-xs text-slate-400 text-center">
            Меток в этом документе нет. Их ставит окно «Данные».
          </p>
        )}
        {blocks.map((b) => (
          <div key={b.id} className="px-4 py-3 flex items-center gap-2">
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-slate-800 dark:text-white min-w-0 flex items-center gap-1.5">
                <span className="flex-1 min-w-0 truncate">{b.name}</span>
                {stale[b.id] && <span className="w-2 h-2 rounded-full bg-amber-400 shrink-0" title="Данные проекта изменились" />}
              </div>
              <div className="text-xs text-slate-400 mt-0.5">
                {countOf(b.rows.length, 'строка')} · обновлено {fmtDate(b.state.lastRefreshAt)}
                {Object.keys(b.overrides).length > 0 && ` · правок: ${Object.keys(b.overrides).length}`}
              </div>
            </div>
            <button type="button" onClick={() => onRefresh(b.id)} disabled={refreshing.includes(b.id)} title="Обновить данные блока"
              className="p-1.5 rounded-lg text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950/30 disabled:opacity-50 cursor-pointer">
              <RefreshCw className={`w-4 h-4 ${refreshing.includes(b.id) ? 'animate-spin' : ''}`} />
            </button>
            <button type="button" onClick={() => onUnlink(b.id)} title="Отвязать: оставить как обычные ячейки"
              className="p-1.5 rounded-lg text-slate-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/30 cursor-pointer">
              <Unlink className="w-4 h-4" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
