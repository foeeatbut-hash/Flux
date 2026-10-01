import React, { useState, useEffect } from 'react';
import { useStore } from '../store/store';
import { useToastStore } from '../store/toastStore';
import { dataService } from '../services/dataService';
import { motion, AnimatePresence } from 'motion/react';
import { Lock, User, Eye, EyeOff, Loader2, AlertCircle, Sun, Moon } from 'lucide-react';
import { setAuthToken, markSessionEstablished } from '../config/env';
import ConnectionPanel from '../components/ConnectionPanel';
import OwnerLogin from '../components/OwnerLogin';

interface LoginProps {
  onConfigureDatabase?: () => void;
}

export default function Login({ onConfigureDatabase }: LoginProps) {
  const setUser = useStore((state) => state.setUser);
  const theme = useStore((state) => state.theme);
  const toggleTheme = useStore((state) => state.toggleTheme);
  const { addToast } = useToastStore();
  
  const [remember, setRemember] = useState(() => {
    return localStorage.getItem('login_remember') === 'true';
  });
  const [login, setLogin] = useState(() => {
    const isRemembered = localStorage.getItem('login_remember') === 'true';
    return isRemembered ? localStorage.getItem('login_saved_username') || '' : '';
  });
  // Пароль в localStorage больше не храним (небезопасно): «запомнить» = логин,
  // а сессия и так живёт по токену без повторного входа. Старое значение подчищаем.
  const [password, setPassword] = useState('');
  useEffect(() => {
    try { localStorage.removeItem('login_saved_password'); } catch (_) {}
  }, []);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
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
    <div 
      id="login-screen-root" 
      className="login-ground min-h-screen w-full flex flex-col justify-between font-sans text-slate-800 dark:text-slate-100 transition-colors duration-250 relative p-4"
    >
      {/* Floating theme switcher in upper-right corner */}
      <div className="absolute top-4 right-4 z-40">
        <button
          type="button"
          onClick={toggleTheme}
          className="fx-btn fx-btn-icon"
          title="Переключить тему"
          aria-label="Переключить тему"
        >
          {theme === 'dark' ? <Sun className="w-5 h-5 text-amber-500" /> : <Moon className="w-5 h-5 text-emerald-600" />}
        </button>
      </div>

      {/* Spacing element to align content nicely and push version down */}
      <div className="flex-1 flex items-center justify-center py-12">
        <motion.div 
          initial={{ opacity: 0, scale: 0.98, y: 15 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          className="w-full max-w-md bg-white dark:bg-slate-900 rounded-sm border border-slate-300 dark:border-slate-700 shadow-modal transition-ui"
        >
          {/* Штамп листа: слева — что это за программа, справа — шифр версии */}
          <div className="flex items-baseline gap-3 px-6 py-3 border-b border-slate-300 dark:border-slate-700">
            <span className="text-sm font-semibold tracking-tight">Flux</span>
            <span className="graf">рабочее место инженера</span>
            <span className="ml-auto data text-2xs text-slate-400">{__APP_VERSION__}</span>
          </div>
          <div className="p-6">
          <AnimatePresence mode="wait">
            {error && (
              <motion.div
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="flex items-start gap-2.5 p-3.5 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-700 dark:text-rose-400 text-xs mb-5"
              >
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <div>
                  <p className="font-semibold">Ошибка авторизации</p>
                  <p className="mt-0.5 opacity-90">{error}</p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <form onSubmit={handleLogin} className="space-y-5">
            <div>
              <label className="block text-xs font-semibold text-slate-550 dark:text-slate-400 mb-1.5 label-login">
                Логин
              </label>
              <div className="relative group">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400 dark:text-slate-500 group-focus-within:text-emerald-650 dark:group-focus-within:text-emerald-400 transition-colors">
                  <User className="w-4 h-4" />
                </div>
                <input
                  id="login-input"
                  type="text"
                  autoFocus
                  value={login}
                  onChange={(e) => setLogin(e.target.value)}
                  className="w-full pl-9 pr-3 py-2.5 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-sm text-slate-800 dark:text-white placeholder-slate-450 dark:placeholder-slate-650 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-ui font-sans"
                  placeholder="Введите логин"
                  required
                  disabled={isLoading}
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-550 dark:text-slate-400 mb-1.5 label-password">
                Пароль
              </label>
              <div className="relative group">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400 dark:text-slate-500 group-focus-within:text-emerald-650 dark:group-focus-within:text-emerald-400 transition-colors">
                  <Lock className="w-4 h-4" />
                </div>
                <input
                  id="password-input"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full pl-9 pr-10 py-2.5 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-sm text-slate-800 dark:text-white placeholder-slate-450 dark:placeholder-slate-650 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-ui font-sans"
                  placeholder="Введите пароль"
                  required
                  disabled={isLoading}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute inset-y-0 right-0 pr-3 flex items-center text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <div className="flex items-center justify-between py-1 select-none">
              <label htmlFor="remember-me-checkbox" className="flex items-center gap-2 cursor-pointer text-xs font-semibold text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 transition-colors">
                <input
                  id="remember-me-checkbox"
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                  className="w-4 h-4 rounded-sm border-slate-300 dark:border-slate-800 text-emerald-600 focus:ring-emerald-500 bg-slate-50 dark:bg-slate-950 accent-emerald-500 transition-ui cursor-pointer"
                />
                <span>Запомнить данные для входа</span>
              </label>
            </div>

            <button
              id="submit-button"
              type="submit"
              disabled={isLoading}
              className="w-full h-11 bg-emerald-700 hover:bg-emerald-600 active:bg-emerald-850 disabled:bg-emerald-800/50 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-lg shadow-md hover:shadow-lg transition-ui flex items-center justify-center gap-2 cursor-pointer mt-6"
            >
              {isLoading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Вход в систему...</span>
                </>
              ) : (
                <span>Войти</span>
              )}
            </button>
          </form>
          <OwnerLogin />
          </div>
        </motion.div>
      </div>

      {/* Сотрудники подключаются к API сервера компании без реквизитов БД. */}
      <ConnectionPanel />

      {/* Footer: авторство слева, версия справа */}
      <div className="w-full flex items-center justify-between gap-3 px-4 py-4 mt-auto">
        <div className="text-xs text-slate-400 dark:text-slate-500">
          Разработка <span className="font-semibold text-slate-500 dark:text-slate-400">Раупова Хусрава</span>
        </div>
        <div className="data text-2xs text-slate-400 dark:text-slate-500">
          {new Date().getFullYear()}
        </div>
      </div>
    </div>
  );
}
