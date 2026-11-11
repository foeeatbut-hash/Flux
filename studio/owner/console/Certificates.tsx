/**
 * Сертификаты разработчиков: запросы на сертификат, выдача, отзыв ключа, список.
 * Выдача и отзыв подписываются ключом владельца в главном процессе (перенесено из Flux, ModuleTrustPanel).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { call } from './api';
import { Badge, Btn, Dialog, Empty, ErrorLine, Field, Segs, useAction } from './ui';
import type { CertificateAsk, CertificateRow } from './types';

type Ask = null | { kind: 'certify'; seed?: CertificateAsk } | { kind: 'revoke' };

export default function Certificates({ onCount }: { onCount: (n: number) => void }) {
  const [certs, setCerts] = useState<CertificateRow[]>([]);
  const [asks, setAsks] = useState<CertificateAsk[]>([]);
  const [error, setError] = useState('');
  const [ask, setAsk] = useState<Ask>(null);
  const action = useAction();
  const load = useCallback(() => {
    call<{ certificates: CertificateRow[]; requests: CertificateAsk[] }>('certificates').then(r => { setCerts(r.certificates); setAsks(r.requests); onCount(r.requests.length); }).catch(e => setError(e.message));
  }, [onCount]);
  useEffect(load, [load]);
  const decline = async (a: CertificateAsk) => { if (await action.run(() => call('declineCertificate', { key: a.key }))) load(); };
  return <div className="pane">
    <div className="bar"><strong>Сертификаты разработчиков</strong><span className="muted">{certs.length}</span><span className="grow" />
      <Btn onClick={() => setAsk({ kind: 'certify' })}>Выдать сертификат</Btn><Btn tone="danger" onClick={() => setAsk({ kind: 'revoke' })}>Отозвать ключ разработчика</Btn></div>
    <ErrorLine text={error || action.error} />
    <div className="scroll">
      <div className="bar"><strong>Запросы на сертификат</strong><span className="muted">{asks.length}</span></div>
      {asks.length ? <table className="tbl" data-testid="certificate-requests"><thead><tr><th>Профиль</th><th>Имя</th><th>Ключ</th><th /></tr></thead>
        <tbody>{asks.map(a => <tr key={a.key}><td>{a.userId}</td><td>{a.name}</td><td className="mono">{a.key}</td>
          <td><div className="rows"><Btn tone="primary" onClick={() => setAsk({ kind: 'certify', seed: a })}>Выдать</Btn><Btn tone="danger" disabled={action.busy} onClick={() => void decline(a)}>Отклонить</Btn></div></td></tr>)}</tbody></table>
        : <Empty title="Запросов нет" text="Разработчик просит сертификат из Flux Studio: присылает свой открытый ключ." />}
      <div className="bar"><strong>Выданные сертификаты</strong><span className="muted">{certs.length}</span></div>
      <table className="tbl" data-testid="certificates"><thead><tr><th>Профиль</th><th>Имя</th><th>Ключ</th><th>Выдан</th></tr></thead>
        <tbody>{certs.map(c => <tr key={c.keyHex}><td>{c.userId}</td><td>{c.name}</td><td className="mono">{c.keyHex}</td><td>{new Date(c.createdAt).toLocaleDateString('ru')}</td></tr>)}</tbody></table>
    </div>
    {ask && <TrustDialog ask={ask} onClose={() => setAsk(null)} onDone={load} />}
  </div>;
}

function TrustDialog({ ask, onClose, onDone }: { ask: Exclude<Ask, null>; onClose: () => void; onDone: () => void }) {
  const seed = ask.kind === 'certify' ? ask.seed : undefined;
  const [key, setKey] = useState(seed?.key || ''), [userId, setUserId] = useState(seed?.userId || ''), [name, setName] = useState(seed?.name || ''), [reason, setReason] = useState('');
  const [scope, setScope] = useState<'key' | 'release'>('key');
  const [users, setUsers] = useState<Array<{ id: string; name: string }>>([]);
  const { busy, error, run } = useAction();
  useEffect(() => { if (ask.kind === 'certify') call<{ users: Array<{ id: string; name: string }> }>('testers').then(r => setUsers(r.users)).catch(() => {}); }, [ask.kind]);
  const go = async () => {
    const done = await run(() => ask.kind === 'certify' ? call('certify', { key, userId, name })
      : call('revoke', { target: scope, value: key, reason }));
    if (done) { onDone(); onClose(); }
  };
  return <Dialog title={ask.kind === 'certify' ? 'Выдать сертификат разработчику' : 'Отозвать ключ разработчика'} onClose={onClose} busy={busy}
    footer={<><Btn onClick={onClose} disabled={busy}>Отмена</Btn><Btn tone={ask.kind === 'certify' ? 'primary' : 'danger'} disabled={busy || !key} onClick={() => void go()}>{ask.kind === 'certify' ? 'Подписать сертификат' : 'Подписать отзыв'}</Btn></>}>
    {ask.kind === 'revoke' && <Field label="Что отозвать"><Segs value={scope} onChange={setScope} label="Что отозвать" options={[{ value: 'key', label: 'Ключ' }, { value: 'release', label: 'Выпуск по имени' }]} /></Field>}
    <Field label={scope === 'release' && ask.kind === 'revoke' ? 'Выпуск (модуль@1.2.3)' : 'Открытый ключ разработчика (64 знака hex)'} id="cert-key">
      <input id="cert-key" className="mono" value={key} onChange={e => setKey(e.target.value.trim())} /></Field>
    {ask.kind === 'certify' ? <>
      <Field label="Профиль" id="cert-user"><select id="cert-user" value={userId} onChange={e => { setUserId(e.target.value); if (!name) setName(users.find(u => u.id === e.target.value)?.name || ''); }}>
        <option value="">— выберите —</option>{seed && !users.some(u => u.id === seed.userId) && <option value={seed.userId}>{seed.userId}</option>}
        {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>
      <Field label="Имя" id="cert-name"><input id="cert-name" value={name} onChange={e => setName(e.target.value)} /></Field>
      {seed && <Badge tone="info">По запросу разработчика</Badge>}
    </> : <>
      <Field label="Причина" id="cert-reason"><input id="cert-reason" value={reason} onChange={e => setReason(e.target.value)} /></Field>
      <p className="hint">Отзыв действует сразу у всех: выпуск перестаёт запускаться, работает прошлый проверенный.</p></>}
    <ErrorLine text={error} />
  </Dialog>;
}
