/**
 * Действия панели «Черновики» над одним черновиком или над набором: не React,
 * только мост, хранилища и уведомления. Меню, клавиши и «Разобрать старые»
 * вызывают одни и те же функции, поэтому ведут себя одинаково.
 */
import type { WindowsDraftEntry } from '../../../filesystem/contracts';
import { dragItem, draftRef } from '../../lib/draftsActions';
import { fileRefHref, folderRefHref, windowsFilesRequest } from '../../lib/windowsFiles';
import { useDraftsSettings } from '../../store/draftsSettingsStore';
import { useDraftsPanelStore } from '../../store/draftsPanelStore';
import { useDraftsPublishStore } from '../../store/draftsPublishStore';
import { useFluxSaveStore } from '../../store/fluxSaveStore';
import { useModalStore } from '../../store/modalStore';
import { useToastStore } from '../../store/toastStore';
import { useWindowStore } from '../../store/windowStore';
import { validateName } from '../files/createEntry';

const toast = (message: string, type: 'success' | 'error' | 'info' = 'info') => useToastStore.getState().addToast(message, type);
const reload = () => void useDraftsPanelStore.getState().reload();

export const openDraft = (entry: WindowsDraftEntry) => useWindowStore.getState().open(fileRefHref(draftRef(entry), { folder: entry.kind === 'directory' }));
export const showInExplorer = (entry: WindowsDraftEntry) => useWindowStore.getState().open(folderRefHref(entry.parent));
export const showProperties = (entry: WindowsDraftEntry) => useWindowStore.getState().open(fileRefHref(draftRef(entry), { properties: true }));

export function togglePin(entry: WindowsDraftEntry) {
  const id = entry.draftId;
  if (!id) return;
  const { pinned, set } = useDraftsSettings.getState();
  set({ pinned: pinned.includes(id) ? pinned.filter((item) => item !== id) : [...pinned, id] });
}

export async function renameDraft(entry: WindowsDraftEntry) {
  const name = await useModalStore.getState().openPrompt('Переименовать', undefined, 'Имя', entry.name);
  if (name === null || name.trim() === entry.name) return;
  const problem = validateName(name);
  if (problem) { toast(problem, 'error'); return; }
  const answer = await windowsFilesRequest({ action: 'rename', ref: draftRef(entry), name: name.trim() });
  if ('error' in answer) toast(answer.error.message, 'error'); else reload();
}

/** Корзина Flux: черновик можно вернуть, поэтому без вопроса — как Del в Проводнике. */
export async function trashDraft(entry: WindowsDraftEntry): Promise<boolean> {
  const answer = await windowsFilesRequest({ action: 'trash', ref: draftRef(entry) });
  if ('error' in answer) { toast(answer.error.message, 'error'); return false; }
  toast(`В корзине Flux: «${entry.name}»`, 'success');
  reload();
  return true;
}

/** «Опубликовать в проект…»: папку выбирают тем же окном, что при сохранении из программ. */
export async function publishToProject(entries: WindowsDraftEntry[]) {
  const parent = await useFluxSaveStore.getState().pickFolder({ title: 'Опубликовать в проект', confirmLabel: 'Опубликовать сюда' });
  if (parent) useDraftsPublishStore.getState().ask({ items: entries.map(dragItem), parent, keepCopy: false });
}

/** Без выбора папки: «Отобразить в Windows» там, где черновик лежит. */
export const publishInPlace = (entries: WindowsDraftEntry[]) => useDraftsPublishStore.getState().ask({ items: entries.map(dragItem), parent: null, keepCopy: false });

/** «Оставить все» в разборе: напоминание о них молчит, сами они остаются в панели. */
export function keepDrafts(entries: WindowsDraftEntry[]) {
  const { kept, set } = useDraftsSettings.getState();
  set({ kept: [...new Set([...kept, ...entries.map((entry) => entry.draftId || '').filter(Boolean)])].slice(-500) });
}

export async function trashDrafts(entries: WindowsDraftEntry[]) {
  const ok = await useModalStore.getState().openConfirm('Удалить черновики?', `В корзину Flux уйдёт черновиков: ${entries.length}. Их можно вернуть оттуда.`, { confirmLabel: 'Удалить', tone: 'danger' });
  if (!ok) return;
  let failed = 0;
  for (const entry of entries) {
    const answer = await windowsFilesRequest({ action: 'trash', ref: draftRef(entry) });
    if ('error' in answer) failed++;
  }
  toast(failed ? `В корзину ушло ${entries.length - failed} из ${entries.length}. Остальные остались в панели.` : `В корзине Flux: ${entries.length}`, failed ? 'error' : 'success');
  reload();
}
