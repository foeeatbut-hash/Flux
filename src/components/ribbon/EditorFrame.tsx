/**
 * Обвязка редактора целиком: полоса вкладок со сведениями о документе, лента,
 * полотно и строка состояния.
 *
 * Все четыре редактора собираются этим компонентом, поэтому высоты заданы один
 * раз (lib/ribbon) и не могут разойтись. Полотно — children: что внутри, рама
 * не знает и знать не должна.
 *
 * Отдельной строки документа больше нет: она повторяла заголовок окна, который
 * и так показывает имя документа, и отбирала у листа 34 точки. Её кнопки
 * переехали по краям полосы вкладок — та наполовину пустовала.
 */
import React from 'react';
import RibbonBar, { type RibbonBarProps } from './RibbonBar';
import { DocIdentity, DocStatus, type DocRowProps } from './DocRow';
import FileMenu from './FileMenu';
import { STATUS_H, type FileMenuSection } from '../../lib/ribbon';

export interface EditorFrameProps extends Omit<RibbonBarProps, 'onFile'> {
  doc: DocRowProps;
  /** Разделы меню «Файл». Пусто — кнопки «Файл» не будет */
  file?: FileMenuSection[];
  fileInfo?: { label: string; value: string }[];
  fileOpen: boolean;
  onFileOpen: (v: boolean) => void;
  /** Строка состояния: слева — про содержимое, справа — про вид */
  statusLeft?: React.ReactNode;
  statusRight?: React.ReactNode;
  children: React.ReactNode;
}

export default function EditorFrame({
  doc, file, fileInfo, fileOpen, onFileOpen, statusLeft, statusRight, children, ...ribbon
}: EditorFrameProps) {
  return (
    <div className="h-full flex flex-col relative bg-white dark:bg-slate-950">
      <RibbonBar {...ribbon}
        docLeft={<DocIdentity {...doc} />}
        docRight={<DocStatus {...doc} />}
        onFile={file?.length ? () => onFileOpen(true) : undefined} />
      <div className="flex-1 min-h-0 relative">{children}</div>
      {(statusLeft || statusRight) && (
        <div className="flex items-center gap-3 px-3 shrink-0 border-t border-slate-200 dark:border-slate-800
                        bg-white dark:bg-slate-900 text-[10px] text-slate-500 dark:text-slate-400"
          style={{ height: STATUS_H }}>
          <span className="truncate">{statusLeft}</span>
          <span className="flex-1" />
          <span className="shrink-0 flex items-center gap-2">{statusRight}</span>
        </div>
      )}
      {fileOpen && file?.length && (
        <FileMenu sections={file} info={fileInfo} onClose={() => onFileOpen(false)} />
      )}
    </div>
  );
}
