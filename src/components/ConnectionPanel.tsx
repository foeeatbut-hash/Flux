import React, { useMemo, useState } from 'react';
import { Server, Laptop, Loader2 } from 'lucide-react';
import { getConfiguredServerUrl, setConfiguredServerUrl } from '../config/env';
import { readConnection, probeFluxServer } from '../lib/connection';

async function restart() {
  const shell = (window as any).electron?.ipcRenderer;
  if (shell?.invoke) { try { await shell.invoke('app:relaunch'); return; } catch (_) {} }
  window.location.reload();
}

export default function ConnectionPanel() {
  const [serverUrl] = useState(() => getConfiguredServerUrl());
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(serverUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const parsed = useMemo(() => readConnection(draft), [draft]);
  const connect = async () => {
    if (parsed.kind === 'error') { setError(parsed.error); return; }
    setBusy(true); setError('');
    try {
      const result = await probeFluxServer(parsed.url);
      if (!result.ready) throw new Error(result.error);
      await setConfiguredServerUrl(parsed.url);
      await restart();
    } catch (e: any) { setError(e.message || 'Не удалось подключиться.'); setBusy(false); }
  };
  const local = async () => {
    setBusy(true); setError('');
    try { await setConfiguredServerUrl(''); await restart(); }
    catch (e: any) { setError(e.message); setBusy(false); }
  };
  return <div className="w-full flex flex-col items-center gap-2 pb-1">
    <button type="button" className="fx-btn fx-btn-quiet max-w-full" aria-expanded={open} onClick={() => { setOpen(v => !v); setError(''); }}>
      {serverUrl ? <Server className="w-4 h-4 shrink-0" /> : <Laptop className="w-4 h-4 shrink-0" />}
      <span className="truncate">{serverUrl ? `Сервер компании · ${serverUrl}` : 'Подключение · Этот компьютер'}</span>
    </button>
    {open && <div className="w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded p-4 space-y-3">
      <label className="fx-field block"><span className="fx-label block mb-1">Адрес сервера Flux</span>
        <input className="fx-input w-full font-mono" value={draft} autoFocus spellCheck={false} autoComplete="off" disabled={busy} placeholder="https://flux.company.ru" onChange={e => { setDraft(e.target.value); setError(''); }} onKeyDown={e => { if (e.key === 'Enter' && !busy) void connect(); }} />
      </label>
      <p className="fx-hint">Нужен сервер программы Flux. Адрес MySQL или PostgreSQL сюда не подходит: сама база данных не предоставляет интерфейс программы.</p>
      <details className="text-xs text-slate-600 dark:text-slate-400"><summary className="cursor-pointer">Как проверить сервер компании</summary><p className="pt-2 leading-relaxed">Откройте в браузере адрес сервера с окончанием /api/health. Рабочий сервер Flux возвращает ok: true и номер version. Если открывается другой сайт или ответа нет, администратору нужно запустить Flux рядом с БД, подключить его к ней и выдать сотрудникам HTTPS-адрес.</p></details>
      {error && <p className="fx-error" role="alert">{error}</p>}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {serverUrl && <button type="button" className="fx-btn fx-btn-quiet mr-auto" disabled={busy} onClick={() => void local()}><Laptop className="w-4 h-4" />Этот компьютер</button>}
        <button type="button" className="fx-btn" disabled={busy} onClick={() => setOpen(false)}>Отмена</button>
        <button type="button" className="fx-btn fx-btn-primary" disabled={busy || !draft.trim()} onClick={() => void connect()}>{busy && <Loader2 className="w-4 h-4 animate-spin" />}Проверить и подключиться</button>
      </div>
    </div>}
  </div>;
}
