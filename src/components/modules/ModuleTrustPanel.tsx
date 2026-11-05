import React, { useCallback, useEffect, useState } from 'react';
import { Btn, Field, Input, Seg, Status, Toolbar } from '../ui';
import { moduleReleaseService, signAsOwner, type LocalModules, type ModuleReleaseRow } from '../../services/moduleReleaseService';
import OwnerSignDialog from './OwnerSignDialog';

type Dialog = null | { kind: 'revoke-release'; release: ModuleReleaseRow } | { kind: 'revoke-key' } | { kind: 'certify' };

/**
 * Выпуски, сертификаты разработчиков и отзывы — у владельца. Плюс проверка
 * «что запустит этот компьютер»: скачать выпуски и отдать главному процессу
 * на проверку подписи и кусков. Минимальный вид до раздела в Studio и Store.
 */
export default function ModuleTrustPanel() {
  const [releases, setReleases] = useState<ModuleReleaseRow[]>([]);
  const [certs, setCerts] = useState<Array<{ keyHex: string; userId: string; name: string }>>([]);
  const [local, setLocal] = useState<LocalModules | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const load = useCallback(() => {
    Promise.all([moduleReleaseService.releases(), moduleReleaseService.certificates(), moduleReleaseService.local()])
      .then(([r, c, l]) => { setReleases(r); setCerts(c); setLocal(l); }).catch((e) => setError(e.message));
  }, []);
  useEffect(load, [load]);
  const sync = async () => {
    setBusy(true); setError('');
    try { setLocal(await moduleReleaseService.sync()); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const running = new Map((local?.runnable || []).map((r) => [r.manifest.id, r.version]));

  return <div className="flex min-h-0 flex-1 flex-col overflow-auto">
    <Toolbar>
      <span className="font-semibold">Выпуски</span><span className="fx-n">{releases.length}</span>
      <span className="flex-1" />
      <Btn size="sm" onClick={() => setDialog({ kind: 'certify' })}>Выдать сертификат</Btn>
      <Btn size="sm" tone="danger" onClick={() => setDialog({ kind: 'revoke-key' })}>Отозвать ключ разработчика</Btn>
      <Btn size="sm" disabled={busy || !local} title={local ? '' : 'Проверка выпусков — в программе Flux на компьютере'} onClick={() => void sync()}>Проверить на этом компьютере</Btn>
    </Toolbar>
    {error && <div className="fx-error px-3 py-2">{error}</div>}
    <table className="fx-table">
      <thead><tr><th>Подпрограмма</th><th>Версия</th><th>Канал</th><th>Состояние</th><th>Здесь</th><th /></tr></thead>
      <tbody>{releases.map((r) => <tr key={r.id}>
        <td>{r.moduleId}</td><td className="tabular-nums">{r.version}</td><td>{r.channel === 'test' ? 'тестовый' : 'рабочий'}</td>
        <td>{r.state === 'revoked' ? <Status tone="rose">Отозван</Status> : <Status tone="emerald">Выпущен</Status>}</td>
        <td>{running.get(r.moduleId) === r.version ? <Status tone="emerald">Запускается</Status> : ''}</td>
        <td><div className="fx-row-acts">{r.state !== 'revoked' && <Btn size="sm" tone="ghost" onClick={() => setDialog({ kind: 'revoke-release', release: r })}>Отозвать</Btn>}</div></td>
      </tr>)}</tbody>
    </table>
    {local?.broken?.length ? <div className="px-3 py-2 text-sm">
      <div className="font-semibold">Не прошли проверку на этом компьютере</div>
      {local.broken.map((b) => <div key={`${b.moduleId}@${b.version}`}>{b.moduleId} {b.version} — {b.why}</div>)}
    </div> : null}
    <Toolbar><span className="font-semibold">Сертификаты разработчиков</span><span className="fx-n">{certs.length}</span></Toolbar>
    <table className="fx-table">
      <thead><tr><th>Профиль</th><th>Имя</th><th>Ключ</th></tr></thead>
      <tbody>{certs.map((c) => <tr key={c.keyHex}><td>{c.userId}</td><td>{c.name}</td><td className="font-mono text-xs">{c.keyHex}</td></tr>)}</tbody>
    </table>
    {dialog && <TrustDialog dialog={dialog} onClose={() => setDialog(null)} onDone={load} />}
  </div>;
}

function TrustDialog({ dialog, onClose, onDone }: { dialog: Exclude<Dialog, null>; onClose: () => void; onDone: () => void }) {
  const [key, setKey] = useState(''), [userId, setUserId] = useState(''), [name, setName] = useState(''), [reason, setReason] = useState('');
  const [scope, setScope] = useState<'key' | 'release'>('key');
  const title = dialog.kind === 'certify' ? 'Выдать сертификат разработчику' : dialog.kind === 'revoke-key' ? 'Отозвать ключ разработчика'
    : `Отозвать выпуск ${dialog.release.moduleId} ${dialog.release.version}`;
  return <OwnerSignDialog title={title} danger={dialog.kind !== 'certify'} action={dialog.kind === 'certify' ? 'Подписать сертификат' : 'Подписать отзыв'} onClose={onClose}
    onSign={async (password) => {
      const signed = dialog.kind === 'certify'
        ? await signAsOwner({ kind: 'certificate', key, userId, name }, password)
        : await signAsOwner({ kind: 'revocation', target: dialog.kind === 'revoke-key' ? scope : 'release',
          value: dialog.kind === 'revoke-release' ? `${dialog.release.moduleId}@${dialog.release.version}` : key, reason }, password);
      if (!signed) return 'Подпись отменена';
      await (dialog.kind === 'certify' ? moduleReleaseService.certify(signed) : moduleReleaseService.revoke(signed));
      onDone(); return '';
    }}>
    {dialog.kind === 'revoke-key' && <Field label="Что отозвать"><Seg value={scope} onChange={setScope} label="Что отозвать" options={[{ value: 'key', label: 'Ключ' }, { value: 'release', label: 'Выпуск по имени' }]} /></Field>}
    {dialog.kind !== 'revoke-release' && <Field label={scope === 'release' && dialog.kind === 'revoke-key' ? 'Выпуск (модуль@1.2.3)' : 'Открытый ключ разработчика (64 знака hex)'}>
      <Input className="font-mono" value={key} onChange={(e) => setKey(e.target.value.trim())} /></Field>}
    {dialog.kind === 'certify' && <>
      <Field label="Профиль (id)"><Input value={userId} onChange={(e) => setUserId(e.target.value.trim())} /></Field>
      <Field label="Имя"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
    </>}
    {dialog.kind !== 'certify' && <Field label="Причина"><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>}
    {dialog.kind !== 'certify' && <div className="fx-hint">Отзыв действует сразу у всех: выпуск перестаёт запускаться, работает прошлый проверенный.</div>}
  </OwnerSignDialog>;
}
