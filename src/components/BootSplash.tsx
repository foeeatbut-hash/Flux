import React, { useEffect, useState } from 'react';
import { getConfiguredServerUrl, setConfiguredServerUrl, SERVER_BASE_URL } from '../config/env';

// ── Гейт готовности сервера ──
// Стартовая заставка (#boot-splash) целиком живёт в index.html: разметка —
// сиблинг #root, прогресс и статусы ведёт инлайн-скрипт с первой отрисовки
// страницы. React её НЕ пересоздаёт — интро идёт одной непрерывной анимацией.
// Задача ServerGate — дождаться сервера (/api/health), затем погасить заставку
// через window.__bootSplashDone и отрисовать приложение. Если сервер так и не
// ответил (удалённый недоступен / встроенный не поднялся) — честный экран
// ошибки с кнопками вместо вечной заставки.
export function ServerGate({ children }: { children: React.ReactNode }) {
  const [phase, setPhase] = useState<'waiting' | 'ready' | 'failed'>('waiting');
  const isRemote = !!getConfiguredServerUrl();

  useEffect(() => {
    let cancelled = false;
    const startedAt = Date.now();
    // Удалённый сервер либо отвечает сразу, либо недоступен — ждём недолго;
    // встроенному даём время на первый запуск (миграции БД на слабой машине)
    const failAfterMs = isRemote ? 25000 : 120000;

    const finish = () => {
      if (cancelled) return;
      // Сервер уже был готов при первом же опросе (dev-режим, обычный браузер) —
      // убираем заставку мгновенно, без прощальной анимации и мигания
      const instant = Date.now() - startedAt < 400;
      try { (window as any).__bootSplashDone?.(instant); } catch (_) { /* заставки уже нет (HMR) */ }
      setPhase('ready');
    };

    const fail = () => {
      if (cancelled) return;
      try { (window as any).__bootSplashDone?.(true); } catch (_) {}
      setPhase('failed');
    };

    const check = async () => {
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 2500);
        const r = await fetch('/api/health', { signal: ctl.signal });
        clearTimeout(timer);
        if (r.ok) { finish(); return; }
      } catch (_) { /* сервер ещё не слушает порт — ждём */ }
      if (cancelled) return;
      if (Date.now() - startedAt > failAfterMs) { fail(); return; }
      setTimeout(check, 800);
    };
    check();

    return () => { cancelled = true; };
  }, [isRemote]);

  if (phase === 'failed') {
    return (
      <div className="w-full h-full flex items-center justify-center bg-slate-950 p-6">
        <div className="max-w-md w-full bg-slate-900 border border-slate-800 rounded-lg p-7 text-center space-y-4">
          <div className="text-base font-semibold text-white">
            {isRemote ? 'Сервер компании не отвечает' : 'Не удалось запустить встроенный сервер'}
          </div>
          <p className="text-sm text-slate-400 leading-relaxed">
            {isRemote
              ? <>Адрес: <span className="font-mono text-slate-300">{SERVER_BASE_URL}</span>.
                 Проверьте, что сервер запущен и доступен по сети.</>
              : 'Попробуйте перезапустить приложение. Если не помогает — посмотрите лог запуска (AppData/pdm-app/server-startup.log).'}
          </p>
          <div className="flex items-center justify-center gap-3 pt-1">
            <button type="button"
              onClick={() => window.location.reload()}
              className="h-9 px-4 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium transition-colors cursor-pointer"
            >
              Повторить
            </button>
            {isRemote && (
              <button type="button"
                onClick={async () => { await setConfiguredServerUrl(''); window.location.reload(); }}
                className="px-5 py-2.5 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 text-sm font-semibold transition-colors cursor-pointer"
              >
                Встроенный сервер
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Пока сервер поднимается, ничего не рисуем — весь экран занимает заставка
  // из index.html. Когда готов — приложение монтируется сразу, а заставка
  // растворяется НАД ним, плавно открывая экран входа.
  if (phase !== 'ready') return null;
  return <>{children}</>;
}
