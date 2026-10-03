import React, { useEffect, useState } from 'react';
import { ConnectionPanel } from './ConnectionPanel';

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
  const [startupFailure, setStartupFailure] = useState<{ code?: string; error?: string } | null>(null);
  const [repairBusy, setRepairBusy] = useState(false);
  const [repairError, setRepairError] = useState('');

  useEffect(() => {
    let cancelled = false;
    const startedAt = Date.now();
    // Удалённый сервер либо отвечает сразу, либо недоступен — ждём недолго;
    // встроенному даём время на первый запуск (миграции БД на слабой машине)
    const failAfterMs = 120000;

    const finish = () => {
      if (cancelled) return;
      // Сервер уже был готов при первом же опросе (dev-режим, обычный браузер) —
      // убираем заставку мгновенно, без прощальной анимации и мигания
      const instant = Date.now() - startedAt < 400;
      try { (window as any).__bootSplashDone?.(instant); } catch (_) { /* заставки уже нет (HMR) */ }
      setPhase('ready');
    };

    const fail = (failure?: { code?: string; error?: string }) => {
      if (cancelled) return;
      if (failure) setStartupFailure(failure);
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
        if (r.status === 503) {
          const failure = await r.json().catch(() => null);
          if (failure?.code === 'LOCAL_DATABASE_UNAVAILABLE' || failure?.code === 'REMOTE_DATABASE_UNAVAILABLE') {
            fail(failure);
            return;
          }
        }
      } catch (_) { /* сервер ещё не слушает порт — ждём */ }
      if (cancelled) return;
      if (Date.now() - startedAt > failAfterMs) { fail(); return; }
      setTimeout(check, 800);
    };
    check();

    return () => { cancelled = true; };
  }, []);

  const chooseAnotherLocalDatabase = async () => {
    const bridge = (window as any).electron?.ipcRenderer;
    if (!bridge?.invoke) { setRepairError('Выбрать файл можно только в установленной программе Flux.'); return; }
    setRepairBusy(true); setRepairError('');
    try {
      const selected = await bridge.invoke('database:select-file');
      if (!selected) return;
      const saved = await bridge.invoke('app:set-local-database-path', String(selected));
      if (!saved?.success) throw new Error(saved?.error || 'Не удалось сохранить новый путь базы.');
      await bridge.invoke('app:relaunch');
    } catch (error: any) {
      setRepairError(error?.message || 'Не удалось выбрать другую базу. Исходные файлы сохранены.');
    } finally { setRepairBusy(false); }
  };

  if (phase === 'failed') {
    return (
      <div className="w-full h-full flex items-center justify-center bg-slate-950 p-6">
        <div className="max-w-md w-full bg-slate-900 border border-slate-800 rounded-lg p-7 text-center space-y-4">
          <div className="text-base font-semibold text-white">
            Не удалось подключить Flux
          </div>
          <p className="text-sm text-slate-400 leading-relaxed">
            {startupFailure?.error || 'Проверьте локальную базу данных или подключение к MariaDB/MySQL.'} Исходный файл и журналы SQLite остаются на месте. Подробности запуска: AppData/pdm-app/server-startup.log.
          </p>
          <div className="flex items-center justify-center gap-3 pt-1">
            <button type="button"
              onClick={() => window.location.reload()}
              className="h-9 px-4 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium transition-colors cursor-pointer"
            >
              Повторить
            </button>
            <button type="button" disabled={repairBusy}
              onClick={() => void chooseAnotherLocalDatabase()}
              className="h-9 px-4 rounded-md border border-slate-700 hover:bg-slate-800 text-slate-200 text-sm font-medium transition-colors cursor-pointer disabled:opacity-50"
            >
              {repairBusy ? 'Открываю…' : 'Выбрать другую локальную базу'}
            </button>

          </div>
          {repairError && <p className="text-sm text-rose-300" role="alert">{repairError}</p>}
          <ConnectionPanel />
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
