import React, { useState } from 'react';
import { Server, Laptop, Loader2, Database } from 'lucide-react';
import { getConfiguredServerUrl, setConfiguredServerUrl } from '../config/env';
import { readConnection, probeFluxServer } from '../lib/connection';

async function restart() {
  const shell = (window as any).electron?.ipcRenderer;
  if (shell?.invoke) { await shell.invoke('app:relaunch'); return; }
  window.location.reload();
}

type ConnectionMode = 'server' | 'database';
const isDatabaseUri = (value: string) => /^(mysql|mariadb|postgres|postgresql):\/\//i.test(value.trim());

export default function ConnectionPanel() {
  const [serverUrl] = useState(() => getConfiguredServerUrl());
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<ConnectionMode>(() => isDatabaseUri(serverUrl) || !serverUrl ? 'database' : 'server');
  const [draft, setDraft] = useState(serverUrl);
  const [busy, setBusy] = useState(false);
  const [pendingRestart, setPendingRestart] = useState(false);
  const [error, setError] = useState('');
  const connect = async () => {
    if (!draft.trim()) { setError(mode === 'server' ? 'Введите адрес сервера Flux.' : 'Введите URI общей базы данных.'); return; }
    setBusy(true); setError('');
    try {
      if (mode === 'server') {
        const parsed = readConnection(draft);
        if (parsed.kind === 'error') throw new Error(parsed.error);
        const result = await probeFluxServer(parsed.url);
        if (!result.ready) throw new Error(result.error || 'Не удалось проверить сервер Flux.');
        const previousLocal = localStorage.getItem('flux_server_url');
        await setConfiguredServerUrl(parsed.url);
        const bridge = (window as any).electron?.ipcRenderer;
        if (bridge?.invoke && String(await bridge.invoke('app:get-server-url') || '').trim() !== parsed.url) {
          try { if (previousLocal) localStorage.setItem('flux_server_url', previousLocal); else localStorage.removeItem('flux_server_url'); } catch (_) {}
          throw new Error('Не удалось сохранить настройки подключения. Повторите попытку.');
        }
      } else {
        const bridge = (window as any).electron?.ipcRenderer;
        if (!bridge?.invoke) throw new Error('Настроить общую базу можно только в установленной программе Flux.');
        const result = await bridge.invoke('app:set-database', draft);
        if (!result?.success) throw new Error(result?.error || 'Не удалось сохранить настройки подключения.');
        try { localStorage.removeItem('flux_server_url'); } catch (_) {}
        setDraft('');
      }
      setPendingRestart(true);
    } catch (e: any) { setError(e?.message || 'Не удалось сохранить настройки подключения.'); }
    finally { setBusy(false); }
  };
  const local = async () => {
    setBusy(true); setError('');
    try {
      await setConfiguredServerUrl('');
      const bridge = (window as any).electron?.ipcRenderer;
      if (bridge?.invoke && String(await bridge.invoke('app:get-server-url') || '').trim()) {
        throw new Error('Не удалось сохранить настройки подключения. Повторите попытку.');
      }
      setPendingRestart(true);
    } catch (_) { setError('Не удалось сохранить настройки подключения.'); }
    finally { setBusy(false); }
  };
  const switchMode = (next: ConnectionMode) => {
    if (busy || pendingRestart) return;
    setMode(next);
    setDraft(next === 'server' ? serverUrl : '');
    setError('');
  };
  const updateDraft = (value: string) => {
    if (mode === 'server' && isDatabaseUri(value)) setMode('database');
    setDraft(value);
    setError('');
  };
  return <div className="w-full flex flex-col items-center gap-2 pb-1">
    <button type="button" className="fx-btn fx-btn-quiet max-w-full" aria-expanded={open} disabled={busy} onClick={() => { setOpen(v => !v); setError(''); }}>
      {serverUrl ? <Server className="w-4 h-4 shrink-0" /> : <Laptop className="w-4 h-4 shrink-0" />}
      <span className="truncate">{serverUrl && !isDatabaseUri(serverUrl) ? `Сервер компании · ${serverUrl}` : 'Подключение · Этот компьютер'}</span>
    </button>
    {open && <div className="w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded p-4 space-y-3">
      <div className="fx-segctl" role="group" aria-label="Тип подключения">
        <button type="button" className="fx-seg" aria-pressed={mode === 'server'} disabled={busy || pendingRestart} onClick={() => switchMode('server')}><Server className="w-4 h-4" />Сервер Flux</button>
        <button type="button" className="fx-seg" aria-pressed={mode === 'database'} disabled={busy || pendingRestart} onClick={() => switchMode('database')}><Database className="w-4 h-4" />Общая база данных</button>
      </div>
      <label className="fx-field block"><span className="fx-label block mb-1">{mode === 'server' ? 'Адрес сервера Flux' : 'URI общей базы данных'}</span>
        <input className="fx-input w-full font-mono" type={mode === 'database' ? 'password' : 'text'} value={draft} autoFocus spellCheck={false} autoComplete={mode === 'database' ? 'new-password' : 'off'} disabled={busy || pendingRestart} placeholder={mode === 'server' ? 'https://flux.company.ru' : 'mysql://USER:PASSWORD@HOST:3306/Flux'} onChange={e => updateDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !busy && !pendingRestart) void connect(); }} />
      </label>
      <p className="fx-hint">{mode === 'server'
        ? 'Укажите HTTPS-адрес работающего сервера Flux. Он должен быть уже подключён к базе компании.'
        : 'В общей базе компании работает MariaDB: её URI начинается с mysql://, порт обычно 3306. Flux сохранит адрес для встроенного сервера; при запуске он проверит схему.'}</p>
      {mode === 'server' && <details className="text-xs text-slate-600 dark:text-slate-400"><summary className="cursor-pointer">Как проверить сервер компании</summary><p className="pt-2 leading-relaxed">Откройте в браузере адрес сервера с окончанием /api/health. Рабочий сервер Flux возвращает ok: true и номер version.</p></details>}
      {error && <p className="fx-error" role="alert">{error}</p>}
      {pendingRestart && <p className="fx-hint" role="status">Настройки сохранены. Перезапустите Flux, чтобы применить их.</p>}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {serverUrl && !isDatabaseUri(serverUrl) && mode === 'server' && !pendingRestart && <button type="button" className="fx-btn fx-btn-quiet mr-auto" disabled={busy} onClick={() => void local()}><Laptop className="w-4 h-4" />Этот компьютер</button>}
        <button type="button" className="fx-btn" disabled={busy} onClick={() => setOpen(false)}>Закрыть</button>
        {pendingRestart
          ? <button type="button" className="fx-btn fx-btn-primary" onClick={() => void restart()}>Перезапустить Flux</button>
          : <button type="button" className="fx-btn fx-btn-primary" disabled={busy || !draft.trim()} onClick={() => void connect()}>{busy && <Loader2 className="w-4 h-4 animate-spin" />}{mode === 'server' ? 'Проверить и сохранить' : 'Сохранить подключение'}</button>}
      </div>
    </div>}
  </div>;
}
