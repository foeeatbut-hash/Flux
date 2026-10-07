/**
 * Помощник сбоку: рама вокруг общего разговора.
 *
 * Сам разговор — components/assistant/Chat: он же стоит в окне программы
 * (screens/AssistantScreen). Панель нужна там, где окон нет вовсе (панельная
 * оболочка), и когда спросить надо на секунду, не заводя окна.
 *
 * Панель всегда лежит поверх содержимого и никогда не отжимает его. Сначала
 * она отжимала всегда (при окне 1024 разделу оставалось 492 точки, и таблицы
 * уходили в прокрутку), потом — только на широком окне; но и тогда открытый
 * помощник менял ширину панели задач под собой. Опора оболочки не двигается от
 * того, что рядом что-то открыли.
 */
import React from 'react';
import { useAssistantStore } from '../store/assistantStore';
import { useWindowStore } from '../store/windowStore';
import ArtShelf from './ArtShelf';
import Chat from './assistant/Chat';

export default function AssistantPanel() {
  const isOpen = useAssistantStore((s) => s.isOpen);
  const setOpen = useAssistantStore((s) => s.setOpen);

  /** Разговор переезжает в окно: тот же разговор, просто ему стало тесно */
  const toWindow = () => {
    setOpen(false);
    useWindowStore.getState().open('/assistant');
  };

  // Где стоит панель и сколько ей места — решает правая колонка
  // (components/RightDock): панелей две, и делить колонку они обязаны вместе,
  // а не каждая по-своему. Здесь остаётся только содержимое
  if (!isOpen) return null;

  return (
    <div className="h-full w-full flex flex-col bg-white dark:bg-slate-900">
      <div className="h-full flex flex-col">
        <ArtShelf onClose={() => setOpen(false)} onExpand={toWindow} />

        <div className="flex-1 min-h-0">
          <Chat compact />
        </div>
      </div>
    </div>
  );
}
