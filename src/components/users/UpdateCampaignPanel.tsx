import React, { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../store/store';
import { Btn, Input, Select, Dialog } from '../ui';
import { updateService, type UpdateDevice, type CampaignRelease } from '../../services/updateService';
import { isNewer } from '../../lib/updates';

const states: Record<string, string> = { idle: 'Без задания', delivered: 'Доставлено', scheduled: 'Запланировано', downloading: 'Загрузка', verifying: 'Проверка', ready: 'Готово', saving: 'Сохранение', restarting: 'Перезапуск', updated: 'Обновлено', delayed: 'Задержано', failed: 'Ошибка', cancelled: 'Отменено' };
export default function UpdateCampaignPanel({ employeeIds }: { employeeIds: string[] }) {
  const userId = useStore(s => s.user?.id);
  const [devices, setDevices] = useState<UpdateDevice[]>([]), [releases, setReleases] = useState<CampaignRelease[]>([]);
  const [version, setVersion] = useState(''), [scope, setScope] = useState(''), [minutes, setMinutes] = useState('10');
  const [selected, setSelected] = useState<Set<string>>(new Set()), [page, setPage] = useState(0);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [show, setShow] = useState(false);
  const [delegate, setDelegate] = useState(''), [request, setRequest] = useState(''), [code, setCode] = useState('');
  const [authorizationOpen, setAuthorizationOpen] = useState(false);
  const [cancelMode, setCancelMode] = useState(false);
  const [grant, setGrant] = useState<{ expiresAt: number; maxMinutes: number; maxTargets: number; publicKey: string } | null>(null);
  const refresh = async () => {
    try {
      const [data, authorization] = await Promise.all([updateService.devices(), updateService.delegation() as Promise<any>]);
      setDevices(data.devices); setReleases(data.releases); setScope(data.inst); setDelegate(authorization.code); setGrant(authorization.grant);
      setVersion(current => data.releases.some(r => r.version === current) ? current : data.releases[0]?.version || '');
      const native = (window as any).electron;
      if (native?.updateDevice) {
        const identity = await native.updateDevice();
        const body = { v: 1, inst: authorization.inst, userId: authorization.userId, publicKey: identity.publicKey };
        setRequest(`FLUXUPDAUTHREQ1.${btoa(JSON.stringify(body))}`);
        if (authorization.grant && authorization.grant.publicKey !== identity.publicKey) { setGrant(null); setError('Разрешение выдано для другого компьютера. Получите новое разрешение для этого устройства.'); }
        else setError('');
      } else setError('Назначение обновлений доступно в настольной программе.');
    } catch (e: any) { setGrant(null); setError(e.message); }
  };
  useEffect(() => { void refresh(); const timer = setInterval(() => { void refresh(); }, 60000); return () => clearInterval(timer); }, [userId]);
  const visible = useMemo(() => devices.filter(d => employeeIds.includes(d.userId)), [devices, employeeIds]);
  const old = visible.filter(d => d.version && isNewer(version, d.version));
  const unknown = visible.filter(d => !d.version).length;
  const targets = visible.filter(d => selected.has(d.deviceId) && d.version && isNewer(version, d.version));
  const cancellable = visible.filter(d => selected.has(d.deviceId) && d.action === 'schedule' && d.commandRelease);
  const offline = targets.filter(d => d.offline).length, inactive = targets.filter(d => !d.isActive).length;
  const groupIds = [...new Set(visible.map(d => d.userId))];
  const groups = groupIds.slice(page * 25, page * 25 + 25);
  const chosenRelease = releases.find(r => r.version === version);
  const delay = Number(minutes), validDelay = Number.isInteger(delay) && delay >= 5 && delay <= Math.min(1440, grant?.maxMinutes || 1440);
  const toggle = (id: string) => setSelected(prev => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });
  const assign = async () => {
    if (!delegate || (!cancelMode && (!chosenRelease || !targets.length || !validDelay))) return;
    setBusy(true); setError('');
    try {
      if (cancelMode) {
        const ids = [...new Set(cancellable.map(d => d.commandId))];
        for (const commandId of ids) {
          const group = cancellable.filter(d => d.commandId === commandId), r = group[0].commandRelease!, now = Date.now();
          const payload = { v: 1, id: crypto.randomUUID(), inst: scope, actor: userId, issuedAt: now, deadline: now, action: 'cancel',
            version: r.version, generation: r.generation, sha256: r.sha256, targets: group.map(d => ({ deviceId: d.deviceId, userId: d.userId, previous: d.commandId })) };
          const signed = await (window as any).electron.signUpdateCommand({ payload, delegation: delegate, releaseSignature: r.releaseSignature });
          await updateService.request('campaigns', signed);
        }
        setShow(false); setSelected(new Set()); await refresh(); return;
      }
      const now = Date.now(), payload = { v: 1, id: crypto.randomUUID(), inst: scope, actor: userId, issuedAt: now, deadline: now + delay * 60000,
        action: 'schedule', version: chosenRelease!.version, generation: chosenRelease!.generation, sha256: chosenRelease!.sha256,
        targets: targets.map(d => ({ deviceId: d.deviceId, userId: d.userId, previous: d.commandId })) };
      const signed = await (window as any).electron.signUpdateCommand({ payload, delegation: delegate, releaseSignature: chosenRelease!.signature });
      await updateService.request('campaigns', signed);
      setShow(false); setSelected(new Set()); await refresh();
    } catch (e: any) { setError(e.message || 'Задание не создано.'); } finally { setBusy(false); }
  };
  return <section className="border-b border-slate-200 dark:border-slate-800 py-3" aria-label="Обновления сотрудников">
    <div className="fx-group-title flex items-center justify-between"><span>Версии и обновления</span><Btn onClick={() => void refresh()} disabled={busy}>Проверить состояние</Btn></div>
    <div className="flex flex-wrap items-center gap-2 mb-2">
      <label className="fx-label">Выпуск <Select value={version} onChange={value => { setVersion(value); setSelected(new Set()); }} options={releases.length ? releases.map(r => ({ value: r.version, label: r.version })) : [{ value: '', label: 'Нет доступных выпусков' }]} /></label>
      <label className="fx-label">Через <Select value={['5', '10', '15', '30'].includes(minutes) ? minutes : 'custom'} onChange={value => setMinutes(value === 'custom' ? '60' : value)} options={[...[5, 10, 15, 30].map(n => ({ value: String(n), label: `${n} минут` })), { value: 'custom', label: 'Другое время' }]} /></label>
      {!['5', '10', '15', '30'].includes(minutes) && <Input type="number" min="5" max={grant?.maxMinutes || 1440} value={minutes} onChange={e => setMinutes(e.target.value)} aria-label="Минут до обновления" className="w-24" />}
      <Btn onClick={() => setSelected(new Set(old.map(d => d.deviceId)))} disabled={!version || !old.length}>Выбрать всех устаревших · {old.length}</Btn>
      {!!selected.size && <Btn onClick={() => setSelected(new Set())}>Снять выбор</Btn>}
      <Btn tone="primary" disabled={busy || !targets.length || !validDelay || !grant || grant.expiresAt <= Date.now() || targets.length > grant.maxTargets} onClick={() => { setCancelMode(false); setShow(true); }}>Назначить обновление</Btn>
      <Btn disabled={busy || !cancellable.length || !grant || grant.expiresAt <= Date.now()} onClick={() => { setCancelMode(true); setShow(true); }}>Отменить выбранные назначения</Btn>
    </div>
    <p className="fx-hint mb-2">Выбор учитывает фильтр сотрудников и все страницы. Выбрано устройств: {targets.length}; offline: {offline}; доступ закрыт: {inactive}. Версия неизвестна: {unknown}.</p>
    {!devices.length && <p className="fx-hint">Сведения появятся после первого входа сотрудников из обновлённой программы. Неизвестная версия не считается актуальной.</p>}
    {groups.map(id => {
      const rows = visible.filter(d => d.userId === id), versions = [...new Set(rows.map(d => d.version).filter(Boolean))];
      return <details key={id} className="border-t border-slate-100 dark:border-slate-850">
        <summary className="cursor-pointer py-2">{rows[0].name} · {versions.length > 1 ? 'Разные версии' : versions[0] || 'Версия неизвестна'} · устройств: {rows.length}</summary>
        <table className="fx-table w-full"><thead><tr><th>Выбор</th><th>Устройство</th><th>Версия</th><th>Обновление</th><th>Последняя связь</th></tr></thead><tbody>{rows.map(d => <tr key={d.deviceId} aria-selected={selected.has(d.deviceId)}>
          <td><input type="checkbox" checked={selected.has(d.deviceId)} disabled={!((d.version && isNewer(version, d.version)) || (d.action === 'schedule' && d.commandRelease))} onChange={() => toggle(d.deviceId)} aria-label={`Выбрать ${d.name}, устройство ${d.deviceId.slice(0, 8)}`} /></td>
          <td title={d.deviceId}>{d.deviceId.slice(0, 8)} · {d.platform}/{d.arch}</td><td className="tabular-nums">{d.version || 'Неизвестна'}</td>
          <td>{d.offline ? 'Offline' : d.commandId && d.status === 'idle' ? 'Запланировано' : states[d.status] || 'Неизвестно'}{d.targetVersion && d.action !== 'cancel' ? ` → ${d.targetVersion}` : ''}{d.code && <span className="fx-hint" title={d.code}> · требуется проверка</span>}</td>
          <td className="tabular-nums">{new Date(d.lastSeen).toLocaleString('ru')}</td>
        </tr>)}</tbody></table>
      </details>;
    })}
    {groupIds.length > 25 && <div className="flex items-center gap-2 mt-2"><Btn disabled={!page} onClick={() => setPage(page - 1)}>Назад</Btn><span className="fx-hint">{page + 1} / {Math.ceil(groupIds.length / 25)}</span><Btn disabled={(page + 1) * 25 >= groupIds.length} onClick={() => setPage(page + 1)}>Далее</Btn></div>}
    <details className="mt-3" open={authorizationOpen} onToggle={e => setAuthorizationOpen(e.currentTarget.open)}><summary className="cursor-pointer fx-hint">Разрешение на назначение обновлений</summary>
      {grant && <p className="fx-hint mt-2">Действует до {new Date(grant.expiresAt).toLocaleDateString('ru')}; до {grant.maxTargets} устройств за одно назначение.</p>}
      {!grant && <p className="fx-hint mt-2">Передайте запрос владельцу Flux и вставьте выданное разрешение. Оно действует только для вашего профиля на этом компьютере.</p>}
      <label className="fx-label block mt-2">Запрос владельцу<textarea className="fx-input w-full mt-1" value={request} readOnly rows={3} /></label>
      <label className="fx-label block mt-2">Разрешение владельца<textarea className="fx-input w-full mt-1" value={code} onChange={e => setCode(e.target.value)} rows={3} /></label>
      <Btn disabled={!code || busy} onClick={async () => { setBusy(true); try { await updateService.request('delegation', { code: code.trim() }); setCode(''); await refresh(); } catch (e: any) { setError(e.message); } finally { setBusy(false); } }}>Применить разрешение</Btn>
    </details>
    {!!error && <p className="fx-error mt-2" role="status">{error}</p>}
    {show && <Dialog title={cancelMode ? 'Отменить назначение' : 'Назначить обновление'} label="Назначение обновления" onClose={() => !busy && setShow(false)} footer={<><Btn disabled={busy} onClick={() => setShow(false)}>Отмена</Btn><Btn tone="primary" disabled={busy} onClick={() => void assign()}>{cancelMode ? 'Отменить назначения' : 'Подтвердить назначение'}</Btn></>}>
      {cancelMode ? <p>Отменить обязательное обновление на {cancellable.length} устройствах? История назначений сохранится. Уже установленная версия останется.</p> : <><p>Версия {version}. Устройств: {targets.length}. Обновление через {delay} минут.</p><p className="fx-hint mt-2">Offline: {offline}; доступ закрыт: {inactive}. Предыдущие назначения выбранных устройств будут заменены. Несохранённые документы остановят перезапуск, если их нельзя надёжно сохранить.</p></>}
      <ul className="mt-3 max-h-48 overflow-y-auto">{(cancelMode ? cancellable : targets).map(d => <li key={d.deviceId}>{d.name} · {d.deviceId.slice(0, 8)} · {d.version}</li>)}</ul>
      {!!error && <p className="fx-error mt-2">{error}</p>}
    </Dialog>}
  </section>;
}
