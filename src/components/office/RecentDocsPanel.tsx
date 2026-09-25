/**
 * «Открыть недавние» — одно окно на все программы Flux Office.
 *
 * Раньше вернуться к вчерашней записке можно было только через библиотеку
 * Конструктора, а к вчерашнему чертежу — только через Проводник: две разные
 * дороги к одному и тому же делу. Здесь список общий: таблица, документ,
 * заметка и просмотр в одном месте, свежее сверху.
 *
 * Вещи чужого проекта в списке не показываются — та же беда, что с выдачей
 * оборудования всех проектов сразу: человек открывает документ и не понимает,
 * почему в нём чужие данные.
 */
import React from 'react';
import { createPortal } from 'react-dom';
import { X, Trash2 } from 'lucide-react';
import FileBadge from '../ui/FileBadge';
import { recentBadge } from '../../lib/fileBadge';
import { useRecentStore } from '../../store/recentStore';
import { visibleRecentDocs, whenLabel, kindName } from '../../lib/recentDocs';
import { useOverlay } from '../../store/overlayStore';
import { useEscapeClose } from '../../lib/useDismiss';
import { Z } from '../../lib/layers';

export default function RecentDocsPanel({ projectId, onOpen, onClose }: {
  projectId: string | null;
  onOpen: (href: string) => void;
  onClose: () => void;
}) {
  useOverlay(true);
  useEscapeClose(true, onClose);
  const docs = useRecentStore((s) => s.docs);
  const forget = useRecentStore((s) => s.forget);
  const list = visibleRecentDocs(docs, projectId);

  return createPortal(
    <div className="fixed inset-0 flex items-center justify-center p-4 fx-backdrop"
      style={{ zIndex: Z.modal }} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-lg max-h-[80vh] flex flex-col rounded-2xl border border-slate-200 dark:border-dark-border
                      bg-white dark:bg-dark-surface shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-dark-border">
          <span className="text-sm font-bold text-slate-800 dark:text-white">Открыть недавние</span>
          <button type="button" title="Закрыть" onClick={onClose}
            className="p-1 rounded text-slate-400 hover:text-slate-700 dark:hover:text-white cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-auto p-2">
          {!list.length && (
            <p className="px-3 py-8 text-center text-sm text-slate-500 dark:text-slate-400">
              Пока пусто. Здесь появятся таблицы, документы, заметки и чертежи, которые вы открывали.
            </p>
          )}
          {list.map((d) => {
            return (
              <div key={d.href}
                className="group flex items-center gap-2.5 px-2.5 py-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-850 transition-colors">
                <button type="button" onClick={() => { onOpen(d.href); onClose(); }}
                  className="flex-1 min-w-0 flex items-center gap-2.5 text-left cursor-pointer">
                  <FileBadge file={d.title} kind={recentBadge(d)} size={18} />
                  <span className="min-w-0">
                    <span className="block text-sm text-slate-800 dark:text-slate-150 truncate">{d.title}</span>
                    <span className="block text-2xs text-slate-400">{kindName(d.kind)} · {whenLabel(d.at)}</span>
                  </span>
                </button>
                {/* Убрать из списка — не удалить сам документ: об этом и надпись */}
                <button type="button" title="Убрать из недавних (сам документ останется)"
                  onClick={() => forget(d.href)}
                  className="p-1 rounded text-slate-300 hover:text-rose-500 opacity-0 group-hover:opacity-100 cursor-pointer">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}
