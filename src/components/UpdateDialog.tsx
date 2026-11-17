import React, { useEffect } from 'react';
import { Download, RefreshCw } from 'lucide-react';
import { Dialog, Btn } from './ui';
import { useUpdateStore, selectOffer } from '../store/updateStore';
import { useUpdateCampaignStore } from '../store/updateCampaignStore';
import { useStore } from '../store/store';
import { phaseLabel, fileUrlOf, needsInstall } from '../lib/updates';
import { reminderPlan, readPostponed, writePostponed } from '../lib/updateReminder';
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
let lastCheck = 0, lastAssigned = 0, retryAt = 0, lastUser = '', running = false;
/** Когда напоминали о каждой версии: новое назначение напоминает сразу, а не ждёт суток после прежнего */
const shown = new Map<string, number>();
const shownKey = (userId: string, version: string) => `flux.update.reminder.${userId}.${version}`;
const readShown = (userId: string, version: string) => {
  const key = shownKey(userId, version);
  if (!shown.has(key)) { try { shown.set(key, Number(localStorage.getItem(key)) || 0); } catch { shown.set(key, 0); } }
  return shown.get(key)!;
};
const writeShown = (userId: string, version: string, at: number) => {
  shown.set(shownKey(userId, version), at);
  try { localStorage.setItem(shownKey(userId, version), String(at)); } catch { /* таймер памяти продолжает действовать */ }
};
/** Номер запуска программы: «Позже» напоминает при следующем запуске, то есть при другом номере */
const SESSION = Math.random().toString(36).slice(2);
/** Назначенное спрашиваем раз в минуту, а при событии сервера — сразу */
const ASSIGNED_EVERY_MS = 60000;
const publishedUpdates = () => { lastCheck = 0; void tickUpdates(); };
const assignedUpdates = () => { lastAssigned = 0; void tickUpdates(); };

/** «Позже»: обычное обновление откладывается, обязательное — нет (у него этой кнопки нет) */
export function postponeUpdate(userId: string, version: string) {
  writePostponed(userId, { version, at: Date.now(), session: SESSION });
}

async function tickUpdates() {
  if (running) return;
  const userId = useStore.getState().user?.id;
  if (!userId) return;
  running = true;
  try {
    if (lastUser !== userId) {
      lastUser = userId; lastCheck = 0; lastAssigned = 0; useUpdateCampaignStore.getState().reset();
    }
    await useUpdateStore.getState().init(typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0');
    if (Date.now() - lastCheck >= 5 * 60000) { lastCheck = Date.now(); await useUpdateStore.getState().check(true); }
    if (Date.now() - lastAssigned >= ASSIGNED_EVERY_MS) { lastAssigned = Date.now(); await useUpdateStore.getState().refreshAssigned(); }
    await useUpdateCampaignStore.getState().poll();
    if (useStore.getState().user?.id !== userId) return;
    const update = useUpdateStore.getState(), campaign = useUpdateCampaignStore.getState(), offer = selectOffer(update);
    // Напоминаем только о назначенном этому сотруднику: «последняя версия» напоминания не создаёт
    if (offer && !update.error && !campaign.connectionError && needsInstall(offer, update.current)) {
      const plan = reminderPlan({ now: Date.now(), lastShown: readShown(userId, offer.version), postponed: readPostponed(userId), session: SESSION, version: offer.version });
      if (plan !== 'none' && Date.now() >= retryAt) {
        const reminder = await updateService.request<{ reminded: boolean; shownAt: number }>('reminder', { version: offer.version, launch: plan === 'launch' });
        if (useStore.getState().user?.id !== userId) return;
        writeShown(userId, offer.version, reminder.shownAt);
        const postponed = readPostponed(userId);
        // Отсчёт «Позже» идёт заново от этого напоминания и в этом запуске
        if (postponed) writePostponed(userId, { ...postponed, at: Date.now(), session: SESSION });
        if (reminder.reminded) await useNotificationStore.getState().fetch(userId);
      }
    }
  } catch { /* Ошибка связи не создаёт частые повторные напоминания: пробуем снова через пять минут */ retryAt = Date.now() + 5 * 60000; }
  finally { running = false; }
}

/** Одна проверка и один таймер на приложение, даже когда панель показана на каждом мониторе. */
export function useUpdateReminders() {
  const userId = useStore(s => s.user?.id);
  useEffect(() => {
    mounts++;
    if (!timer) timer = setInterval(() => { void tickUpdates(); }, 10000);
    if (mounts === 1) { window.addEventListener('socket:app:update-published', publishedUpdates); window.addEventListener('socket:app:update-assigned', assignedUpdates); }
    return () => {
      mounts--;
      if (!mounts) {
        if (timer) clearInterval(timer); timer = null;
        window.removeEventListener('socket:app:update-published', publishedUpdates); window.removeEventListener('socket:app:update-assigned', assignedUpdates);
        useUpdateCampaignStore.getState().reset();
      }
    };
  }, []);
  useEffect(() => { void tickUpdates(); }, [userId]);
}

export default function UpdateDialog({ onClose }: { onClose: () => void }) {
  const update = useUpdateStore(), assigned = useUpdateCampaignStore(s => s.assigned), offer = useUpdateStore(selectOffer);
  const connectionError = useUpdateCampaignStore(s => s.connectionError);
  const userId = useStore(s => s.user?.id);
  const [seconds, setSeconds] = React.useState(assigned ? Math.ceil(assigned.remainingMs / 1000) : 0);
  // Обязательное — подписанное задание владельца со сроком: отложить его нельзя
  const mandatory = offer?.source === 'campaign' && !!assigned && assigned.action === 'schedule' && needsInstall(assigned, update.current);
  const rollback = !!offer?.rollback;
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
  const later = () => { if (userId && offer) postponeUpdate(userId, offer.version); onClose(); };
  const install = async () => {
    if (!offer) return;
    if ((window as any).electron) { await update.install(mandatory ? offer.campaignId : undefined, offer); return; }
    try {
      const res = await fetch(fileUrlOf(offer.fileUrl, getServerBaseUrl() || window.location.origin));
      if (!res.ok) throw new Error('Файл обновления недоступен.');
      const url = URL.createObjectURL(await res.blob()), link = document.createElement('a');
      link.href = url; link.download = `Flux-${offer.version}.exe`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (e: any) { useToastStore.getState().addToast(e.message || 'Не удалось скачать обновление.', 'error'); }
  };
  return <Dialog title={`Обновление Flux${offer ? ` · ${offer.version}` : ''}`} label="Обновление Flux" width="max-w-lg" onClose={onClose}
    footer={<>{!mandatory && <Btn onClick={later}>Позже</Btn>}{offer && <Btn tone="primary" disabled={busy || !!connectionError} onClick={() => void install()}><Download />{rollback ? 'Вернуть версию' : mandatory ? 'Обновить сейчас' : (window as any).electron ? 'Обновить' : 'Скачать файл'}</Btn>}</>}>
    <div data-tour="app-update-dialog">
      <p className="fx-hint">Сейчас работает версия {update.current}.</p>
      {!offer && <p className="fx-hint mt-3">Для вас обновление не назначено. Любую опубликованную версию можно поставить в настройках.</p>}
      {rollback && <p className="fx-note fx-note-warn my-3">Владелец вернул предыдущую версию Flux: программа заменится версией {offer?.version}. Отложить это нельзя.</p>}
      {mandatory && !rollback && <p className="fx-note fx-note-warn my-3">Обязательное обновление: отложить его нельзя.</p>}
      {mandatory && <p className="fx-note fx-note-warn my-3">Программа обновится {seconds > 0 ? `через ${Math.floor(seconds / 60)} мин ${seconds % 60} с` : 'после сохранения документов'}. Завершите работу и сохраните документы.</p>}
      {offer && !rollback && <><div className="fx-label mt-3">Что изменилось</div>
      <div className="whitespace-pre-line max-h-[45vh] overflow-y-auto">{offer.changelog || 'Описание изменений не указано.'}</div></>}
      {!!offer?.size && <p className="fx-hint mt-2">Размер загрузки: {(offer.size / 1048576).toFixed(1)} МБ.</p>}
      {offer && <p className="fx-hint mt-3">Перед обновлением сохраните всё нужное: программа закроется и откроется снова.</p>}
      {offer && !mandatory && <p className="fx-hint mt-3">Если нажать «Позже», напоминание придёт при следующем запуске Flux, но не чаще раза в сутки.</p>}
      {busy && <p className="fx-hint mt-3"><RefreshCw className="inline w-3.5 h-3.5 mr-2 animate-spin" />{phaseLabel(update.phase, update.percent)}</p>}
      {update.phase === 'ready' && <p className="fx-hint mt-3">Файл готов к установке.</p>}
      {(update.error || connectionError) && <p className="fx-error mt-3" role="status">{update.error || connectionError}</p>}
    </div>
  </Dialog>;
}
