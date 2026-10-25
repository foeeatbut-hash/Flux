import React from 'react';
import { ArrowLeft, ChevronRight } from 'lucide-react';
import { FileIcon } from '../icons/FluxIcons';
import { ICON_SIZE } from '../../lib/metrics';
import type { WindowsRoot } from '../../lib/windowsFiles';

/**
 * Строка навигации окон выбора Проводника Flux: диск, «Вверх» и путь крошками.
 * Одна для «Выбрать файл» и «Сохранить в…», чтобы окна выглядели и вели себя
 * одинаково.
 */
export default function FluxFolderNav({ roots, rootId, folder, busy, onRoot, onFolder, extra }: {
  roots: WindowsRoot[]; rootId: string; folder: string; busy: boolean;
  onRoot: (id: string) => void; onFolder: (relativePath: string) => void;
  /** Кнопки справа в той же строке (например, «Новая папка») */
  extra?: React.ReactNode;
}) {
  const crumbs = folder.split('/').filter(Boolean);
  const root = roots.find(item => item.id === rootId);
  return <div className="flex flex-col gap-2">
    <div className="flex items-center gap-2">
      <FileIcon kind="drive" size={ICON_SIZE.row} />
      <select aria-label="Папка Windows" className="fx-input min-w-0 flex-1" value={rootId} disabled={busy} onChange={event => onRoot(event.target.value)}>
        {roots.map(item => <option key={item.id} value={item.id}>{item.name}{item.network ? ' · сеть' : ''}</option>)}
      </select>
      {extra}
    </div>
    <nav aria-label="Путь к папке" className="flex min-w-0 flex-wrap items-center gap-1 text-xs">
      <button type="button" className="fx-btn fx-btn-sm" disabled={!folder || busy} onClick={() => onFolder(crumbs.slice(0, -1).join('/'))}><ArrowLeft className="h-3 w-3" />Вверх</button>
      <button type="button" disabled={busy} className="rounded px-1 py-1 hover:bg-slate-100 disabled:opacity-50 dark:hover:bg-slate-800" onClick={() => onFolder('')}>{root?.name || 'Компьютер'}</button>
      {crumbs.map((part, index) => <React.Fragment key={`${index}:${part}`}><ChevronRight className="h-3 w-3 text-slate-400" /><button type="button" disabled={busy} className="max-w-40 truncate rounded px-1 py-1 hover:bg-slate-100 disabled:opacity-50 dark:hover:bg-slate-800" onClick={() => onFolder(crumbs.slice(0, index + 1).join('/'))}>{part}</button></React.Fragment>)}
    </nav>
  </div>;
}
