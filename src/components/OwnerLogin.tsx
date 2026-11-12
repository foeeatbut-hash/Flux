import React from 'react';
import { getServerBaseUrl, setAuthToken } from '../config/env';
import { useStore } from '../store/store';
import OwnerLoginPanel, { type OwnerLoginApi } from './auth/OwnerLoginPanel';

/** Выбор ключа и подпись выполняются в оболочке; содержимое хранилища в React не поступает. */
export default function OwnerLogin() {
  const bridge = (window as any).electron?.ipcRenderer;
  const [revealed, setRevealed] = React.useState(false);
  React.useEffect(() => {
    const reveal = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.shiftKey && event.altKey) setRevealed(true);
    };
    // Сочетание открывает резервный путь только по намеренному действию на экране входа.
    window.addEventListener('keydown', reveal);
    return () => window.removeEventListener('keydown', reveal);
  }, []);
  const api: OwnerLoginApi | null = bridge ? {
    selectKey: () => bridge.invoke('owner:select-key'),
    signIn: async (password: string) => {
      const origin = new URL(getServerBaseUrl() || window.location.origin).origin;
      const challengeResponse = await fetch('/api/owner/challenge', { credentials: 'omit' });
      const challenge = await challengeResponse.json();
      if (!challengeResponse.ok) throw new Error(challenge.error || 'Сервер не разрешил вход владельца.');
      const signed = await bridge.invoke('owner:sign-login', { challenge, serverUrl: origin, password });
      if (signed.ok === false) throw new Error(signed.error);
      const response = await fetch('/api/owner/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nonce: challenge.nonce, sig: signed.sig }) });
      const result = await response.json();
      if (!response.ok || !result.success || !result.token) throw new Error(result.error || result.message || 'Не удалось подтвердить ключ владельца.');
      await setAuthToken(result.token);
      useStore.getState().setUser(result.user);
    },
  } : null;
  if (!revealed) return null;
  return <OwnerLoginPanel api={api} />;
}
