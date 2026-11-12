import React, { useState } from 'react';
import { readDatabaseConnection } from '../lib/connection';
import DatabaseUriForm, { DatabaseButton } from './auth/DatabaseUriForm';

async function restart() {
  const shell = (window as any).electron?.ipcRenderer;
  if (shell?.invoke) { await shell.invoke('app:relaunch'); return; }
  window.location.reload();
}

export function ConnectionPanel() {
  const [open, setOpen] = useState(false);
  const [database, setDatabase] = useState<{ configured: boolean; provider: 'mysql' | 'unsupported' | null; host: string; database: string } | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [pendingRestart, setPendingRestart] = useState(false);
  const [error, setError] = useState('');

  const connect = async () => {
    const parsed = readDatabaseConnection(draft);
    if (parsed.kind === 'error') { setError(parsed.error); return; }
    const bridge = (window as any).electron?.ipcRenderer;
    if (!bridge?.invoke) { setError('Подключение к общей базе доступно в установленной программе Flux.'); return; }
    setBusy(true); setError('');
    try {
      const probe = await bridge.invoke('app:probe-database', parsed.uri);
      if (!probe?.success) throw new Error(probe?.error || 'Не удалось подключиться к базе. Проверьте адрес и доступ пользователя.');
      const result = await bridge.invoke('app:set-database', parsed.uri);
      if (!result?.success) throw new Error(result?.error || 'Не удалось сохранить настройки подключения.');
      setDraft('');
      setDatabase(await bridge.invoke('app:get-database'));
      setPendingRestart(true);
    } catch (e: any) { setError(e?.message || 'Не удалось подключиться к базе.'); }
    finally { setBusy(false); }
  };

  return <div className="w-full flex flex-col items-center gap-2 pb-1">
    <DatabaseButton expanded={open} disabled={busy} label={database?.configured ? `База · ${database.host}/${database.database}` : 'Подключение к общей базе'} onClick={() => {
      const next = !open;
      setOpen(next); setError('');
      if (next) void (window as any).electron?.ipcRenderer?.invoke('app:get-database').then((result: any) => setDatabase(result)).catch(() => setDatabase(null));
    }} />
    {open && <div className="w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded p-4 space-y-3">
      <DatabaseUriForm
        draft={draft} onDraft={value => { setDraft(value); setError(''); }} busy={busy} locked={pendingRestart} error={error}
        hint={<p className="fx-hint">Укажите адрес общей базы и отдельную учётную запись приложения. Нажмите «Проверить и подключить»; пароль не показывается после сохранения.</p>}
        currentNote={database?.configured ? <p className="fx-hint">Сейчас подключена база {database.host}/{database.database}. Для смены укажите новый URI.</p> : null}
        unsupported={database?.provider === 'unsupported'}
        lockedNote={<p className="fx-hint" role="status">Подключение сохранено. Перезапустите Flux, чтобы применить его.</p>}
        onSubmit={() => void connect()}
        secondary={<button type="button" className="fx-btn" disabled={busy} onClick={() => setOpen(false)}>Закрыть</button>}
        primaryOverride={pendingRestart ? <button type="button" className="fx-btn fx-btn-primary" onClick={() => void restart()}>Перезапустить Flux</button> : undefined}
      />
    </div>}
  </div>;
}

export default ConnectionPanel;
