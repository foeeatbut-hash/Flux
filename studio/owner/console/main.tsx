/**
 * Разделы Studio — Владелец: запросы на публикацию, выпуски и каналы, сертификаты разработчиков,
 * обновления Flux. Окно только показывает: хранилище, подключение, подпись и решения — в главном процессе.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { call } from './api';
import { Badge, Btn, ErrorLine, useAction } from './ui';
import Requests from './Requests';
import Releases from './Releases';
import Certificates from './Certificates';
import Updates from './Updates';
import type { Snapshot, Tab } from './types';

const TABS: Array<[Tab, string]> = [['requests', 'Запросы на публикацию'], ['releases', 'Выпуски и каналы'], ['certificates', 'Сертификаты разработчиков'], ['updates', 'Обновления Flux']];
const isTab = (value: unknown): value is Tab => TABS.some(([id]) => id === value);

function Gate({ state, onState }: { state: Snapshot; onState: (s: Snapshot) => void }) {
  const [password, setPassword] = useState('');
  const [uri, setUri] = useState('');
  const { busy, error, run } = useAction();
  const unlock = async (event: React.FormEvent) => {
    event.preventDefault();
    const done = await run(() => call<Snapshot>('unlock', { password }));
    setPassword('');
    if (done) onState(done.value);
  };
  const connect = async (event: React.FormEvent) => {
    event.preventDefault();
    const done = await run(() => call<Snapshot>('connect', { server: uri }));
    setUri('');
    if (done) onState(done.value);
  };
  if (!state.unlocked) {
    return <form className="card" onSubmit={unlock} aria-labelledby="gate-title">
      <h2 id="gate-title">Хранилище владельца</h2>
      {state.vaultExists
        ? <><p className="muted">Подписи выпусков, сертификатов и обновлений ставятся ключами из вашего хранилища. Ключи остаются на этом компьютере.</p>
          <div className="field"><label htmlFor="vault-password">Пароль хранилища</label>
            <input id="vault-password" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} /></div>
          <ErrorLine text={error} />
          <Btn type="submit" tone="primary" disabled={busy || password.length < 12}>{busy ? 'Открываем…' : 'Открыть хранилище'}</Btn></>
        : <p className="muted">Хранилища ключей на этом компьютере нет. Создайте его или импортируйте резервную копию в разделе «Управление → Лицензии и обновления Flux».</p>}
    </form>;
  }
  return <form className="card" onSubmit={connect} aria-labelledby="gate-title">
    <h2 id="gate-title">Подключение к общей базе</h2>
    <p className="muted">Адрес содержит пароль базы: он нигде не сохраняется и после закрытия программы вводится снова. Рядом с Studio должен лежать тот же выпуск Flux.</p>
    <div className="field"><label htmlFor="uri">Адрес MariaDB / MySQL</label>
      <input id="uri" type="password" autoComplete="off" spellCheck={false} maxLength={4096} placeholder="mysql://USER:PASSWORD@HOST:3306/Flux" value={uri} onChange={e => setUri(e.target.value)} /></div>
    <ErrorLine text={error} />
    <div className="rows"><Btn type="submit" tone="primary" disabled={busy || !uri.trim()}>{busy ? 'Подключаемся…' : 'Подключиться'}</Btn>
      {busy && <Btn onClick={() => void call('cancel').catch(() => {})}>Отмена</Btn>}</div>
  </form>;
}

function App() {
  const [state, setState] = useState<Snapshot | null>(null);
  const [tab, setTab] = useState<Tab>(() => { const q = new URLSearchParams(location.search).get('tab'); return isTab(q) ? q : 'requests'; });
  const [counts, setCounts] = useState<{ requests: number; certificates: number }>({ requests: 0, certificates: 0 });
  const reload = useCallback(() => { call<Snapshot>('state').then(setState).catch(() => {}); }, []);
  useEffect(() => {
    reload();
    const offs = [window.ownerConsole.onLocked(reload), window.ownerConsole.onDisconnected(reload), window.ownerConsole.onTab(t => { if (isTab(t)) setTab(t); })];
    return () => offs.forEach(off => off());
  }, [reload]);
  const onRequests = useCallback((n: number) => setCounts(c => ({ ...c, requests: n })), []);
  const onCertificates = useCallback((n: number) => setCounts(c => ({ ...c, certificates: n })), []);
  if (!state) return <div className="app" />;
  const ready = state.unlocked && state.connected;
  return <div className="app">
    <div className="top"><h1>Studio — Владелец</h1><span className="muted">версия {state.version}</span><span className="spacer" />
      {state.backupSession && <Badge tone="warn">Вход запасным ключом: подписи недоступны</Badge>}
      <Badge tone={ready ? 'ok' : 'off'}>{ready ? `База: ${state.display}` : 'Нет подключения'}</Badge>
      {state.unlocked && <Btn onClick={() => void call('lock').then(() => reload())}>Запереть хранилище</Btn>}
    </div>
    <div className="tabs" role="tablist" aria-label="Разделы владельца">{TABS.map(([id, label]) =>
      <button key={id} role="tab" type="button" aria-selected={tab === id} onClick={() => setTab(id)}>{label}
        {id === 'requests' && counts.requests > 0 && <span className="count">{counts.requests}</span>}
        {id === 'certificates' && counts.certificates > 0 && <span className="count">{counts.certificates}</span>}</button>)}</div>
    <div className="body">
      {!ready ? <Gate state={state} onState={setState} />
        : tab === 'requests' ? <Requests onCount={onRequests} />
          : tab === 'releases' ? <Releases />
            : tab === 'certificates' ? <Certificates onCount={onCertificates} /> : <Updates />}
    </div>
  </div>;
}

createRoot(document.getElementById('root')!).render(<App />);
