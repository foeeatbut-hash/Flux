import { create } from 'zustand';
import { EMPTY_WORKSPACE, localDisplayAreas, type DisplayWorkspace } from '../../workspace/displays';
import { BAR_H } from '../lib/metrics';

interface DisplayState {
  workspace: DisplayWorkspace; available: boolean; busy: boolean; error: string;
  init: () => (() => void); setAllMonitors: (enabled: boolean) => Promise<void>;
}
const bridge = () => (window as any).electron?.displays;
export const useDisplayStore = create<DisplayState>((set, get) => ({
  workspace: EMPTY_WORKSPACE, available: false, busy: false, error: '',
  init: () => {
    const api = bridge();
    if (!api) return () => {};
    let alive = true;
    const apply = (workspace: DisplayWorkspace) => { if (alive) set({ workspace, available: true, error: '' }); };
    void api.get().then(apply).catch((e: Error) => { if (alive) set({ error: e.message }); });
    const unsubscribe = api.onChanged(apply);
    return () => { alive = false; unsubscribe?.(); };
  },
  setAllMonitors: async enabled => {
    if (get().busy) return;
    set({ busy: true, error: '' });
    try { set({ workspace: await bridge().set(enabled) }); }
    catch (e) { set({ error: e instanceof Error ? e.message : 'Не удалось изменить режим мониторов.' }); }
    finally { set({ busy: false }); }
  },
}));
export const workspaceAreas = (workspace: DisplayWorkspace) => localDisplayAreas(workspace, BAR_H);
