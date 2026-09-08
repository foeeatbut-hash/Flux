/**
 * Строки Проводника: одна для таблицы, одна для плиток.
 *
 * Обе — только рисование: ни запросов, ни состояния, ни знания о том, что
 * такое проект. Всё, что нужно показать, приходит свойствами. Вынесены из
 * Explorer.tsx, который вырос настолько, что найти в нём разметку строки
 * стало отдельной задачей.
 */
import React from 'react';
import { format } from 'date-fns';
import { Folder, File as FileIcon, Image as ImageIcon, FileText, FileSpreadsheet, Boxes, HardDrive } from 'lucide-react';
import { SEC_SHARED, SEC_DISK } from '../../lib/explorerSections';
import { faceOf } from '../../lib/fileTypes';

export const getFileIcon = (item: any, classNameStr: string) => {
  if (item.isSection) {
    // Диск — не папка: он не в проекте и его нельзя переименовать. Значок
    // должен это показывать, иначе три одинаковые папки в дереве неразличимы
    if (item.id === SEC_DISK) return <HardDrive className={`${classNameStr} text-slate-500 dark:text-slate-400`} />;
    return item.id === SEC_SHARED
      ? <Folder className={`${classNameStr} text-emerald-600 fill-emerald-200`} />
      : <Folder className={`${classNameStr} text-sky-600 fill-sky-200`} />;
  }
  if (item.isFolder && item.system) return <Folder className={`${classNameStr} text-emerald-600 fill-emerald-100`} />;
  if (item.isFolder) return <Folder className={`${classNameStr} text-amber-500 fill-amber-200`} />;
  if (item.type === 'CONSTRUCTOR') return <FileSpreadsheet className={`${classNameStr} text-emerald-600`} />;
  // Вид файла считает общая таблица расширений: свой список здесь был пятым по
  // счёту, и они расходились — .xls показывался безымянным значком, хотя
  // открывается «Таблицей»
  switch (faceOf(item.name || '')) {
    case 'image': return <ImageIcon className={`${classNameStr} text-emerald-500`} />;
    case 'pdf': return <FileText className={`${classNameStr} text-rose-500`} />;
    case 'sheet': return <FileSpreadsheet className={`${classNameStr} text-emerald-600`} />;
    case 'text': return <FileText className={`${classNameStr} text-sky-600`} />;
    case 'plain': return <FileText className={`${classNameStr} text-slate-500`} />;
    default: return <FileIcon className={`${classNameStr} text-slate-400`} />;
  }
};

export const formatSize = (bytes: number) => {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
};

// ── Статусы документооборота (код A/B/C/D → человекочитаемый поток) ──
// Проводник 2.0 §6.2: вместо безымянной цветной точки — понятный чип.
export const FILE_STATUSES: Record<string, { label: string; dot: string; chip: string }> = {
  D: { label: 'Черновик',    dot: 'bg-slate-400',   chip: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300' },
  C: { label: 'На проверке', dot: 'bg-amber-500',   chip: 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400' },
  B: { label: 'Согласован',  dot: 'bg-sky-500',     chip: 'bg-sky-100 text-sky-700 dark:bg-sky-950/40 dark:text-sky-400' },
  A: { label: 'Выдан',       dot: 'bg-emerald-500', chip: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400' },
};
export const STATUS_ORDER = ['D', 'C', 'B', 'A'];
export const statusOf = (code: string | undefined) => FILE_STATUSES[code || 'D'] || FILE_STATUSES.D;

export const StatusChip = ({ code, onClick }: { code?: string; onClick?: (e: React.MouseEvent) => void }) => {
  const s = statusOf(code);
  return (
    <span
      onClick={onClick}
      title={onClick ? 'Сменить статус документа' : s.label}
      className={`inline-flex items-center gap-1 text-2xs font-bold px-1.5 py-0.5 rounded-full ${s.chip} ${onClick ? 'cursor-pointer hover:brightness-95' : ''}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} /> {s.label}
    </span>
  );
};

export const FileRowItem = React.memo(({
  item,
  index,
  isSelected,
  isRenaming,
  isCut,
  renameValue,
  onRenameValueChange,
  onRenameSubmit,
  onCancelRename,
  onClick,
  onDoubleClick,
  onContextMenu,
  onDragStart,
  onDropItems,
  measureElement,
  loaded,
  foreign,
  catLabel,
  onChangeStatus,
  onOpenTag
}: any) => {
  return (
    <tr
      ref={measureElement}
      data-index={index}
      draggable
      onDragStart={onDragStart}
      onDragOver={(e) => {
        if (item.isFolder) {
           e.preventDefault();
           e.currentTarget.classList.add('bg-emerald-100');
        }
      }}
      onDragLeave={(e) => {
         if (item.isFolder) e.currentTarget.classList.remove('bg-emerald-100');
      }}
      onDrop={(e) => {
         if (!item.isFolder) return;
         e.preventDefault();
         e.stopPropagation();
         e.currentTarget.classList.remove('bg-emerald-100');
         onDropItems(e, item.id);
      }}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      className={`cursor-default transition-colors ${isSelected ? 'bg-emerald-100 dark:bg-emerald-950/30 text-emerald-900 dark:text-emerald-100' : 'hover:bg-slate-100 dark:hover:bg-dark-panel/65'} ${isCut ? 'opacity-50' : ''}`}
    >
      <td className="flux-cell flex items-center gap-2">
        <div className="relative shrink-0">
           {getFileIcon(item, "w-5 h-5")}
           {!item.isFolder && item.statusCode && (
              <span className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ring-2 ring-white dark:ring-dark-bg ${statusOf(item.statusCode).dot}`} title={statusOf(item.statusCode).label} />
           )}
        </div>
        {isRenaming ? (
          <input
            type="text"
            autoFocus
            value={renameValue}
            onChange={e => onRenameValueChange(e.target.value)}
            onBlur={() => onRenameSubmit(item.id, !item.isFolder, renameValue)}
            onKeyDown={e => {
              if (e.key === 'Enter') onRenameSubmit(item.id, !item.isFolder, renameValue);
              if (e.key === 'Escape') onCancelRename();
            }}
            onClick={e => e.stopPropagation()}
            className="border border-emerald-405 px-1 py-0 text-sm outline-none w-full bg-white dark:bg-slate-900 text-slate-900 dark:text-white select-text"
          />
        ) : (
          <>
            <span className="truncate max-w-[200px] text-slate-800 dark:text-slate-100">{item.name}</span>
            {/* В подборках одинаковые имена не различить без места хранения */}
            {item.smartLocation && (
              <span className="ml-2 text-2xs text-slate-400 shrink-0" title="Где лежит файл">в папке «{item.smartLocation}»</span>
            )}
            {/* Чужой проект. Метка нужна до нажатия, а не после: иначе человек
                сначала жмёт, а потом узнаёт, что открыть нельзя. */}
            {foreign && (
              <span
                className="ml-1.5 shrink-0 text-2xs font-semibold px-1.5 py-0.5 rounded-full max-w-[140px] truncate
                           bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-350
                           border border-slate-200 dark:border-slate-700"
                title={`Из проекта «${foreign}». Открывается вместе с переключением проекта.`}
              >
                {foreign}
              </span>
            )}
          </>
        )}
        {loaded && !isRenaming && (
          <span
            className="ml-1 inline-flex items-center gap-1 shrink-0 text-2xs font-semibold px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800"
            title={`Данные загружены в оборудование: ${catLabel(loaded.category)} (ревизия v${loaded.version})`}
          >
            <Boxes className="w-3 h-3" /> v{loaded.version}
          </span>
        )}
      </td>
      <td className="flux-cell text-sm text-slate-500 dark:text-dark-text-muted whitespace-nowrap">{item.updatedAt ? format(new Date(item.updatedAt), 'dd.MM.yyyy HH:mm') : <span className="text-slate-400 dark:text-slate-455">—</span>}</td>
      <td className="flux-cell text-sm">{!item.isFolder ? <StatusChip code={item.statusCode} onClick={onChangeStatus ? (e) => { e.stopPropagation(); onChangeStatus(item.id); } : undefined} /> : <span className="text-slate-400 text-xs">Папка</span>}</td>
      {/* У папки нет размера, у файла может не быть тегов и отдела: ставим
          прочерк — пустая ячейка читается как «данные не загрузились». */}
      <td className="flux-cell hidden @[760px]:table-cell text-sm text-slate-500 dark:text-dark-text-muted text-right whitespace-nowrap">{!item.isFolder ? formatSize(item.size) : <span className="text-slate-400 dark:text-slate-455">—</span>}</td>
      <td className="flux-cell hidden @[880px]:table-cell">
         <div className="flex flex-wrap gap-1">
           {!item.isFolder && (item.mainTags || []).map((t: any) => (
             <span key={t.id} onClick={onOpenTag ? (e) => { e.stopPropagation(); onOpenTag(t.identifier); } : undefined}
               className={`text-2xs font-mono font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-400 ${onOpenTag ? 'cursor-pointer hover:brightness-95' : ''}`} title={`Основной тег ${t.identifier}`}>{t.identifier}</span>
           ))}
           {!item.isFolder && (item.additionalTags || []).map((t: any) => (
             <span key={t.id} className="text-2xs font-mono px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400" title={`Доп. тег ${t.identifier}`}>{t.identifier}</span>
           ))}
           {(item.isFolder || (!(item.mainTags || []).length && !(item.additionalTags || []).length)) && (
             <span className="text-slate-400 dark:text-slate-455">—</span>
           )}
         </div>
      </td>
      <td className="flux-cell hidden @[1000px]:table-cell text-xs text-slate-500 dark:text-dark-text-muted">{!item.isFolder && item.department !== 'Unassigned' ? item.department : ''}</td>
    </tr>
  );
});

export const FileCardItem = React.memo(({
  item,
  isSelected,
  isRenaming,
  isCut,
  renameValue,
  onRenameValueChange,
  onRenameSubmit,
  onCancelRename,
  onClick,
  onDoubleClick,
  onContextMenu,
  onDragStart,
  onDropItems,
  loaded,
  foreign,
  catLabel
}: any) => {
  const isImage = item.type === 'IMAGE' || (item.name && item.name.match(/\.(jpeg|jpg|gif|png|webp)$/i));
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragOver={(e) => {
        if (item.isFolder) {
          e.preventDefault();
          e.currentTarget.classList.add('bg-emerald-100');
        }
      }}
      onDragLeave={(e) => {
          if (item.isFolder) e.currentTarget.classList.remove('bg-emerald-150');
      }}
      onDrop={(e) => {
         if (!item.isFolder) return;
         e.preventDefault();
         e.stopPropagation();
         e.currentTarget.classList.remove('bg-emerald-100');
         onDropItems(e, item.id);
      }}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      className={`w-28 flex flex-col items-center gap-2 p-2 rounded border border-transparent cursor-default transition-ui ${isSelected ? 'bg-emerald-105 dark:bg-emerald-950/35 border-emerald-300 dark:border-emerald-800' : 'hover:bg-slate-100 dark:hover:bg-dark-panel hover:border-slate-200 dark:hover:border-dark-border'} ${isCut ? 'opacity-50' : ''}`}
    >
       <div className="w-16 h-16 flex items-center justify-center relative select-none">
         {item.isFolder ? (
           <Folder className="w-16 h-16 text-amber-500 fill-amber-200 shrink-0" />
         ) : isImage && item.content ? (
           <img src={item.content} alt={item.name} className="max-w-full max-h-full object-cover rounded shadow-xs border border-slate-200" referrerPolicy="no-referrer" />
         ) : (
           getFileIcon(item, "w-12 h-12")
         )}
         {!item.isFolder && item.statusCode && (
            <span className={`absolute bottom-0 right-0 w-3 h-3 rounded-full ring-2 ring-white dark:ring-dark-bg ${statusOf(item.statusCode).dot}`} title={statusOf(item.statusCode).label} />
         )}
         {loaded && (
            <span
              className="absolute -top-1 -right-1 inline-flex items-center gap-0.5 text-2xs font-bold px-1 py-0.5 rounded-full bg-emerald-600 text-white shadow"
              title={`Данные загружены в оборудование: ${catLabel(loaded.category)} (ревизия v${loaded.version})`}
            >
              <Boxes className="w-2.5 h-2.5" />v{loaded.version}
            </span>
         )}
       </div>
       
       {isRenaming ? (
         <input 
           type="text"
           autoFocus
           value={renameValue}
           onChange={e => onRenameValueChange(e.target.value)}
           onBlur={() => onRenameSubmit(item.id, !item.isFolder, renameValue)}
           onKeyDown={e => {
             if (e.key === 'Enter') onRenameSubmit(item.id, !item.isFolder, renameValue);
             if (e.key === 'Escape') onCancelRename();
           }}
           onClick={e => e.stopPropagation()}
           className="border border-emerald-405 px-1 py-0 text-sm outline-none w-full text-center mt-1 bg-white dark:bg-slate-900 text-slate-900 dark:text-white select-text"
         />
       ) : (
         <span className="text-sm font-medium text-slate-700 dark:text-slate-300 text-center line-clamp-2 break-all">{item.name}</span>
       )}
       {foreign && !isRenaming && (
         <span
           className="max-w-full truncate text-2xs font-semibold px-1.5 py-0.5 rounded-full
                      bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-350
                      border border-slate-200 dark:border-slate-700"
           title={`Из проекта «${foreign}». Открывается вместе с переключением проекта.`}
         >
           {foreign}
         </span>
       )}
    </div>
  );
});
