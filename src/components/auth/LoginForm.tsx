import React, { useState } from 'react';
import { Lock, User, Eye, EyeOff, Loader2 } from 'lucide-react';

/**
 * Форма входа логином и паролем: общая у Flux и Flux Studio, чтобы окно входа
 * в обеих программах было одним и тем же. Компонент ничего не знает ни о
 * сервере, ни о хранилище сессии — только рисует поля и отдаёт введённое.
 */
export interface LoginFormValues { login: string; password: string; remember: boolean }

interface LoginFormProps {
  initialLogin?: string;
  initialRemember?: boolean;
  busy: boolean;
  onSubmit: (values: LoginFormValues) => void;
  submitLabel?: string;
  busyLabel?: string;
  rememberLabel?: string;
}

export default function LoginForm({ initialLogin = '', initialRemember = false, busy, onSubmit, submitLabel = 'Войти', busyLabel = 'Вход в систему...', rememberLabel = 'Запомнить логин' }: LoginFormProps) {
  const [remember, setRemember] = useState(initialRemember);
  const [login, setLogin] = useState(initialLogin);
  // Пароль нигде не сохраняется: «запомнить» = только логин
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    onSubmit({ login: login.trim(), password, remember });
  };
  return (
          <form onSubmit={submit} className="space-y-5">
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
                  disabled={busy}
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
                  disabled={busy}
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
                <span>{rememberLabel}</span>
              </label>
            </div>

            <button
              id="submit-button"
              type="submit"
              disabled={busy}
              className="w-full h-11 bg-emerald-700 hover:bg-emerald-600 active:bg-emerald-850 disabled:bg-emerald-800/50 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-lg shadow-md hover:shadow-lg transition-ui flex items-center justify-center gap-2 cursor-pointer mt-6"
            >
              {busy ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>{busyLabel}</span>
                </>
              ) : (
                <span>{submitLabel}</span>
              )}
            </button>
          </form>
  );
}
