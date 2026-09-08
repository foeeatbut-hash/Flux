/**
 * Меню правой кнопки в Проводнике: по файлу, по папке, по пустому месту.
 *
 * Вынесено из экрана целиком, а не «чтобы было меньше строк»: меню — это
 * перечень того, что вообще можно сделать с выделенным, и держать его рядом с
 * загрузкой файлов и деревом папок значило искать его среди них.
 *
 * Пункты «Открыть» и «Открыть в» строятся по общей таблице сопоставлений
 * (lib/fileTypes) — той же, по которой открывает значок на рабочем столе.
 */
import React from 'react';
import {
  Folder, FolderOpen, FolderPlus, File as FileIcon, FileText, Grid3X3, Upload, RefreshCw,
  Copy, ClipboardPaste, Scissors, Download, Tag, Shield, Info, Boxes, Edit2, Trash2, Link2,
} from 'lucide-react';
import { appsFor, type FileLike } from '../../lib/fileTypes';

export interface ExplorerMenuState {
  x: number;
  y: number;
  targetId?: string;
  isFile?: boolean;
  isContainer?: boolean;
  isSection?: boolean;
}

export interface ExplorerMenuProps {
  menu: ExplorerMenuState;
  /** Файл или папка, по которой нажали, — из текущего списка */
  target?: FileLike & { name?: string };
  /** Открыта ли эта папка сейчас: «Открыть» саму себя не предлагаем */
  currentFolderId: string | null;
  /** Есть ли что вставить */
  hasClipboard: boolean;
  /** Можно ли редактировать копию файла в Конструкторе (по имени) */
  canEditInConstructor: boolean;
  onClose: () => void;
  open: (id: string) => void;
  /** «Открыть в: …» — адрес выбранной программы */
  openWith: (href: string, appId: string) => void;
  openFolder: (id: string) => void;
  refresh: () => void;
  createFolder: () => void;
  createDoc: (kind: 'DOC' | 'TEXT') => void;
  createTxt: () => void;
  upload: () => void;
  paste: () => void;
  editCopy: (id: string) => void;
  toEquipment: (id: string) => void;
  attachVdr: (id: string) => void;
  download: (id: string) => void;
  assignTag: (id: string) => void;
  assignDepartment: (id: string) => void;
  changeStatus: (id: string) => void;
  cut: () => void;
  copy: () => void;
  rename: (id: string, isFile: boolean) => void;
  properties: (id: string, isFile: boolean) => void;
  /** Карточка связей: где эта вещь встречается во всём проекте */
  links: (id: string, isFile: boolean) => void;
  remove: (id: string, isFile: boolean) => void;
}

const Item = ({ icon, label, onClick }: { icon: React.ReactElement; label: string; onClick: () => void }) => (
  <button type="button" onClick={onClick}
    className="w-full flex items-center gap-3 px-6 py-1 hover:bg-[#91C9F7] dark:hover:bg-dark-surface/80
               transition-colors text-slate-800 dark:text-dark-text-main focus:outline-none">
    {React.cloneElement(icon as any, { className: 'w-4 h-4 text-slate-600 dark:text-dark-text-muted' })}
    <span>{label}</span>
  </button>
);

const Sep = () => <div className="h-px bg-slate-300 dark:bg-dark-border my-1 mx-2" />;

export default function ExplorerMenu(p: ExplorerMenuProps) {
  const { menu, target } = p;
  const id = menu.targetId || '';
  const isFile = !!menu.isFile;
  const others = isFile ? appsFor(target || { id }).slice(1) : [];

  return (
    <div
      className="fixed z-50 bg-[#F2F2F2] dark:bg-dark-panel border border-slate-300 dark:border-dark-border
                 shadow-md py-1 min-w-[220px] text-xs text-slate-800 dark:text-dark-text-main rounded-lg"
      style={{ top: menu.y, left: menu.x }}
      onClick={(e) => e.stopPropagation()}
    >
      {menu.isSection ? (
        <>
          <Item icon={<Folder />} label="Открыть" onClick={() => { p.openFolder(id); p.onClose(); }} />
          <Item icon={<RefreshCw />} label="Обновить" onClick={() => { p.refresh(); p.onClose(); }} />
          <Sep />
          <div className="px-6 py-1 text-2xs text-slate-400 select-none">
            Встроенный раздел: нельзя удалить или переименовать
          </div>
        </>
      ) : menu.isContainer ? (
        <>
          {/* «Создать» — как в Windows: правый клик по пустому месту */}
          <div className="px-6 py-1 text-2xs font-bold uppercase tracking-wider text-slate-400 select-none">Создать</div>
          <Item icon={<FolderPlus />} label="Папку" onClick={() => { p.createFolder(); p.onClose(); }} />
          <Item icon={<Grid3X3 />} label="Таблицу (Excel)" onClick={() => { p.createDoc('DOC'); p.onClose(); }} />
          <Item icon={<FileText />} label="Документ (Word)" onClick={() => { p.createDoc('TEXT'); p.onClose(); }} />
          <Item icon={<FileIcon />} label="Текстовый файл (.txt)" onClick={() => { p.createTxt(); p.onClose(); }} />
          <Sep />
          <Item icon={<Upload />} label="Загрузить" onClick={() => { p.upload(); p.onClose(); }} />
          {p.hasClipboard && <Item icon={<Copy />} label="Вставить" onClick={() => { p.paste(); p.onClose(); }} />}
          <Item icon={<RefreshCw />} label="Обновить" onClick={() => { p.refresh(); p.onClose(); }} />
        </>
      ) : (
        <>
          {!!id && p.currentFolderId !== id && !isFile && (
            <Item icon={<Folder />} label="Открыть" onClick={() => { p.openFolder(id); p.onClose(); }} />
          )}
          {isFile && (
            <>
              {/* Выбора нет — нет и второго пункта: «Открыть в» с одной строкой,
                  ведущей туда же, куда «Открыть», был бы обманом выбора */}
              <Item icon={<FolderOpen />} label="Открыть" onClick={() => { p.open(id); p.onClose(); }} />
              {others.map((app) => (
                <Item key={app.id} icon={<FolderOpen />} label={`Открыть в: ${app.name}`}
                  onClick={() => { p.openWith(app.href({ ...(target || {}), id }), app.id); p.onClose(); }} />
              ))}
              <Sep />
              {p.canEditInConstructor && (
                <Item icon={<Grid3X3 />} label="Редактировать копию в Flux Office"
                  onClick={() => { p.editCopy(id); p.onClose(); }} />
              )}
              <Item icon={<Boxes />} label="В оборудование…" onClick={() => { p.toEquipment(id); p.onClose(); }} />
              <Item icon={<Grid3X3 />} label="Прикрепить к строке ВДР…" onClick={() => { p.attachVdr(id); p.onClose(); }} />
              <Sep />
              <Item icon={<Download />} label="Скачать" onClick={() => { p.download(id); p.onClose(); }} />
              <Item icon={<Tag />} label="Назначить теги..." onClick={() => { p.assignTag(id); p.onClose(); }} />
              <Item icon={<Shield />} label="Назначить отдел..." onClick={() => { p.assignDepartment(id); p.onClose(); }} />
              <Item icon={<Info />} label="Статус документа..." onClick={() => { p.changeStatus(id); p.onClose(); }} />
            </>
          )}
          <Sep />
          <Item icon={<Scissors />} label="Вырезать" onClick={() => { p.cut(); p.onClose(); }} />
          <Item icon={<Copy />} label="Копировать" onClick={() => { p.copy(); p.onClose(); }} />
          {p.hasClipboard && !isFile && (
            <Item icon={<ClipboardPaste />} label="Вставить" onClick={() => { p.paste(); p.onClose(); }} />
          )}
          <Item icon={<Edit2 />} label="Переименовать" onClick={() => { p.rename(id, isFile); p.onClose(); }} />
          <Item icon={<Link2 />} label="Карточка связей" onClick={() => { p.links(id, isFile); p.onClose(); }} />
          <Item icon={<Info />} label="Свойства" onClick={() => { p.properties(id, isFile); p.onClose(); }} />
          <Item icon={<Trash2 />} label="Удалить" onClick={() => { p.remove(id, isFile); p.onClose(); }} />
        </>
      )}
    </div>
  );
}
