import React, { useEffect } from 'react';
import { Download, RefreshCw } from 'lucide-react';
import { Dialog, Btn } from './ui';
import { useUpdateStore } from '../store/updateStore';
import { useUpdateCampaignStore } from '../store/updateCampaignStore';
import { useStore } from '../store/store';
import { phaseLabel, fileUrlOf, isNewer } from '../lib/updates';
import { getServerBaseUrl } from '../config/env';
import { useToastStore } from '../store/toastStore';
import { useNotificationStore } from '../store/notificationStore';
import { updateService } from '../services/updateService';

const claimedEvents = new WeakSet<Event>();
let dialogOpen = false;
export function claimUpdateDialogOpen(event: Event): boolean {
  if (claimedEvents.has(event) || dialogOpen) return false;
  claimedEvents.add(event); dialogOpen = true; return true;
}
let mounts = 0, timer: ReturnType<typeof setInterval> | null = null;
let lastCheck = 0, lastShown = 0, lastUser = '', running = false;
const REMINDER_MS = 10 * 60000;
const publishedUpdates = () => { lastCheck = 0; void tickUpdates(); };

async function tickUpdates() {
  if (running) return;
  const userId = useStore.getState().user?.id;
  if (!userId) return;
  running = true;
  try {
    if (lastUser !== userId) {
      lastUser = userId; lastCheck = 0; useUpdateCampaignStore.getState().reset();
      try { lastShown = Number(localStorage.getItem(`flux.update.reminder.${userId}`)) || 0; } catch { lastShown = 0; }
    }
    await useUpdateStore.getState().init(typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0');
    if (Date.now() - lastCheck >= 5 * 60000) { lastCheck = Date.now(); await useUpdateStore.getState().check(true); }
    await useUpdateCampaignStore.getState().poll();
    if (useStore.getState().user?.id !== userId) return;
    const update = useUpdateStore.getState(), campaign = useUpdateCampaignStore.getState();
    if (update.latest && !update.error && !campaign.connectionError && ['available', 'ready'].includes(update.phase)
      && Date.now() - lastShown >= REMINDER_MS) {
      const reminder = await updateService.request<{ reminded: boolean; shownAt: number }>('reminder', { version: update.latest.version });
      if (useStore.getState().user?.id !== userId) return;
      lastShown = reminder.shownAt;
      try { localStorage.setItem(`flux.update.reminder.${userId}`, String(lastShown)); } catch { /* таймер памяти продолжает действовать */ }
      if (reminder.reminded) await useNotificationStore.getState().fetch(userId);
    }
  } catch { /* Ошибка связи не создаёт частые повторные напоминания. */ lastShown = Date.now(); }
  finally { running = false; }
}

/** Одна проверка и один таймер на приложение, даже когда панель показана на каждом мониторе. */
export function useUpdateReminders() {
  const userId = useStore(s => s.user?.id);
  useEffect(() => {
    mounts++;
    if (!timer) timer = setInterval(() => { void tickUpdates(); }, 10000);
    if (mounts === 1) { window.addEventListener('socket:app:update-published', publishedUpdates); window.addEventListener('socket:app:update-assigned', publishedUpdates); }
    return () => {
      mounts--;
      if (!mounts) {
        if (timer) clearInterval(timer); timer = null;
        window.removeEventListener('socket:app:update-published', publishedUpdates); window.removeEventListener('socket:app:update-assigned', publishedUpdates);
        useUpdateCampaignStore.getState().reset();
      }
    };
  }, []);
  useEffect(() => { void tickUpdates(); }, [userId]);
}

export default function UpdateDialog({ onClose }: { onClose: () => void }) {
  const update = useUpdateStore(), assigned = useUpdateCampaignStore(s => s.assigned);
  const connectionError = useUpdateCampaignStore(s => s.connectionError);
  const [seconds, setSeconds] = React.useState(assigned ? Math.ceil(assigned.remainingMs / 1000) : 0);
  const mandatory = assigned?.action === 'schedule' && isNewer(assigned.version, update.current);
  useEffect(() => {
    dialogOpen = true; update.markSeen();
    return () => { dialogOpen = false; };
  }, []);
  useEffect(() => {
    const start = performance.now(), initial = assigned?.remainingMs || 0;
    const clock = setInterval(() => setSeconds(Math.max(0, Math.ceil((initial - performance.now() + start) / 1000))), 1000);
    setSeconds(Math.ceil(initial / 1000)); return () => clearInterval(clock);
  }, [assigned?.id, assigned?.remainingMs]);
  const busy = ['downloading', 'verifying', 'saving', 'installing'].includes(update.phase);
  const install = async () => {
    if ((window as any).electron) { await update.install(mandatory ? assigned?.id : undefined); return; }
    if (!update.latest) return;
    try {
      const res = await fetch(fileUrlOf(update.latest.fileUrl, getServerBaseUrl() || window.location.origin));
      if (!res.ok) throw new Error('Файл обновления недоступен.');
      const url = URL.createObjectURL(await res.blob()), link = document.createElement('a');
      link.href = url; link.download = `Flux-${update.latest.version}.exe`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (e: any) { useToastStore.getState().addToast(e.message || 'Не удалось скачать обновление.', 'error'); }
  };
  return <Dialog title={`Обновление Flux${update.latest ? ` · ${update.latest.version}` : ''}`} label="Обновление Flux" width="max-w-lg" onClose={onClose}
    footer={<><Btn onClick={onClose}>Позже</Btn>{update.latest && <Btn tone="primary" disabled={busy || !!connectionError} onClick={() => void install()}><Download />{mandatory ? 'Обновить сейчас' : (window as any).electron ? 'Обновить' : 'Скачать файл'}</Btn>}</>}>
    <div data-tour="app-update-dialog">
      <p className="fx-hint">Сейчас работает версия {update.current}.</p>
      {mandatory && <p className="fx-note fx-note-warn my-3">Программа обновится {seconds > 0 ? `через ${Math.floor(seconds / 60)} мин ${seconds % 60} с` : 'после сохранения документов'}. Завершите работу и сохраните документы.</p>}
      <div className="fx-label mt-3">Что изменилось</div>
      <div className="whitespace-pre-line max-h-[45vh] overflow-y-auto">{update.latest?.changelog || 'Описание изменений не указано.'}</div>
      {!!update.latest?.size && <p className="fx-hint mt-2">Размер загрузки: {(update.latest.size / 1048576).toFixed(1)} МБ.</p>}
      <p className="fx-hint mt-3">После сохранения документов программа закроется и откроется снова.</p>
      {busy && <p className="fx-hint mt-3"><RefreshCw className="inline w-3.5 h-3.5 mr-2 animate-spin" />{phaseLabel(update.phase, update.percent)}</p>}
      {update.phase === 'ready' && <p className="fx-hint mt-3">Файл готов к установке.</p>}
      {(update.error || connectionError) && <p className="fx-error mt-3" role="status">{update.error || connectionError}</p>}
    </div>
  </Dialog>;
}
