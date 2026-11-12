import { create } from 'zustand';
import { EMPTY_WORKSPACE, localDisplayAreas, type DisplayWorkspace } from '../../workspace/displays';
interface DisplayState {
  workspace: DisplayWorkspace; available: boolean; busy: boolean; error: string;
  /** «Нажатие по столу не выводит Flux поверх других программ» (только Windows) */
  desk: { available: boolean; enabled: boolean };
  init: () => (() => void); setAllMonitors: (enabled: boolean) => Promise<void>;
  setDeskStaysBack: (enabled: boolean) => Promise<void>;
}
const bridge = () => (window as any).electron?.displays;
const deskBridge = () => (window as any).electron?.deskFocus;
export const useDisplayStore = create<DisplayState>((set, get) => ({
  workspace: EMPTY_WORKSPACE, available: false, busy: false, error: '', desk: { available: false, enabled: false },
  init: () => {
    const api = bridge();
    if (!api) return () => {};
    let alive = true;
    const apply = (workspace: DisplayWorkspace) => { if (alive) set({ workspace, available: true, error: '' }); };
    void api.get().then(apply).catch((e: Error) => { if (alive) set({ error: e.message }); });
    void deskBridge()?.get().then((desk: { available: boolean; enabled: boolean }) => { if (alive) set({ desk }); }).catch(() => {});
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
  setDeskStaysBack: async enabled => {
    try { set({ desk: await deskBridge().set(enabled), error: '' }); }
    catch (e) { set({ error: e instanceof Error ? e.message : 'Не удалось изменить настройку стола.' }); }
  },
}));
/** Taskbars auto-hide, so maximized Flux windows use the selected OS work area. */
export const workspaceAreas = (workspace: DisplayWorkspace) => localDisplayAreas(workspace, 0);
