/**
 * Меню правой кнопки черновика (лист «States») и его клавиши.
 *
 * Пунктов восемь, а не семь, как требует общее правило меню: их порядок и
 * состав утверждены владельцем на макете, и три группы разделены чертой.
 */
import { ExternalLink, FolderOpen, Info, Pencil, Pin, PinOff, Trash2, Upload, FilePlus2, FileText } from 'lucide-react';
import type React from 'react';
import type { WindowsDraftEntry } from '../../../filesystem/contracts';
import type { MenuItem } from '../ContextMenu';
import { useDraftsSettings } from '../../store/draftsSettingsStore';
import { openDraft, publishToProject, renameDraft, showInExplorer, showProperties, togglePin, trashDraft } from './draftsOps';

export function draftMenuItems(entry: WindowsDraftEntry, pinned: boolean): MenuItem[] {
  return [
    { label: 'Открыть', hint: 'Enter', icon: entry.kind === 'directory' ? <FolderOpen /> : <FileText />, onClick: () => openDraft(entry) },
    { label: 'Опубликовать в проект…', hint: 'Ctrl+P', icon: <Upload />, separated: true, onClick: () => void publishToProject([entry]) },
    // ВДР хранит серверный идентификатор файла, у черновика его нет: добавить можно только опубликованный файл.
    { label: 'Добавить в ВДР…', icon: <FilePlus2 />, disabled: true, title: 'Доступно после публикации: ВДР хранит опубликованные файлы' },
    { label: pinned ? 'Открепить' : 'Закрепить первым', icon: pinned ? <PinOff /> : <Pin />, onClick: () => togglePin(entry) },
    { label: 'Переименовать', hint: 'F2', icon: <Pencil />, separated: true, onClick: () => void renameDraft(entry) },
    { label: 'Показать в Проводнике', icon: <ExternalLink />, onClick: () => showInExplorer(entry) },
    { label: 'Свойства', hint: 'Alt+Enter', icon: <Info />, onClick: () => showProperties(entry) },
    { label: 'Удалить', hint: 'Del', icon: <Trash2 />, danger: true, separated: true, onClick: () => void trashDraft(entry) },
  ];
}

/** Клавиши на выбранной плитке или строке; true — нажатие обработано. */
export function draftKey(entry: WindowsDraftEntry, event: React.KeyboardEvent): boolean {
  const key = event.key;
  if (key === 'Enter' && event.altKey) showProperties(entry);
  else if (key === 'Enter') openDraft(entry);
  else if (key === 'F2') void renameDraft(entry);
  else if (key === 'Delete') void trashDraft(entry);
  else if (event.ctrlKey && event.code === 'KeyP') void publishToProject([entry]);
  else return false;
  event.preventDefault();
  return true;
}

export const isPinned = (entry: WindowsDraftEntry) => !!entry.draftId && useDraftsSettings.getState().pinned.includes(entry.draftId);
