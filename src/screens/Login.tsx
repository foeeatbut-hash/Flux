import React, { useState, useEffect } from 'react';
import { useStore } from '../store/store';
import { useToastStore } from '../store/toastStore';
import { dataService } from '../services/dataService';
import { setAuthToken, markSessionEstablished } from '../config/env';
import ConnectionPanel from '../components/ConnectionPanel';
import OwnerLogin from '../components/OwnerLogin';
import LoginFrame from '../components/auth/LoginFrame';
import LoginForm, { type LoginFormValues } from '../components/auth/LoginForm';

interface LoginProps {
  onConfigureDatabase?: () => void;
}

/** Вид окна входа общий с Flux Studio (src/components/auth); здесь — только вход в Flux по токену сессии. */
export default function Login({ onConfigureDatabase }: LoginProps) {
  const setUser = useStore((state) => state.setUser);
  const theme = useStore((state) => state.theme);
  const toggleTheme = useStore((state) => state.toggleTheme);
  const { addToast } = useToastStore();

  const remembered = localStorage.getItem('login_remember') === 'true';
  const savedLogin = remembered ? localStorage.getItem('login_saved_username') || '' : '';
  // Пароль в localStorage больше не храним (небезопасно): «запомнить» = логин,
  // а сессия и так живёт по токену без повторного входа. Старое значение подчищаем.
  useEffect(() => {
    try { localStorage.removeItem('login_saved_password'); } catch (_) {}
  }, []);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const handleLogin = async ({ login, password, remember }: LoginFormValues) => {
    setError('');
    setIsLoading(true);

    const normUser = login.trim();

    try {
      const data = await dataService.login(normUser, password);
      if (data.success) {
        // Токен сессии — до setUser, чтобы первые же запросы экранов ушли с ним
        await setAuthToken((data as any).token || '');
        markSessionEstablished();
        if (remember) {
          localStorage.setItem('login_remember', 'true');
          localStorage.setItem('login_saved_username', login.trim());
        } else {
          localStorage.removeItem('login_remember');
          localStorage.removeItem('login_saved_username');
        }
        setTimeout(() => {
          setUser(data.user);
          setIsLoading(false);

        }, 400);
      } else {
        const errorMsg = data.message || 'Ошибка входа. Проверьте правильность ввода логина и пароля!';
        setError(errorMsg);
        addToast(errorMsg, 'error');
        setIsLoading(false);
      }
    } catch (err: any) {
      // Сервер отвечает содержательно («неверный пароль», «профиль отключён»)
      // — такие сообщения показываем как есть. Своё, про связь, добавляем
      // только когда ответа не было вовсе.
      const raw = (err?.message || '').trim();
      const looksNetwork = !raw || /failed to fetch|networkerror|load failed|ecconn|timeout/i.test(raw);
      setError(looksNetwork
        ? 'Нет связи с сервером. Проверьте подключение и повторите.'
        : raw.replace(/!+$/, ''));
      setIsLoading(false);
    }
  };

  return (
    <LoginFrame theme={theme} onToggleTheme={toggleTheme} title="Flux" version={__APP_VERSION__} error={error} below={<ConnectionPanel />}>
      <LoginForm initialLogin={savedLogin} initialRemember={remembered} busy={isLoading} onSubmit={values => void handleLogin(values)} />
      <OwnerLogin />
    </LoginFrame>
  );
}
