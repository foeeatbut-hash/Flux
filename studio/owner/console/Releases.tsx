/**
 * Выпущенные программы: выпуск для всех, возврат к прежней версии, отзыв.
 * Перенесено из Flux (ModuleTrustPanel и ModuleTestersPanel). Подпись ставит главный процесс.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { call } from './api';
import { Badge, Btn, Dialog, ErrorLine, Field, useAction } from './ui';
import type { ReleaseRow } from './types';

type Ask = null | { kind: 'pin' | 'unpin' | 'revoke'; release: ReleaseRow };
const channelName = (c: string) => (c === 'test' ? 'пробная группа' : 'все');

export default function Releases() {
  const [releases, setReleases] = useState<ReleaseRow[]>([]);
  const [error, setError] = useState('');
  const [ask, setAsk] = useState<Ask>(null);
  const action = useAction();
  const load = useCallback(() => { call<{ releases: ReleaseRow[] }>('releases').then(r => setReleases(r.releases)).catch(e => setError(e.message)); }, []);
  useEffect(load, [load]);
  const promote = async (r: ReleaseRow) => { if (await action.run(() => call('promote', { releaseId: r.id }))) load(); };
  return <div className="pane">
    <div className="bar"><strong>Выпуски</strong><span className="muted">{releases.length}</span></div>
    <ErrorLine text={error || action.error} />
    <div className="scroll">
      <table className="tbl">
        <thead><tr><th>Программа</th><th>Версия</th><th>Для кого</th><th>Состояние</th><th /></tr></thead>
        <tbody>{releases.map(r => <tr key={r.id}>
          <td>{r.moduleId}</td><td>{r.version}</td><td>{channelName(r.channel)}</td>
          <td>{r.state === 'revoked' ? <Badge tone="bad">Отозван</Badge> : <Badge tone="ok">Выпущен</Badge>}</td>
          <td><div className="rows">
            {r.state !== 'revoked' && r.channel === 'test' && <Btn disabled={action.busy} onClick={() => void promote(r)}>Выпустить для всех</Btn>}
            {r.state !== 'revoked' && <Btn tone="ghost" title="Более новые выпуски перестанут запускаться у всех" onClick={() => setAsk({ kind: 'pin', release: r })}>Вернуть к этой версии</Btn>}
            {r.state !== 'revoked' && <Btn tone="ghost" title="Снять возврат к прежней версии" onClick={() => setAsk({ kind: 'unpin', release: r })}>Снять возврат</Btn>}
            {r.state !== 'revoked' && <Btn tone="ghost" onClick={() => setAsk({ kind: 'revoke', release: r })}>Отозвать</Btn>}
          </div></td></tr>)}</tbody>
      </table>
    </div>
    {ask && <ReasonDialog ask={ask} onClose={() => setAsk(null)} onDone={load} />}
  </div>;
}

function ReasonDialog({ ask, onClose, onDone }: { ask: Exclude<Ask, null>; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const { busy, error, run } = useAction();
  const r = ask.release;
  const title = ask.kind === 'revoke' ? `Отозвать выпуск ${r.moduleId} ${r.version}` : ask.kind === 'pin' ? `Вернуть ${r.moduleId} к версии ${r.version} (${channelName(r.channel)})` : `Снять возврат: ${r.moduleId} (${channelName(r.channel)})`;
  const go = async () => {
    const done = await run(() => ask.kind === 'revoke' ? call('revoke', { target: 'release', value: `${r.moduleId}@${r.version}`, reason })
      : call('pin', { moduleId: r.moduleId, channel: r.channel, version: ask.kind === 'pin' ? r.version : null, reason }));
    if (done) { onDone(); onClose(); }
  };
  return <Dialog title={title} onClose={onClose} busy={busy} footer={<><Btn onClick={onClose} disabled={busy}>Отмена</Btn>
    <Btn tone={ask.kind === 'unpin' ? 'primary' : 'danger'} disabled={busy} onClick={() => void go()}>Подписать</Btn></>}>
    <Field label="Причина" id="reason"><input id="reason" value={reason} onChange={e => setReason(e.target.value)} /></Field>
    <p className="hint">{ask.kind === 'revoke' ? 'Отзыв действует сразу у всех: выпуск перестаёт запускаться, работает прошлый проверенный.'
      : ask.kind === 'pin' ? 'Более новые выпуски перестанут запускаться у всех, работает выбранная версия.' : 'Выпуски снова запускаются по общим правилам: запускается новейший проверенный.'}</p>
    <ErrorLine text={error} />
  </Dialog>;
}

/** Кому виден пробный выпуск: выпуск сначала получают назначенные люди, затем владелец выпускает для всех */
export function Testers() {
  const [users, setUsers] = useState<Array<{ id: string; name: string; role: string }>>([]);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [saved, setSaved] = useState('');
  const [open, setOpen] = useState(true);
  const { error, run } = useAction();
  const load = useCallback(() => { call<{ testers: string[]; users: typeof users }>('testers').then(r => { setUsers(r.users); setChosen(new Set(r.testers)); setSaved([...r.testers].sort().join()); }).catch(() => {}); }, []);
  useEffect(load, [load]);
  const dirty = [...chosen].sort().join() !== saved;
  const save = async () => { const r = await run(() => call<{ testers: string[] }>('saveTesters', { testers: [...chosen] })); if (r) setSaved([...r.value.testers].sort().join()); };
  return <div className="pane">
    <div className="bar"><strong>Пробная группа</strong><span className="muted">{chosen.size}</span><span className="grow" />
      <Btn onClick={() => setOpen(!open)}>{open ? 'Свернуть' : 'Назначить тестировщиков'}</Btn>{dirty && <Btn tone="primary" onClick={() => void save()}>Сохранить</Btn>}</div>
    <ErrorLine text={error} />
    {open && <div className="sect" data-testid="module-testers" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(260px,1fr))', gap: '6px 32px', padding: '12px 16px' }}>
      {users.map(u => <label key={u.id} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input type="checkbox" checked={chosen.has(u.id)} onChange={e => { const next = new Set(chosen); if (e.target.checked) next.add(u.id); else next.delete(u.id); setChosen(next); }} />
        <span className="grow">{u.name}</span><span className="muted">{u.role}</span></label>)}
    </div>}
  </div>;
}
