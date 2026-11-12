import React, { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import LoginFrame from '../../../src/components/auth/LoginFrame';
import DatabaseUriForm from '../../../src/components/auth/DatabaseUriForm';
import { type Snapshot } from '../call';

/**
 * Первый шаг входа: подключение к общей базе. Поля и кнопки — те же компоненты, что у панели подключения Flux
 * (src/components/auth); отличие одно: у Flux база уже настроена при установке, а Studio без неё не открыть,
 * поэтому шаг стоит перед входом, а не под ним.
 */
export default function ConnectScreen({ state, onDone, theme, onToggleTheme }: { state: Snapshot; onDone: (s: Snapshot) => void; theme: 'light' | 'dark'; onToggleTheme: () => void }) {
  const [uri, setUri] = useState('');
  const [remember, setRemember] = useState(true);
  const [other, setOther] = useState(false);
  const [error, setError] = useState('');
  const [phase, setPhase] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => window.studio.onProgress(data => setPhase(data.phase)), []);
  const run = async (action: string, args?: object) => {
    setBusy(true); setError('');
    const reply = await window.studio.call<Snapshot>(action, args);
    setBusy(false);
    if (reply.ok) { setUri(''); onDone(reply.value); return true; }
    setError(reply.error); return false;
  };
  const forget = async () => { if (await run('forgetBase')) setOther(true); };
  const saved = !!state.remembered && !other;
  return (
    <LoginFrame theme={theme} onToggleTheme={onToggleTheme} title={state.name} version={state.version} error={error} errorTitle="Не удалось подключиться" errorRole="alert">
      <div className="space-y-3">
        <h2 id="connect-title" className="fx-group-title">Подключение к общей базе</h2>
        {saved ? <>
          <p className="fx-hint">Сохранённая база: <strong data-testid="remembered">{state.remembered}</strong>. Адрес хранится на этом компьютере в защищённом хранилище Windows.</p>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {busy && <button type="button" className="fx-btn" onClick={() => void window.studio.call('cancel')}>Отмена</button>}
            <button type="button" className="fx-btn" onClick={() => setOther(true)} disabled={busy}>Другая база</button>
            <button type="button" className="fx-btn" onClick={() => void forget()} disabled={busy}>Забыть адрес</button>
            <button type="button" className="fx-btn fx-btn-primary" onClick={() => void run('connectRemembered')} disabled={busy}>{busy && <Loader2 className="w-4 h-4 animate-spin" />}{busy ? 'Подключаемся…' : 'Подключиться'}</button>
          </div>
        </> : <DatabaseUriForm
          draft={uri} onDraft={value => { setUri(value); setError(''); }} busy={busy} error=""
          hint={<p className="fx-hint">Studio работает с той же базой, что и Flux. Адрес содержит пароль базы; если запомнить его, он будет храниться только в защищённом хранилище Windows. Рядом со Studio должен лежать тот же выпуск Flux: он запускает локальный обработчик базы.</p>}
          extra={<label className="flex items-center gap-2 cursor-pointer text-xs font-semibold text-slate-500 dark:text-slate-400"><input type="checkbox" className="w-4 h-4 rounded-sm border-slate-300 dark:border-slate-800 accent-emerald-500 cursor-pointer" checked={remember} onChange={e => setRemember(e.target.checked)} /> Запомнить адрес на этом компьютере</label>}
          onSubmit={() => void run('connect', { uri, remember })} submitLabel={busy ? 'Подключаемся…' : 'Подключиться'}
          secondary={busy ? <button type="button" className="fx-btn" onClick={() => void window.studio.call('cancel')}>Отмена</button> : undefined}
        />}
        {busy && phase && <p className="fx-hint" role="status">{phase}</p>}
      </div>
    </LoginFrame>
  );
}
