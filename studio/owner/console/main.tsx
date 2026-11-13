/**
 * Studio — Владелец: три пункта — «Программы на проверку», «Flux: обновления», «Лицензии» (бывшее окно лицензий теперь внутри). Окно только показывает: хранилище, подключение, подпись и решения — в главном процессе.
 */
import '../../renderer/theme';
import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { call } from './api';
import { Badge, Btn, ErrorLine, useAction } from './ui';
import Programs, { isSection } from './Programs';
import Updates from './Updates';
import Licenses from './Licenses';
import VaultGate, { type Wizard } from './Vault';
import type { LicenseSection, Section, Snapshot, Tab } from './types';

const TABS: Array<[Tab, string]> = [['programs', 'Программы на проверку'], ['updates', 'Flux: обновления'], ['licenses', 'Лицензии']];
const isTab = (value: unknown): value is Tab => TABS.some(([id]) => id === value);
/** «programs:requests» — пункт и подраздел одной строкой (так их шлёт главный процесс) */
const parseTab = (value: string | null, section?: string | null): { tab: Tab; section?: Section } => {
  const [tab, sub] = (value || '').split(':');
  return { tab: isTab(tab) ? tab : 'programs', section: isSection(sub || section) ? (sub || section) as Section : undefined };
};

/** Подключение к общей базе: нужно разделам, которые ходят на сервер (программы, обновления) */
function Connect({ onState }: { onState: (s: Snapshot) => void }) {
  const [uri, setUri] = useState('');
  const { busy, error, run } = useAction();
  const connect = async (event: React.FormEvent) => {
    event.preventDefault();
    const done = await run(() => call<Snapshot>('connect', { server: uri }));
    setUri('');
    if (done) onState(done.value);
  };
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
  const start = useState(() => { const q = new URLSearchParams(location.search); return parseTab(q.get('tab'), q.get('section')); })[0];
  const [tab, setTab] = useState<Tab>(start.tab);
  const [section, setSection] = useState<Section>(start.section || 'requests');
  const [licenseSection, setLicenseSection] = useState<LicenseSection>('licenses');
  const [wizard, setWizard] = useState<Wizard>('');
  const [progress, setProgress] = useState('');
  const [counts, setCounts] = useState<{ requests: number; certificates: number }>({ requests: 0, certificates: 0 });
  const reload = useCallback(() => { call<Snapshot>('state').then(setState).catch(() => {}); }, []);
  useEffect(() => {
    reload();
    const offs = [window.ownerConsole.onLocked(() => { setWizard(''); reload(); }), window.ownerConsole.onDisconnected(reload), window.ownerConsole.onProgress(p => setProgress(p?.phase || '')), window.ownerConsole.onTab(t => { const next = parseTab(t); setTab(next.tab); if (next.section) setSection(next.section); })];
    return () => offs.forEach(off => off());
  }, [reload]);
  const onRequests = useCallback((n: number) => setCounts(c => ({ ...c, requests: n })), []);
  const onCertificates = useCallback((n: number) => setCounts(c => ({ ...c, certificates: n })), []);
  if (!state) return <div className="app" />;
  const ready = state.unlocked && state.connected;
  const gated = !state.unlocked || wizard !== '';
  const report = async (fn: () => Promise<unknown>) => { try { await fn(); } catch { /* ошибка показана действием; здесь кнопка верхней строки */ } finally { reload(); } };
  return <div className="app">
    <div className="top"><h1>Studio — Владелец</h1><span className="muted">версия {state.version}</span><span className="spacer" />
      {progress && <><label className="muted" htmlFor="op-progress">{progress}</label><progress id="op-progress" /><Btn onClick={() => void call('cancel').catch(() => {})}>Отменить</Btn></>}
      {state.backupSession && <Badge tone="warn">Вход запасным ключом: подписи недоступны</Badge>}
      <Badge tone={ready ? 'ok' : 'off'}>{ready ? `База: ${state.display}` : 'Нет подключения'}</Badge>
      {state.connected && <Btn onClick={() => void report(() => call('openFlux'))}>Открыть Flux</Btn>}
      {state.connected && <Btn onClick={() => void report(() => call('disconnect'))}>Отключиться</Btn>}
      <Btn title="Сохранить журналы диагностики. Они не содержат содержимое файлов, пароли или закрытые ключи" aria-label="Сохранить журналы диагностики" onClick={() => void report(() => call('exportDiagnostics'))}>Журналы</Btn>
      {!gated && <Btn onClick={() => void call('lock').then(() => reload())}>Запереть хранилище</Btn>}
    </div>
    <div className="tabs" role="tablist" aria-label="Разделы владельца">{TABS.map(([id, label]) =>
      <button key={id} role="tab" type="button" aria-selected={tab === id} onClick={() => setTab(id)}>{label}
        {id === 'programs' && counts.requests + counts.certificates > 0 && <span className="count">{counts.requests + counts.certificates}</span>}</button>)}</div>
    <div className="body">
      {gated ? <VaultGate state={state} wizard={wizard} onWizard={setWizard} onState={setState} />
        : tab === 'licenses' ? <Licenses section={licenseSection} onSection={setLicenseSection} />
          : !ready ? <Connect onState={setState} />
            : tab === 'programs' ? <Programs section={section} onSection={setSection} counts={counts} onRequests={onRequests} onCertificates={onCertificates} />
              : <Updates onPublish={() => { setLicenseSection('publish'); setTab('licenses'); }} />}
    </div>
  </div>;
}

createRoot(document.getElementById('root')!).render(<App />);
