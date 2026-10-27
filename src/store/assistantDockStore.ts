/**
 * Открыта ли панель помощника справа.
 *
 * Отдельное маленькое хранилище, а не поле в notificationStore: помощник не
 * имеет отношения к уведомлениям, а открывать его просят из трея, из
 * демонстраций и из горячих клавиш — всем им нужно одно общее «открыто ли».
 */
import { create } from 'zustand';

interface AssistantDockState {
  open: boolean;
  setOpen: (v: boolean) => void;
  toggle: () => void;
}

export const useAssistantDockStore = create<AssistantDockState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open })),
}));
