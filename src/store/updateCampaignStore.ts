import { create } from 'zustand';
import { useStore } from './store';
import { useUpdateStore } from './updateStore';
import { updateService } from '../services/updateService';
import { isNewer } from '../lib/updates';

export interface AssignedUpdate { id: string; action: 'schedule' | 'cancel'; version: string; deadline: number; remainingMs: number }
interface CampaignState { assigned: AssignedUpdate | null; connectionError: string; tick: number; poll: () => Promise<void>; reset: () => void }
let polling = false;
let lastAttempt = 0;
let remaining = 0, sampled = 0, assignmentId = '';
export const useUpdateCampaignStore = create<CampaignState>((set, get) => ({
  assigned: null, connectionError: '', tick: 0,
  reset: () => { assignmentId = ''; remaining = 0; lastAttempt = 0; set({ assigned: null, connectionError: '' }); },
  poll: async () => {
    if (polling) return;
    const userId = useStore.getState().user?.id, e = (window as any).electron;
    if (!userId || !e?.updateHeartbeatProof) return;
    polling = true;
    const active = () => useStore.getState().user?.id === userId;
    try {
      const update = useUpdateStore.getState(), old = get().assigned;
      const status = old?.action === 'cancel' ? 'cancelled' : old && !isNewer(old.version, update.current) ? 'updated'
        : update.error ? 'delayed' : update.phase === 'saving' ? 'saving' : update.phase === 'installing' ? 'restarting'
        : update.phase === 'ready' ? 'ready' : ['downloading', 'verifying'].includes(update.phase) ? update.phase : old ? 'delivered' : 'idle';
      const proof = await e.updateHeartbeatProof({ userId, status, commandId: old?.id || null, code: update.error ? 'SAVE_OR_UPDATE_BLOCKED' : '' });
      if (!active()) return;
      const data = await updateService.request<{ inst: string; commands: unknown[] }>('devices/heartbeat', proof);
      if (!active()) return;
      const assignment: AssignedUpdate | null = await e.acceptUpdateCommands({ inst: data.inst, userId, commands: data.commands });
      if (!active()) return;
      set({ connectionError: '' });
      if (!assignment) return;
      if (assignment.id !== assignmentId) { assignmentId = assignment.id; lastAttempt = 0; remaining = assignment.remainingMs; sampled = performance.now(); }
      else { remaining = Math.min(remaining - Math.max(0, performance.now() - sampled), assignment.remainingMs); sampled = performance.now(); }
      set({ assigned: { ...assignment, remainingMs: Math.max(0, remaining) }, tick: Date.now() });
      if (assignment.action === 'cancel' || !isNewer(assignment.version, update.current)) return;
      if (!update.packaged || !update.portable) { set({ connectionError: 'Автоматическое обновление недоступно в этом запуске программы.' }); return; }
      if (update.latest?.version !== assignment.version) {
        if (['downloading', 'verifying', 'saving', 'installing'].includes(update.phase)) return;
        const release = await updateService.request<any>(`check/${encodeURIComponent(assignment.version)}`);
        if (!active()) return;
        if (!release.ok) { set({ connectionError: 'Назначенный выпуск сейчас недоступен. Обновление отложено.' }); return; }
        useUpdateStore.setState({ latest: { version: assignment.version, signature: release.signature,
          changelog: '', fileUrl: `/api/updates/download/${assignment.version}`, size: release.size }, phase: 'available', error: '' });
      }
      if (Date.now() - lastAttempt < 60000) return;
      lastAttempt = Date.now();
      const ready = await useUpdateStore.getState().prepare();
      if (!active() || get().assigned?.id !== assignment.id || !ready) return;
      remaining -= Math.max(0, performance.now() - sampled); sampled = performance.now();
      if (remaining <= 0) await useUpdateStore.getState().install(assignment.id);
    } catch (err: any) {
      if (active()) set({ connectionError: err?.message || 'Состояние обновления недоступно. Повторим проверку.' });
    } finally { polling = false; }
  },
}));
