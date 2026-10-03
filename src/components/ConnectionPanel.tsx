import React, { useState } from 'react';
import { Database, Loader2 } from 'lucide-react';
import { readDatabaseConnection } from '../lib/connection';

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
    <button type="button" className="fx-btn fx-btn-quiet max-w-full" aria-expanded={open} disabled={busy} onClick={() => {
      const next = !open;
      setOpen(next); setError('');
      if (next) void (window as any).electron?.ipcRenderer?.invoke('app:get-database').then((result: any) => setDatabase(result)).catch(() => setDatabase(null));
    }}>
      <Database className="w-4 h-4 shrink-0" />
      <span className="truncate">{database?.configured ? `База · ${database.host}/${database.database}` : 'Подключение к общей базе'}</span>
    </button>
    {open && <div className="w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded p-4 space-y-3">
      <label className="fx-field block"><span className="fx-label block mb-1">URI базы MariaDB/MySQL</span>
        <input className="fx-input w-full font-mono" type="password" value={draft} autoFocus spellCheck={false} autoComplete="new-password" disabled={busy || pendingRestart} placeholder="mysql://USER:PASSWORD@HOST:3306/Flux" onChange={e => { setDraft(e.target.value); setError(''); }} onKeyDown={e => { if (e.key === 'Enter' && !busy && !pendingRestart) void connect(); }} />
      </label>
      <p className="fx-hint">Укажите адрес общей базы и отдельную учётную запись приложения. Нажмите «Проверить и подключить»; пароль не показывается после сохранения.</p>
      {database?.configured && <p className="fx-hint">Сейчас подключена база {database.host}/{database.database}. Для смены укажите новый URI.</p>}
      {database?.provider === 'unsupported' && <p className="fx-error" role="status">Сохранённый тип базы не поддерживается. Укажите URI MariaDB/MySQL.</p>}
      {error && <p className="fx-error" role="alert">{error}</p>}
      {pendingRestart && <p className="fx-hint" role="status">Подключение сохранено. Перезапустите Flux, чтобы применить его.</p>}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <button type="button" className="fx-btn" disabled={busy} onClick={() => setOpen(false)}>Закрыть</button>
        {pendingRestart
          ? <button type="button" className="fx-btn fx-btn-primary" onClick={() => void restart()}>Перезапустить Flux</button>
          : <button type="button" className="fx-btn fx-btn-primary" disabled={busy || !draft.trim()} onClick={() => void connect()}>{busy && <Loader2 className="w-4 h-4 animate-spin" />}Проверить и подключить</button>}
      </div>
    </div>}
  </div>;
}

export default ConnectionPanel;
