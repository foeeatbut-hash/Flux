/**
 * Действия над тегом: меню правой кнопки и мини-панель у курсора.
 *
 * Оба списка — про один и тот же тег и про одни и те же действия, только
 * поводы разные: по правой кнопке человек ждёт список словами, по одиночному
 * клику — короткий ряд значков, не закрывающий холст. Пока они жили в разметке
 * реестра, любая правка одного забывалась во втором, и «Найти дубли» из меню
 * умело больше, чем «Найти дубли» из панели.
 *
 * Оба открываются не только с холста: из дерева связей и из таблицы тоже —
 * поэтому набор действий не знает, откуда его позвали.
 */
import React from 'react';
import { createPortal } from 'react-dom';
import {
  ChevronUp, ChevronDown, AlertTriangle, Network, Link2, RefreshCw, X, ClipboardCheck, Edit2,
} from 'lucide-react';

export interface CardActionsProps {
  /** Меню правой кнопки: где открыть и по какому тегу */
  menu: { x: number; y: number; tagId: string } | null;
  /** Мини-панель по одиночному клику */
  panel: { x: number; y: number; tagId: string } | null;
  /** Режим «выбрать несколько» включён */
  multi: boolean;
  selectedCount: number;
  codeOf: (tagId: string) => string;
  dupCountOf: (tagId: string) => number;
  onCloseMenu: () => void;
  onClosePanel: () => void;
  onSelectAncestors: (tagId: string) => void;
  onSelectDescendants: (tagId: string) => void;
  onOpenDuplicates: (tagId: string) => void;
  onWhereUsed: (tagId: string) => void;
  onShare: (tagId: string) => void;
  onShowOnBoard: (tagId: string) => void;
  onClearSelection: () => void;
  onEdit: (tagId: string) => void;
  onStartMulti: () => void;
  onStopMulti: () => void;
}

const ROW = 'w-full flex items-center gap-2.5 px-3 py-2 cursor-pointer';
const ICON = 'p-1.5 rounded-lg cursor-pointer';

export default function CardActions(p: CardActionsProps) {
  const m = p.menu;
  const q = p.panel;
  return (
    <>
      {m && createPortal(
        <div
          className="fixed z-[120] bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800
                     shadow-2xl rounded-xl py-1.5 min-w-[240px] text-xs"
          /* Меню не должно уезжать за край окна: у нижних карточек оно
             открывалось наполовину за экраном и половина пунктов пропадала */
          style={{ top: Math.min(m.y, window.innerHeight - 230), left: Math.min(m.x, window.innerWidth - 260) }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-3 py-1 text-2xs text-slate-400 truncate font-mono">
            {p.codeOf(m.tagId) || 'Тег'}
            {p.selectedCount > 1 && <span className="ml-1 text-emerald-500">+{p.selectedCount - 1}</span>}
          </div>
          <div className="px-3 py-1 text-2xs text-slate-400">Связи</div>
          <button type="button" onClick={() => { p.onSelectAncestors(m.tagId); p.onCloseMenu(); }}
            className={`${ROW} hover:bg-emerald-50 dark:hover:bg-emerald-950/30 text-slate-800 dark:text-slate-300`}>
            <ChevronUp className="w-3.5 h-3.5 text-emerald-500" /> Выделить вверх по ступеньке (родители)
          </button>
          <button type="button" onClick={() => { p.onSelectDescendants(m.tagId); p.onCloseMenu(); }}
            className={`${ROW} hover:bg-emerald-50 dark:hover:bg-emerald-950/30 text-slate-800 dark:text-slate-300`}>
            <ChevronDown className="w-3.5 h-3.5 text-emerald-500" /> Выделить вниз по лестнице (дочерние)
          </button>
          <div className="h-px bg-slate-100 dark:bg-slate-850 my-1 mx-2" />
          {p.dupCountOf(m.tagId) > 1 && (
            <button type="button" onClick={() => { p.onOpenDuplicates(m.tagId); p.onCloseMenu(); }}
              className={`${ROW} hover:bg-rose-50 dark:hover:bg-rose-950/30 text-slate-800 dark:text-slate-300`}>
              <AlertTriangle className="w-3.5 h-3.5 text-rose-500" /> Найти дубли ({p.dupCountOf(m.tagId)})
            </button>
          )}
          <button type="button" onClick={() => { p.onWhereUsed(m.tagId); p.onCloseMenu(); }}
            className={`${ROW} hover:bg-emerald-50 dark:hover:bg-emerald-950/30 text-slate-800 dark:text-slate-150`}>
            <Network className="w-3.5 h-3.5 text-emerald-600" /> Карточка связей
          </button>
          <button type="button" onClick={() => { p.onShare(m.tagId); p.onCloseMenu(); }}
            className={`${ROW} hover:bg-emerald-50 dark:hover:bg-emerald-950/30 text-slate-800 dark:text-slate-300`}>
            <Link2 className="w-3.5 h-3.5 text-emerald-600" />
            Поделиться в рабочем чате{p.selectedCount > 1 ? ` (${p.selectedCount})` : ''}
          </button>
          <button type="button" onClick={() => { p.onShowOnBoard(m.tagId); p.onCloseMenu(); }}
            className={`${ROW} hover:bg-slate-50 dark:hover:bg-slate-900 text-slate-800 dark:text-slate-300`}>
            <RefreshCw className="w-3.5 h-3.5 text-slate-400" /> Показать на холсте
          </button>
          <button type="button" onClick={() => { p.onClearSelection(); p.onCloseMenu(); }}
            className={`${ROW} hover:bg-slate-50 dark:hover:bg-slate-900 text-slate-400`}>
            <X className="w-3.5 h-3.5" /> Снять выделение
          </button>
        </div>,
        document.body,
      )}

      {q && createPortal(
        <div
          data-card-panel
          className="fixed z-[120] flex items-center gap-0.5 p-1 bg-white dark:bg-slate-950
                     border border-slate-200 dark:border-slate-800 shadow-2xl rounded-xl"
          style={{ top: Math.min(q.y, window.innerHeight - 52), left: Math.min(q.x, window.innerWidth - 300) }}
          onClick={(e) => e.stopPropagation()}
        >
          <span className="px-1.5 text-2xs font-mono font-bold text-slate-400 max-w-[110px] truncate">
            {p.codeOf(q.tagId)}
          </span>
          <button type="button" onClick={() => { p.onStartMulti(); p.onClosePanel(); }}
            title="Выбрать несколько: дальше каждый клик добавляет карточку (Esc — готово)"
            className={`${ICON} hover:bg-emerald-50 dark:hover:bg-emerald-950/40 text-emerald-500`}>
            <ClipboardCheck className="w-4 h-4" />
          </button>
          <button type="button" onClick={() => { p.onSelectAncestors(q.tagId); p.onClosePanel(); }}
            title="Выделить вверх по ступеньке (родители)"
            className={`${ICON} hover:bg-emerald-50 dark:hover:bg-emerald-950/40 text-emerald-500`}>
            <ChevronUp className="w-4 h-4" />
          </button>
          <button type="button" onClick={() => { p.onSelectDescendants(q.tagId); p.onClosePanel(); }}
            title="Выделить вниз по лестнице (дочерние)"
            className={`${ICON} hover:bg-emerald-50 dark:hover:bg-emerald-950/40 text-emerald-500`}>
            <ChevronDown className="w-4 h-4" />
          </button>
          {p.dupCountOf(q.tagId) > 1 && (
            <button type="button" onClick={() => { p.onOpenDuplicates(q.tagId); p.onClosePanel(); }}
              title={`Найти дубли (${p.dupCountOf(q.tagId)})`}
              className={`${ICON} hover:bg-rose-50 dark:hover:bg-rose-950/40 text-rose-500`}>
              <AlertTriangle className="w-4 h-4" />
            </button>
          )}
          <button type="button" onClick={() => { p.onWhereUsed(q.tagId); p.onClosePanel(); }}
            title="Карточка связей: оборудование, документы, файлы, ВДР"
            className={`${ICON} hover:bg-emerald-50 dark:hover:bg-emerald-950/40 text-emerald-600`}>
            <Network className="w-4 h-4" />
          </button>
          <button type="button" onClick={() => { p.onShare(q.tagId); p.onClosePanel(); }}
            title="Поделиться в рабочем чате"
            className={`${ICON} hover:bg-emerald-50 dark:hover:bg-emerald-950/40 text-emerald-600`}>
            <Link2 className="w-4 h-4" />
          </button>
          <button type="button" onClick={() => { p.onEdit(q.tagId); p.onClosePanel(); }}
            title="Редактировать тег"
            className={`${ICON} hover:bg-slate-100 dark:hover:bg-slate-900 text-slate-500`}>
            <Edit2 className="w-4 h-4" />
          </button>
        </div>,
        document.body,
      )}

      {p.multi && createPortal(
        <div className="fixed top-20 left-1/2 -translate-x-1/2 z-[115] flex items-center gap-2 px-3 py-2
                        bg-emerald-600 text-white rounded-xl shadow-lg text-xs font-semibold">
          <ClipboardCheck className="w-4 h-4" />
          Мультивыбор: {p.selectedCount} — клик добавляет карточку
          <button type="button" onClick={p.onStopMulti} title="Завершить (Esc)"
            className="ml-1 px-2 py-0.5 rounded-lg bg-white/20 hover:bg-white/30 cursor-pointer">
            Готово
          </button>
        </div>,
        document.body,
      )}
    </>
  );
}
