import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { TRANSITION } from '../../lib/motion';
import { AlertCircle, Sun, Moon } from 'lucide-react';

/**
 * Рамка окна входа: фон-«миллиметровка», переключатель темы, карточка с
 * заголовком и ошибкой, место под панель подключения и строка с версией.
 * Одна и та же у Flux и Flux Studio — менять вид входа нужно только здесь.
 */
interface LoginFrameProps {
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  title: string;
  version: string;
  error?: string;
  errorTitle?: string;
  /** Под карточкой: панель подключения к базе */
  below?: React.ReactNode;
  children: React.ReactNode;
}

export default function LoginFrame({ theme, onToggleTheme, title, version, error = '', errorTitle = 'Ошибка авторизации', below, children }: LoginFrameProps) {
  return (
    <div
      id="login-screen-root"
      className="login-ground min-h-screen w-full flex flex-col justify-between font-sans text-slate-800 dark:text-slate-100 transition-colors duration-200 relative p-4"
    >
      {/* Floating theme switcher in upper-right corner */}
      <div className="absolute top-4 right-4 z-40">
        <button
          type="button"
          onClick={onToggleTheme}
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
          initial={{ opacity: 0, scale: 0.98, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={TRANSITION.enter}
          className="w-full max-w-md bg-white dark:bg-slate-900 rounded-sm border border-slate-300 dark:border-slate-700 shadow-modal transition-ui"
        >
          <div className="flex items-baseline gap-3 px-6 py-3 border-b border-slate-300 dark:border-slate-700">
            <span className="text-sm font-semibold tracking-tight">{title}</span>
          </div>
          <div className="p-6">
          <AnimatePresence mode="wait">
            {error && (
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                transition={TRANSITION.enter}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, transition: TRANSITION.exit }}
                className="flex items-start gap-2.5 p-3.5 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-700 dark:text-rose-400 text-xs mb-5"
              >
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <div>
                  <p className="font-semibold">{errorTitle}</p>
                  <p className="mt-0.5 opacity-90">{error}</p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {children}
          </div>
        </motion.div>
      </div>

      {/* Сотрудники подключаются к API сервера компании без реквизитов БД. */}
      {below}

      {/* Версия сборки помогает сообщить поддержку, какая программа установлена. */}
      <div className="w-full flex items-center justify-between gap-3 px-4 py-4 mt-auto">
        <div className="text-xs text-slate-400 dark:text-slate-500">
          Разработка <span className="font-semibold text-slate-500 dark:text-slate-400">Раупова Хусрава</span>
        </div>
        <div className="data text-2xs text-slate-400 dark:text-slate-500">
          {version}
        </div>
      </div>
    </div>
  );
}
