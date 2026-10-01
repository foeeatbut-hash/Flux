import { create } from 'zustand';

export interface TagNavigationTarget {
  projectId: string;
  tagId?: string;
  identifier: string;
}

interface TagNavigationState {
  target: TagNavigationTarget | null;
  open: (target: TagNavigationTarget) => void;
  close: () => void;
}

/** Общая точка входа к сведениям тега из почты, чата и его карточки. */
export const useTagNavigationStore = create<TagNavigationState>((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null }),
}));
