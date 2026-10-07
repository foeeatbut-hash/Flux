/**
 * Боковая панель Проводника: корневые разделы с деревом папок, «Подборки» и
 * «Корзина».
 *
 * Вынесено из экрана как есть. Панель ничего не решает сама: куда перейти,
 * куда загрузить брошенные файлы и куда перенести перетащенные элементы,
 * выбирает экран, а сюда приходят значения и обработчики. Раскрытие и
 * подсветка перетаскивания — локальное состояние папки дерева (TreeFolder),
 * наружу оно не нужно.
 */
import React, { useState } from 'react';
import {
  Folder, File as FileIcon, ChevronRight, ChevronDown, Clock, Tag, Copy, Trash2,
} from 'lucide-react';
import { getFileIcon } from './FileItems';
import {
  SEC_SHARED, SEC_DISK, TRASH_ID, SMART_RECENT, SMART_UNTAGGED, SMART_DUPES,
} from '../../lib/explorerSections';

interface ExplorerSidebarProps {
  /** null — список разделов («Проводник» в корне) */
  currentFolderId: string | null;
  sections: Array<{ id: string; name: string }>;
  folders: any[];
  diskRootId: string;
  /** Раздел (диск, общий, личный), которому принадлежит папка */
  itemSection: (item: any) => string;
  trash: { folders: any[]; files: any[] } | null;
  onNavigate: (folderId: string | null) => void;
  onUpload: (files: FileList | File[], targetFolderId: string | null) => unknown;
  onMoveItems: (ids: string[], targetFolderId: string | null) => unknown;
}

export default function ExplorerSidebar({
  currentFolderId, sections, folders, diskRootId, itemSection, trash, onNavigate, onUpload, onMoveItems,
}: ExplorerSidebarProps) {
  return (
    <div 
      className="w-44 @[900px]:w-56 border-r border-slate-200 dark:border-slate-850 bg-slate-50/60 dark:bg-slate-950/40 overflow-y-auto pt-2 flex-shrink-0 select-none scrollbar-thin scrollbar-thumb-slate-300 dark:scrollbar-thumb-slate-800"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
        <div
          className={`flex items-center py-1.5 px-3 mx-2 rounded-lg cursor-pointer transition-colors text-slate-700 dark:text-slate-300 ${currentFolderId === null ? 'bg-emerald-500/10 dark:bg-emerald-500/15 text-emerald-800 dark:text-emerald-200 font-medium' : 'hover:bg-slate-200/50 dark:hover:bg-slate-900'}`}
          onClick={() => onNavigate(null)}
        >
          <FileIcon className="w-4 h-4 mr-2 text-slate-500 shrink-0" />
          <span className="text-sm">Проводник</span>
        </div>
        {sections.map(sec => (
          <div key={sec.id}>
            <div
              className={`flex items-center py-1.5 px-3 mx-2 mt-1 rounded-lg cursor-pointer transition-colors text-slate-700 dark:text-slate-300 ${currentFolderId === sec.id ? 'bg-emerald-500/10 dark:bg-emerald-500/15 text-emerald-800 dark:text-emerald-200 font-medium' : 'hover:bg-slate-200/50 dark:hover:bg-slate-900'}`}
              onClick={() => onNavigate(sec.id)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                 e.preventDefault();
                 e.stopPropagation();
                 if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                    onUpload(e.dataTransfer.files, sec.id);
                 } else {
                    const dataStr = e.dataTransfer.getData('text/plain');
                    if (dataStr) {
                       try {
                          const data = JSON.parse(dataStr);
                          if (data.type === 'app_items') onMoveItems(data.ids, sec.id);
                       } catch (err) {}
                    }
                 }
              }}
              title={sec.id === SEC_DISK
                ? 'Общий диск: виден всем и не зависит от проекта. Класть и удалять — по праву «Запись на общий диск»'
                : sec.id === SEC_SHARED ? 'Общий раздел: файлы видят все пользователи' : 'Личный раздел: файлы видит только владелец'}
            >
              {getFileIcon({ isSection: true, id: sec.id }, 'w-4 h-4 mr-2 shrink-0')}
              <span className="text-sm font-medium truncate">{sec.name}</span>
            </div>
            {folders.filter(f => (sec.id === SEC_DISK
              ? f.parentId === diskRootId
              : !f.parentId && itemSection(f) === sec.id)).map(folder => (
              <TreeFolder key={folder.id} folder={folder} allFolders={folders} currentFolderId={currentFolderId} onSelect={onNavigate} onDropFiles={onUpload} onMoveItems={onMoveItems} depth={2} />
            ))}
          </div>
        ))}

        {/* Подборки: срезы по всем файлам, а не папки */}
        <div className="mt-3 mb-1 px-4 text-2xs font-mono text-slate-400">Подборки</div>
        {[
          { id: SMART_RECENT, label: 'Недавние', icon: Clock, hint: 'Сто последних изменённых файлов проекта' },
          { id: SMART_UNTAGGED, label: 'Без тегов', icon: Tag, hint: 'Файлы, не привязанные ни к одному тегу оборудования' },
          { id: SMART_DUPES, label: 'Дубликаты', icon: Copy, hint: 'Файлы с одинаковыми именами — вероятные повторы' },
        ].map((sm) => {
          const Icon = sm.icon as any;
          const active = currentFolderId === sm.id;
          return (
            <div
              key={sm.id}
              className={`flex items-center py-1.5 px-3 mx-2 rounded-lg cursor-pointer transition-ui ${
                active
                  ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-300 font-semibold'
                  : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-900'
              }`}
              onClick={() => onNavigate(sm.id)}
              title={sm.hint}
            >
              <Icon className="w-4 h-4 mr-2 text-slate-500 shrink-0" />
              <span className="text-sm">{sm.label}</span>
            </div>
          );
        })}

        {/* Корзина: удалённое хранится здесь до явной очистки */}
        <div
          className={`flex items-center py-1.5 px-3 mx-2 mt-2 rounded-lg cursor-pointer transition-ui ${
            currentFolderId === TRASH_ID
              ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-300 font-semibold'
              : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-900'
          }`}
          onClick={() => onNavigate(TRASH_ID)}
          title="Удалённые файлы и папки — можно вернуть"
        >
          <Trash2 className="w-4 h-4 mr-2 text-slate-500 shrink-0" />
          <span className="text-sm">Корзина</span>
          {!!((trash?.files.length || 0) + (trash?.folders.length || 0)) && (
            <span className="ml-auto text-2xs font-mono text-slate-400">
              {(trash?.files.length || 0) + (trash?.folders.length || 0)}
            </span>
          )}
        </div>
    </div>
  );
}

const TreeFolder = ({ folder, allFolders, currentFolderId, onSelect, depth = 1, onDropFiles, onMoveItems }: any) => {
  const children = allFolders.filter((f: any) => f.parentId === folder.id);
  const [expanded, setExpanded] = useState(true);
  const [isDragOver, setIsDragOver] = useState(false);
  const isSelected = currentFolderId === folder.id;

  return (
    <div>
      <div 
        onClick={() => onSelect(folder.id)}
        onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
        onDragLeave={(e) => { e.preventDefault(); setIsDragOver(false); }}
        onDrop={async (e) => {
           e.preventDefault();
           e.stopPropagation();
           setIsDragOver(false);
           if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
              onDropFiles(e.dataTransfer.files, folder.id);
           } else {
             const dataStr = e.dataTransfer.getData('text/plain');
             if (dataStr) {
               try {
                 const data = JSON.parse(dataStr);
                 if (data.type === 'app_items') {
                   if (data.ids.includes(folder.id)) return;
                   onMoveItems(data.ids, folder.id);
                 }
               } catch (err) {}
             }
           }
        }}
        className={`flex items-center py-1.5 px-2 mx-2 rounded-lg cursor-pointer transition-colors text-slate-700 dark:text-slate-300 ${isDragOver ? 'bg-emerald-200 dark:bg-emerald-950/45' : isSelected ? 'bg-emerald-500/10 text-emerald-800 dark:text-emerald-200 font-medium' : 'hover:bg-slate-200/50 dark:hover:bg-slate-900'}`}
        style={{ paddingLeft: `${depth * 16}px` }}
      >
        <div 
           className="w-4 h-4 flex items-center justify-center hover:bg-slate-300/50"
           onClick={(e) => { if(children.length) { e.stopPropagation(); setExpanded(!expanded); } }}
        >
          {children.length > 0 ? (expanded ? <ChevronDown className="w-3 h-3 text-slate-500" /> : <ChevronRight className="w-3 h-3 text-slate-500" />) : <span className="w-3 h-3" />}
        </div>
        <Folder className={`w-4 h-4 mr-2 flex-shrink-0 ${isSelected ? 'text-amber-600 fill-amber-200' : 'text-amber-500 fill-amber-100'}`} />
        <span className="truncate text-xs select-none">{folder.name}</span>
      </div>
      {expanded && children.map((child: any) => (
        <TreeFolder key={child.id} folder={child} allFolders={allFolders} currentFolderId={currentFolderId} onSelect={onSelect} depth={depth + 1} onDropFiles={onDropFiles} onMoveItems={onMoveItems} />
      ))}
    </div>
  );
};
