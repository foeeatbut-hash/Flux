/**
 * Панель просмотра справа от таблицы Проводника: одиночный файл или папка,
 * сводка по выбранному и действия над файлом.
 *
 * Вынесено из экрана как есть. Выделение, список элементов и обработчики
 * остаются в экране: сюда приходят значения и функции, сама панель ничего не
 * хранит. Показ панели (showPreviewPane) решает экран — он же знает, что её
 * состояние запоминается между сеансами.
 */
import React from 'react';
import { Folder, Download, Tag, Edit2, Trash2 } from 'lucide-react';
import { format } from 'date-fns';
import FilePreview from './FilePreview';
import { getFileIcon, formatSize, StatusChip } from './FileItems';
import { countOf } from '../../lib/plural';
import { saveExplorerItem } from '../../lib/saveToWindows';
import { useToastStore } from '../../store/toastStore';

interface PreviewPaneProps {
  selectedIds: Set<string>;
  /** Элементы текущего вида; типизированы как в экране — строки файлов и папок разной формы */
  allCurrentItems: any[];
  folders: any[];
  onChangeStatus: (fileId: string) => void;
  onAssignTag: (fileId: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string, isFile: boolean) => void;
}

export default function PreviewPane({
  selectedIds, allCurrentItems, folders, onChangeStatus, onAssignTag, onRename, onDelete,
}: PreviewPaneProps) {
  const { addToast } = useToastStore();
  return (
    <div className="hidden @[820px]:flex w-64 border-l border-slate-200 dark:border-dark-border bg-slate-50 dark:bg-dark-surface overflow-y-auto flex-col flex-shrink-0">
       {(() => {
          if (selectedIds.size === 0) return <div className="p-4 text-center text-slate-500 dark:text-dark-text-muted text-xs mt-10">Выберите файл для предпросмотра.</div>;
          if (selectedIds.size > 1) return <div className="p-4 text-center text-slate-500 dark:text-dark-text-muted text-xs mt-10">Выбрано: {countOf(selectedIds.size, 'элемент')}.</div>;

          const id = Array.from(selectedIds)[0];
          const item = allCurrentItems.find(i => i.id === id);
          if (!item) return null;

          if (item.isFolder) {
            return (
               <div className="p-4 flex flex-col items-center mt-10">
                 <Folder className="w-16 h-16 text-amber-500 fill-amber-200 mb-4" />
                 <h3 className="font-semibold text-slate-800 dark:text-dark-text-main text-center break-words w-full">{item.name}</h3>
                 <p className="text-xs text-slate-500 dark:text-dark-text-muted mt-2">Папка с файлами</p>
               </div>
            );
          }

          return (
            <div className="p-4 flex flex-col">
               <FilePreview item={item} icon={getFileIcon(item, 'w-12 h-12 mb-2')} />

               <h3 className="font-semibold text-slate-800 dark:text-dark-text-main mb-2 break-words text-sm">{item.name}</h3>

               <div className="space-y-2 text-xs mt-2">
                 <div className="flex justify-between border-b border-slate-100 pb-1">
                   <span className="text-slate-500 dark:text-dark-text-muted">Размер</span>
                   <span className="text-slate-800 dark:text-dark-text-main">{formatSize(item.size)}</span>
                 </div>
                 <div className="flex justify-between border-b border-slate-100 pb-1">
                   <span className="text-slate-500 dark:text-dark-text-muted">Тип</span>
                   <span className="text-slate-800 dark:text-dark-text-main flex-1 text-right truncate ml-2">{item.type}</span>
                 </div>
                 <div className="flex justify-between items-center border-b border-slate-100 pb-1">
                   <span className="text-slate-500 dark:text-dark-text-muted">Статус</span>
                   <StatusChip code={item.statusCode} onClick={(e) => { e.stopPropagation(); onChangeStatus(item.id); }} />
                 </div>
                 <div className="flex justify-between border-b border-slate-100 pb-1">
                   <span className="text-slate-500 dark:text-dark-text-muted">Ревизия</span>
                   <span className="text-slate-800 dark:text-dark-text-main">v{item.revision || '1'}</span>
                 </div>
                 <div className="flex justify-between border-b border-slate-100 pb-1">
                   <span className="text-slate-500 dark:text-dark-text-muted">Дата изменения</span>
                   <span className="text-slate-800 dark:text-dark-text-main">{item.updatedAt ? format(new Date(item.updatedAt), 'dd.MM.yyyy HH:mm') : ''}</span>
                 </div>
                 {item.department && item.department !== "Unassigned" && (
                 <div className="flex justify-between border-b border-slate-100 pb-1">
                   <span className="text-slate-500 dark:text-dark-text-muted">Отдел</span>
                   <span className="text-slate-800 font-medium text-emerald-700 bg-emerald-50 dark:bg-emerald-950/40 dark:text-emerald-300 px-1.5 py-0.5 rounded">{item.department}</span>
                 </div>
                 )}
                 {((item.mainTags && item.mainTags.length > 0) || (item.additionalTags && item.additionalTags.length > 0)) && (
                 <div className="flex flex-col border-b border-slate-100 pb-1 pt-1">
                   <span className="text-slate-500 dark:text-dark-text-muted mb-1.5">Назначенные теги</span>
                   <div className="flex flex-wrap gap-1">
                     {item.mainTags?.map((t:any) => <span key={t.id} className="bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded text-xs font-medium font-mono border border-amber-200" title="Основной тег">{t.identifier}</span>)}
                     {item.additionalTags?.map((t:any) => <span key={t.id} className="bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded text-xs font-mono border border-slate-200" title="Дополнительный тег">{t.identifier}</span>)}
                   </div>
                 </div>
                 )}
                 {/* Кто и когда: в общем архиве это первый вопрос к чужому файлу */}
                 {(item.updatedBy?.name || item.createdBy?.name) && (
                   <div className="flex justify-between border-b border-slate-100 dark:border-dark-border pb-1">
                     <span className="text-slate-500 dark:text-dark-text-muted">Изменил</span>
                     <span className="text-slate-800 dark:text-dark-text-main truncate ml-2">{(item.updatedBy?.name || item.createdBy?.name || '').replace(/\s*\(.*\)$/, '')}</span>
                   </div>
                 )}
                 {item.createdAt && (
                   <div className="flex justify-between border-b border-slate-100 dark:border-dark-border pb-1">
                     <span className="text-slate-500 dark:text-dark-text-muted">Создан</span>
                     <span className="text-slate-800 dark:text-dark-text-main">{format(new Date(item.createdAt), 'dd.MM.yyyy HH:mm')}</span>
                   </div>
                 )}
               </div>

               {/* Действия над файлом — закреплены внизу панели: на экране
                   ноутбука они иначе уходят ниже видимой части. */}
               <div className="sticky bottom-0 -mx-4 px-4 pt-3 pb-1 bg-slate-50 dark:bg-dark-surface border-t border-slate-200 dark:border-dark-border grid grid-cols-2 gap-1.5 mt-3">
                 <button type="button" onClick={() => void saveExplorerItem(item.id, false, allCurrentItems, folders, addToast)}
                   className="flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-2xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 transition-ui cursor-pointer">
                   <Download className="w-3.5 h-3.5" /> Выгрузить в Windows
                 </button>
                 <button type="button" onClick={() => onAssignTag(item.id)}
                   className="flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-2xs font-semibold border border-slate-200 dark:border-dark-border hover:bg-white dark:hover:bg-dark-panel transition-ui cursor-pointer">
                   <Tag className="w-3.5 h-3.5 text-amber-500" /> Теги
                 </button>
                 <button type="button" onClick={() => onRename(item.id, item.name)}
                   className="flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-2xs font-semibold border border-slate-200 dark:border-dark-border hover:bg-white dark:hover:bg-dark-panel transition-ui cursor-pointer">
                   <Edit2 className="w-3.5 h-3.5" /> Переименовать
                 </button>
                 <button type="button" onClick={() => onDelete(item.id, true)}
                   className="flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-2xs font-semibold text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-900 hover:bg-rose-50 dark:hover:bg-rose-950/30 transition-ui cursor-pointer">
                   <Trash2 className="w-3.5 h-3.5" /> Удалить
                 </button>
               </div>
            </div>
          );
       })()}
    </div>
  );
}
