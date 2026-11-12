import React, { useState } from 'react';
import LoginFrame from '../../../src/components/auth/LoginFrame';
import LoginForm, { type LoginFormValues } from '../../../src/components/auth/LoginForm';
import OwnerLoginPanel, { type OwnerLoginApi } from '../../../src/components/auth/OwnerLoginPanel';
import { DatabaseButton } from '../../../src/components/auth/DatabaseUriForm';
import { type Snapshot } from '../call';

/**
 * Второй шаг: вход логином и паролем Flux или «Входом владельца» файлом ключа — тот же экран и тот же порядок, что у
 * Flux (src/screens/Login.tsx). Право на Studio проверяет сервер; окно только показывает его ответ.
 */
const REMEMBER = 'studio_login_remember';
const SAVED = 'studio_login_saved_username';

const ownerApi: OwnerLoginApi = {
  selectKey: async () => {
    const reply = await window.studio.call<{ canceled: boolean; name?: string; ok?: false; error?: string }>('ownerSelectKey');
    if (!reply.ok) throw new Error(reply.error);
    return reply.value;
  },
  signIn: async () => { /* заменяется ниже: вход обновляет состояние окна */ },
};

export default function LoginScreen({ state, onDone, onBack, theme, onToggleTheme }: { state: Snapshot; onDone: (s: Snapshot) => void; onBack: () => void; theme: 'light' | 'dark'; onToggleTheme: () => void }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  let remembered = false, savedLogin = '';
  try { remembered = localStorage.getItem(REMEMBER) === 'true'; savedLogin = remembered ? localStorage.getItem(SAVED) || '' : ''; } catch { /* приватный режим */ }
  const submit = async ({ login, password, remember }: LoginFormValues) => {
    setBusy(true); setError('');
    const reply = await window.studio.call<Snapshot>('login', { symbol: login, password });
    setBusy(false);
    if (!reply.ok) { setError(reply.error); return; }
    try {
      if (remember) { localStorage.setItem(REMEMBER, 'true'); localStorage.setItem(SAVED, login); }
      else { localStorage.removeItem(REMEMBER); localStorage.removeItem(SAVED); }
    } catch { /* приватный режим */ }
    onDone(reply.value);
  };
  const owner: OwnerLoginApi = {
    ...ownerApi,
    signIn: async (password: string) => {
      const reply = await window.studio.call<Snapshot>('ownerLogin', { password });
      if (!reply.ok) throw new Error(reply.error);
      onDone(reply.value);
    },
  };
  return (
    <LoginFrame theme={theme} onToggleTheme={onToggleTheme} title={state.name} version={state.version} error={error} errorRole="alert"
      below={<div className="w-full flex flex-col items-center gap-2 pb-1"><DatabaseButton expanded={false} label={`База · ${state.display.replace(/^MariaDB \/ MySQL · /, '')}`} onClick={onBack} /></div>}>
      <LoginForm initialLogin={savedLogin} initialRemember={remembered} busy={busy} onSubmit={values => void submit(values)} />
      <OwnerLoginPanel api={owner} />
    </LoginFrame>
  );
}
