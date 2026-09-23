import React from 'react';
import { useNavigate } from 'react-router-dom';
import { canOpenApp } from '../lib/appPolicy';
import { useAppContext } from '../store/policyStore';
import { usePlayStore } from '../store/playStore';
import { useToastStore } from '../store/toastStore';
import { dataService } from '../services/dataService';

/**
 * Приглашение в игру — даже когда раздел не открыт.
 *
 * Сокет доставляет событие только тем, кто подключён к тому же встроенному
 * серверу, а у каждого сотрудника сервер свой. Поэтому приглашение с соседнего
 * компьютера до человека не доходило: он узнавал о нём, только открыв раздел.
 * Здесь снимок платформы перечитывается раз в пятнадцать секунд, и новое
 * приглашение показывается уведомлением со ссылкой в раздел.
 *
 * Для сотрудника без доступа здесь не происходит ничего: ни запроса, ни следа
 * — платформы для него нет, и спрашивать о ней нечего.
 */
export default function PlayInviteWatcher() {
  const ctx = useAppContext();
  const open = canOpenApp(ctx);
  const navigate = useNavigate();
  const invites = usePlayStore((s) => s.invites);
  const seen = React.useRef<Set<string>>(new Set());
  const names = React.useRef<Record<string, string> | null>(null);

  React.useEffect(() => {
    if (!open) { seen.current = new Set(); return; }
    void usePlayStore.getState().refresh({ quiet: true });
    const t = setInterval(() => { void usePlayStore.getState().refresh({ quiet: true }); }, 15_000);
    return () => clearInterval(t);
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    const fresh = (invites || []).filter((i: any) => i?.id && !seen.current.has(i.id));
    if (!fresh.length) return;
    for (const i of fresh) seen.current.add(i.id);
    void (async () => {
      if (!names.current) {
        try {
          const list: any[] = await dataService.getUsers();
          names.current = Object.fromEntries(list.map((u) => [u.id, u.name || u.login || 'Коллега']));
        } catch (_) { names.current = {}; }
      }
      for (const i of fresh as any[]) {
        const who = names.current?.[i.fromUserId] || 'Коллега';
        useToastStore.getState().addToast(
          `${who} зовёт вас в Flux Play — нажмите, чтобы открыть`,
          'info',
          () => navigate('/play'),
        );
      }
    })();
  }, [invites, open, navigate]);

  return null;
}
