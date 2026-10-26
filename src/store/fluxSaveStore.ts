/**
 * Очередь запросов к окну «Сохранить в Проводнике Flux».
 *
 * Выгружают файлы из десятков мест, и многие из них — обычные асинхронные
 * функции без интерфейса (сборка книги, затем «положить на диск»). Поэтому
 * окно вызывается как функция, которая возвращает обещание, а показывает его
 * один общий узел в оболочке (FluxSaveHost). Запросы идут по очереди: два
 * окна поверх друг друга человеку не нужны.
 */
import { create } from 'zustand';
import type { WindowsFileRef } from '../lib/windowsFiles';

export interface SaveFileOutcome {
  ok: boolean;
  /** Куда легло, в виде «Документы\Отчёты\Смета.xlsx» */
  path: string;
  /** Человек передумал: ругаться не надо */
  canceled: boolean;
  error: string;
}

export type FluxSaveRequest =
  | { id: number; mode: 'file'; title: string; name: string; bytes: Uint8Array; dir: string; resolve: (value: SaveFileOutcome) => void }
  | { id: number; mode: 'folder'; title: string; confirmLabel: string; resolve: (value: WindowsFileRef | null) => void };

interface FluxSaveState {
  queue: FluxSaveRequest[];
  saveFile: (options: { name: string; bytes: Uint8Array; dir?: string; title?: string }) => Promise<SaveFileOutcome>;
  pickFolder: (options?: { title?: string; confirmLabel?: string }) => Promise<WindowsFileRef | null>;
  done: (id: number) => void;
}

let counter = 0;

export const useFluxSaveStore = create<FluxSaveState>((set) => ({
  queue: [],
  saveFile: ({ name, bytes, dir = '', title = 'Сохранить в Проводнике Flux' }) =>
    new Promise<SaveFileOutcome>(resolve => {
      set(state => ({ queue: [...state.queue, { id: ++counter, mode: 'file', title, name, bytes, dir, resolve }] }));
    }),
  pickFolder: ({ title = 'Выбрать папку', confirmLabel = 'Выбрать эту папку' } = {}) =>
    new Promise<WindowsFileRef | null>(resolve => {
      set(state => ({ queue: [...state.queue, { id: ++counter, mode: 'folder', title, confirmLabel, resolve }] }));
    }),
  done: id => set(state => ({ queue: state.queue.filter(item => item.id !== id) })),
}));
