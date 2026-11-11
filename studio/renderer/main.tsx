/**
 * Окно Flux Studio: подключение к базе, вход, раздел «Подпрограммы».
 *
 * Окно ничего не решает про права: оно показывает то, что ответил сервер.
 * Мост window.studio отдаёт предзагрузка (studio/shell/preload.ts).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { REQUEST_STATES, type Snapshot } from './call';
import Projects from './sections/Projects';
import Editor from './sections/Editor';
import Check from './sections/Check';
import Publish from './sections/Publish';
import Errors from './sections/Errors';

interface Module { moduleId: string; version: string; state: string; createdAt: string; requests: number }

const STATES = REQUEST_STATES;

function Connect({ remembered, onDone }: { remembered: string; onDone: (s: Snapshot) => void }) {
  const [uri, setUri] = useState('');
  const [remember, setRemember] = useState(true);
  const [other, setOther] = useState(false);
  const [error, setError] = useState('');
  const [phase, setPhase] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => window.studio.onProgress(data => setPhase(data.phase)), []);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    const reply = await window.studio.call<Snapshot>('connect', { uri, remember });
    setBusy(false);
    if (reply.ok) { setUri(''); onDone(reply.value); } else setError(reply.error);
  };
  const useRemembered = async () => {
    setBusy(true); setError('');
    const reply = await window.studio.call<Snapshot>('connectRemembered');
    setBusy(false);
    if (reply.ok) onDone(reply.value); else setError(reply.error);
  };
  const forget = async () => { const reply = await window.studio.call<Snapshot>('forgetBase'); if (reply.ok) { onDone(reply.value); setOther(true); } };
  if (remembered && !other) {
    return (
      <div className="card" role="group" aria-labelledby="connect-title">
        <h2 id="connect-title">Подключение к общей базе</h2>
        <p className="muted">Сохранённая база: <strong data-testid="remembered">{remembered}</strong>. Адрес хранится на этом компьютере в защищённом хранилище Windows.</p>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="row">
          <button className="primary" onClick={useRemembered} disabled={busy}>{busy ? 'Подключаемся…' : 'Подключиться'}</button>
          <button className="secondary" onClick={() => setOther(true)} disabled={busy}>Другая база</button>
          <button className="secondary" onClick={forget} disabled={busy}>Забыть адрес</button>
        </div>
        {busy && phase && <p className="hint" aria-live="polite">{phase}</p>}
      </div>
    );
  }
  return (
    <form className="card" onSubmit={submit} aria-labelledby="connect-title">
      <h2 id="connect-title">Подключение к общей базе</h2>
      <p className="muted">Studio работает с той же базой, что и Flux. Адрес содержит пароль базы; если запомнить его, он будет храниться только в защищённом хранилище Windows.</p>
      <div className="field">
        <label htmlFor="uri">Адрес MariaDB / MySQL</label>
        <input id="uri" type="password" autoComplete="off" spellCheck={false} maxLength={4096} value={uri}
          placeholder="mysql://USER:PASSWORD@HOST:3306/Flux" onChange={e => setUri(e.target.value)} />
        <p className="hint">Рядом с Studio должен лежать тот же выпуск Flux: он запускает локальный обработчик базы.</p>
      </div>
      <label className="check"><input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} /> Запомнить адрес на этом компьютере</label>
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
        <div className="empty">Вы ещё не отправляли подпрограмм. Создайте проект в разделе «Проект подпрограммы».</div>
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

const NAV: Array<[string, string]> = [
  ['modules', 'Подпрограммы'], ['project', 'Проект подпрограммы'], ['editor', 'Редактор'],
  ['check', 'Проверка перед отправкой'], ['publish', 'Публикация'], ['errors', 'Ошибки'],
];

function Workspace({ state, onState }: { state: Snapshot; onState: (s: Snapshot) => void }) {
  const [error, setError] = useState('');
  const [section, setSection] = useState('modules');
  // Открытый проект общий для разделов: редактор, проверка и публикация работают с ним
  const [current, setCurrent] = useState('');
  const open = async (id: string) => { const reply = await window.studio.call('openSection', { id }); setError(reply.ok ? '' : reply.error); };
  return (
    <div className="body">
      <nav className="nav" aria-label="Разделы Studio">
        {NAV.map(([id, title]) => <button key={id} aria-current={section === id ? 'page' : undefined} onClick={() => setSection(id)}>{title}</button>)}
        {current && <p className="nav-current" title="Открытый проект">Проект: <span className="code">{current}</span></p>}
        {state.sections.length > 0 && <h3>Управление</h3>}
        {state.sections.map(item => <button key={item.id} onClick={() => open(item.id)}>{item.title}</button>)}
        <div className="spacer" />
        <button onClick={async () => { const reply = await window.studio.call<Snapshot>('logout'); if (reply.ok) onState(reply.value); }}>Выйти</button>
      </nav>
      <main className="main">
        {state.warning && <p className="warning" role="status" data-testid="outdated">{state.warning}</p>}
        {error && <p className="error" role="alert">{error}</p>}
        {section === 'modules' && <Modules />}
        {section === 'project' && <Projects current={current} onOpen={setCurrent} />}
        {section === 'editor' && <Editor id={current} />}
        {section === 'check' && <Check id={current} onGo={setSection} />}
        {section === 'publish' && <Publish id={current} onGo={setSection} onOpen={setCurrent} />}
        {section === 'errors' && <Errors />}
      </main>
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
      {!state.connected && <main className="main"><Connect remembered={state.remembered} onDone={setState} /></main>}
      {state.connected && !state.user && <main className="main"><Login display={state.display} onDone={setState} onBack={disconnect} /></main>}
      {state.connected && state.user && <Workspace state={state} onState={setState} />}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
