/**
 * Окно Flux Studio: подключение к базе, вход, раздел «Подпрограммы».
 *
 * Окно ничего не решает про права: оно показывает то, что ответил сервер.
 * Мост window.studio отдаёт предзагрузка (studio/shell/preload.ts).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

interface Snapshot {
  version: string; build: string; connected: boolean; display: string;
  user: { id: string; name: string } | null; sections: { id: string; title: string }[];
}
interface Module { moduleId: string; version: string; state: string; createdAt: string; requests: number }
type Reply<T> = { ok: boolean; value: T; error: string };
declare global {
  interface Window {
    studio: {
      call: <T = unknown>(action: string, args?: object) => Promise<Reply<T>>;
      onState: (fn: (state: Snapshot) => void) => () => void;
      onProgress: (fn: (data: { phase: string }) => void) => () => void;
    };
  }
}

const STATES: Record<string, string> = {
  pending: 'На проверке', returned: 'Возвращена на доработку', rejected: 'Отклонена',
  edited: 'Владелец внёс правки', superseded: 'Заменена новой отправкой', released: 'Выпущена', writing: 'Загружается',
};

function Connect({ onDone }: { onDone: (s: Snapshot) => void }) {
  const [uri, setUri] = useState('');
  const [error, setError] = useState('');
  const [phase, setPhase] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => window.studio.onProgress(data => setPhase(data.phase)), []);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    const reply = await window.studio.call<Snapshot>('connect', { uri });
    setBusy(false);
    if (reply.ok) { setUri(''); onDone(reply.value); } else setError(reply.error);
  };
  return (
    <form className="card" onSubmit={submit} aria-labelledby="connect-title">
      <h2 id="connect-title">Подключение к общей базе</h2>
      <p className="muted">Studio работает с той же базой, что и Flux. Адрес содержит пароль базы: он не сохраняется и после закрытия программы вводится снова.</p>
      <div className="field">
        <label htmlFor="uri">Адрес MariaDB / MySQL</label>
        <input id="uri" type="password" autoComplete="off" spellCheck={false} maxLength={4096} value={uri}
          placeholder="mysql://USER:PASSWORD@HOST:3306/Flux" onChange={e => setUri(e.target.value)} />
        <p className="hint">Рядом с Studio должен лежать тот же выпуск Flux: он запускает локальный обработчик базы.</p>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="row">
        <button className="primary" type="submit" disabled={busy || !uri.trim()}>{busy ? 'Подключаемся…' : 'Подключиться'}</button>
        {busy && <button className="secondary" type="button" onClick={() => window.studio.call('cancel')}>Отмена</button>}
      </div>
      {busy && phase && <p className="hint" aria-live="polite">{phase}</p>}
    </form>
  );
}

function Login({ display, onDone, onBack }: { display: string; onDone: (s: Snapshot) => void; onBack: () => void }) {
  const [symbol, setSymbol] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    const reply = await window.studio.call<Snapshot>('login', { symbol, password });
    setBusy(false);
    if (reply.ok) { setPassword(''); onDone(reply.value); } else setError(reply.error);
  };
  return (
    <form className="card" onSubmit={submit} aria-labelledby="login-title">
      <h2 id="login-title">Вход в Flux Studio</h2>
      <p className="muted">База: {display}. Войдите своим логином и паролем Flux. Нужно право «Разработка подпрограмм».</p>
      <div className="field"><label htmlFor="symbol">Логин</label>
        <input id="symbol" autoComplete="username" maxLength={200} value={symbol} onChange={e => setSymbol(e.target.value)} /></div>
      <div className="field"><label htmlFor="password">Пароль</label>
        <input id="password" type="password" autoComplete="current-password" maxLength={1024} value={password} onChange={e => setPassword(e.target.value)} /></div>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="row">
        <button className="primary" type="submit" disabled={busy || !symbol.trim() || !password}>{busy ? 'Входим…' : 'Войти'}</button>
        <button className="secondary" type="button" onClick={onBack}>Другая база</button>
      </div>
    </form>
  );
}

function Modules() {
  const [modules, setModules] = useState<Module[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    void window.studio.call<Module[]>('modules').then(reply => {
      if (!live) return;
      if (reply.ok) setModules(reply.value); else setError(reply.error);
    });
    return () => { live = false; };
  }, []);
  return (
    <section aria-labelledby="modules-title">
      <h2 id="modules-title">Подпрограммы</h2>
      <p className="muted">Ваши подпрограммы и состояние последней отправки на публикацию.</p>
      {error && <p className="error" role="alert">{error}</p>}
      {modules && modules.length === 0 && (
        <div className="empty">Вы ещё не отправляли подпрограмм. Создание проекта и отправка на публикацию появятся в следующих обновлениях Studio.</div>
      )}
      {modules && modules.length > 0 && (
        <table>
          <thead><tr><th>Подпрограмма</th><th>Версия</th><th>Состояние</th><th>Отправок</th></tr></thead>
          <tbody>{modules.map(m => (
            <tr key={m.moduleId}><td>{m.moduleId}</td><td>{m.version}</td><td>{STATES[m.state] || m.state}</td><td>{m.requests}</td></tr>
          ))}</tbody>
        </table>
      )}
    </section>
  );
}

function Workspace({ state, onState }: { state: Snapshot; onState: (s: Snapshot) => void }) {
  const [error, setError] = useState('');
  const open = async (id: string) => { const reply = await window.studio.call('openSection', { id }); setError(reply.ok ? '' : reply.error); };
  return (
    <div className="body">
      <nav className="nav" aria-label="Разделы Studio">
        <button aria-current="page">Подпрограммы</button>
        {state.sections.length > 0 && <h3>Управление</h3>}
        {state.sections.map(section => <button key={section.id} onClick={() => open(section.id)}>{section.title}</button>)}
        <div className="spacer" />
        <button onClick={async () => { const reply = await window.studio.call<Snapshot>('logout'); if (reply.ok) onState(reply.value); }}>Выйти</button>
      </nav>
      <main className="main">{error && <p className="error" role="alert">{error}</p>}<Modules /></main>
    </div>
  );
}

function App() {
  const [state, setState] = useState<Snapshot | null>(null);
  const [error, setError] = useState('');
  useEffect(() => window.studio.onState(setState), []);
  useEffect(() => { void window.studio.call<Snapshot>('state').then(r => { if (r.ok) setState(r.value); else setError(r.error); }); }, []);
  const disconnect = useCallback(async () => { const r = await window.studio.call<Snapshot>('disconnect'); if (r.ok) setState(r.value); }, []);
  if (!state) return <div className="app"><main className="main">{error || 'Загрузка…'}</main></div>;
  return (
    <div className="app">
      <header className="top">
        <span className="brand">Flux Studio<small>{state.version}</small></span>
        <span className="spacer" />
        {state.connected && <span className="chip ok">{state.display}</span>}
        {state.user && <span className="chip">{state.user.name || state.user.id}</span>}
        {state.connected && <button className="secondary" onClick={disconnect}>Отключиться</button>}
      </header>
      {!state.connected && <main className="main"><Connect onDone={setState} /></main>}
      {state.connected && !state.user && <main className="main"><Login display={state.display} onDone={setState} onBack={disconnect} /></main>}
      {state.connected && state.user && <Workspace state={state} onState={setState} />}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
