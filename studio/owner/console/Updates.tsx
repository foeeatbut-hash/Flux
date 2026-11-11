/**
 * Обновления Flux: назначение выпуска компьютерам сотрудников и отмена назначения.
 * Перенесено из Flux (вкладка «Обновления» в «Сотрудниках», UpdateCampaignPanel): администратору это
 * больше не доступно, назначает только владелец. Само назначение собирает и подписывает главный
 * процесс (studio/owner/src/campaigns.ts); выпуск обновления подписывается в окне «Лицензии и обновления Flux».
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { isNewer } from '../../../shared/versionCompare';
import { call } from './api';
import { Badge, Btn, Dialog, Empty, ErrorLine, useAction } from './ui';
import type { UpdateDevice, UpdateRelease } from './types';

const STATES: Record<string, string> = {
  idle: 'Без задания', delivered: 'Доставлено', scheduled: 'Запланировано', downloading: 'Загрузка', verifying: 'Проверка', ready: 'Готово',
  saving: 'Сохранение', restarting: 'Перезапуск', updated: 'Обновлено', delayed: 'Отложено', failed: 'Ошибка', cancelled: 'Отменено',
};
const key = (d: UpdateDevice) => `${d.deviceId}:${d.userId}`;
const PAGE = 25;

export default function Updates() {
  const [devices, setDevices] = useState<UpdateDevice[]>([]);
  const [releases, setReleases] = useState<UpdateRelease[]>([]);
  const [version, setVersion] = useState('');
  const [minutes, setMinutes] = useState('10');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(0);
  const [confirm, setConfirm] = useState<'schedule' | 'cancel' | null>(null);
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState('');
  const action = useAction();

  const refresh = useCallback(async () => {
    try {
      const data = await call<{ devices: UpdateDevice[]; releases: UpdateRelease[] }>('devices');
      setDevices(data.devices); setReleases(data.releases); setLoadError('');
      setVersion(current => data.releases.some(r => r.version === current) ? current : data.releases[0]?.version || '');
    } catch (e: any) { setLoadError(e.message); }
  }, []);
  useEffect(() => { void refresh(); const timer = setInterval(() => { void refresh(); }, 60000); return () => clearInterval(timer); }, [refresh]);

  const old = useMemo(() => devices.filter(d => d.version && isNewer(version, d.version)), [devices, version]);
  const targets = devices.filter(d => selected.has(key(d)) && d.version && isNewer(version, d.version));
  const cancellable = devices.filter(d => selected.has(key(d)) && d.action === 'schedule' && d.commandRelease);
  const groupIds = [...new Set(devices.map(d => d.userId))];
  const groups = groupIds.slice(page * PAGE, page * PAGE + PAGE);
  const delay = Number(minutes), validDelay = Number.isInteger(delay) && delay >= 5 && delay <= 1440;
  const toggle = (id: string) => setSelected(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const toggleGroup = (id: string) => setOpen(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });

  const assign = async (mode: 'schedule' | 'cancel') => {
    const chosen = (mode === 'cancel' ? cancellable : targets).map(key);
    const done = await action.run(() => call('assignUpdate', { action: mode, version, minutes: delay, devices: chosen }));
    setConfirm(null);
    if (done) { setSelected(new Set()); setNotice(mode === 'cancel' ? 'Назначение отменено.' : `Обновление ${version} назначено: ${chosen.length} устр.`); await refresh(); }
  };

  return <div className="pane">
    <div className="bar">
      <label>Выпуск <select aria-label="Выпуск" value={version} onChange={e => { setVersion(e.target.value); setSelected(new Set()); }}>
        {!releases.length && <option value="">Нет доступных выпусков</option>}{releases.map(r => <option key={r.version} value={r.version}>{r.version}</option>)}</select></label>
      <label>Через <select aria-label="Через сколько минут" value={['5', '10', '15', '30', '60'].includes(minutes) ? minutes : 'custom'} onChange={e => setMinutes(e.target.value === 'custom' ? '120' : e.target.value)}>
        {[5, 10, 15, 30, 60].map(n => <option key={n} value={n}>{n} мин</option>)}<option value="custom">Другое…</option></select></label>
      {!['5', '10', '15', '30', '60'].includes(minutes) && <input type="number" min={5} max={1440} value={minutes} onChange={e => setMinutes(e.target.value)} aria-label="Минут до обновления" style={{ width: 90 }} />}
      <span className="grow" />
      <Btn disabled={!version || !old.length} onClick={() => setSelected(new Set(old.map(key)))}>Выбрать всех устаревших · {old.length}</Btn>
      {!!selected.size && <Btn tone="ghost" onClick={() => setSelected(new Set())}>Снять выбор</Btn>}
      <Btn disabled={action.busy || !cancellable.length} onClick={() => setConfirm('cancel')}>Отменить выбранные назначения</Btn>
      <Btn tone="primary" disabled={action.busy || !targets.length || !validDelay} onClick={() => setConfirm('schedule')}>Назначить обновление</Btn>
    </div>
    <div className="bar muted">
      <span>Выбрано устройств: <b>{targets.length}</b></span><span>offline: {targets.filter(d => d.offline).length}</span>
      <span>доступ закрыт: {targets.filter(d => !d.isActive).length}</span><span>версия неизвестна: {devices.filter(d => !d.version).length}</span>
      <span className="grow" /><Btn onClick={() => void refresh()} disabled={action.busy}>Проверить состояние</Btn>
    </div>
    <ErrorLine text={loadError || action.error} />
    {notice && <div className="notice" role="status">{notice}</div>}
    <div className="scroll">
      {!devices.length ? <Empty title="Сведений об устройствах пока нет" text="Они появятся после первого входа сотрудников из обновлённой программы. Неизвестная версия не считается актуальной." />
        : <table className="tbl" data-testid="update-devices">
          <thead><tr><th>Сотрудник / устройство</th><th>Версия</th><th>Обновление</th><th>Последняя связь</th></tr></thead>
          <tbody>{groups.map(id => {
            const rows = devices.filter(d => d.userId === id), versions = [...new Set(rows.map(d => d.version).filter(Boolean))];
            const isOpen = open.has(id), stale = rows.some(d => d.version && isNewer(version, d.version));
            return <React.Fragment key={id}>
              <tr data-group={id}><td colSpan={4}>
                <button type="button" className="btn ghost" aria-expanded={isOpen} onClick={() => toggleGroup(id)}>{isOpen ? '▾' : '▸'} {rows[0].name} · {versions.length > 1 ? 'Разные версии' : versions[0] || 'Версия неизвестна'} · устройств: {rows.length}</button>
                {stale && <> <Badge tone="warn">устарела</Badge></>}</td></tr>
              {isOpen && rows.map(d => <tr key={d.deviceId} aria-selected={selected.has(key(d))}>
                <td title={d.deviceId}><label><input type="checkbox" checked={selected.has(key(d))} disabled={!((d.version && isNewer(version, d.version)) || (d.action === 'schedule' && d.commandRelease))}
                  onChange={() => toggle(key(d))} aria-label={`Выбрать ${d.name} ${d.deviceId.slice(0, 8)}`} /> {d.deviceId.slice(0, 8)} · {d.platform}/{d.arch}</label></td>
                <td>{d.version || 'Неизвестна'}</td>
                <td>{d.offline ? 'Offline' : d.commandId && d.status === 'idle' ? 'Запланировано' : STATES[d.status] || 'Неизвестно'}{d.targetVersion && d.action !== 'cancel' ? ` → ${d.targetVersion}` : ''}{d.code && <span className="muted" title={d.code}> · требуется проверка</span>}</td>
                <td>{new Date(d.lastSeen).toLocaleString('ru')}</td></tr>)}
            </React.Fragment>;
          })}</tbody></table>}
      {groupIds.length > PAGE && <div className="pad rows"><Btn disabled={!page} onClick={() => setPage(page - 1)}>Назад</Btn><span className="muted">{page + 1} / {Math.ceil(groupIds.length / PAGE)}</span>
        <Btn disabled={(page + 1) * PAGE >= groupIds.length} onClick={() => setPage(page + 1)}>Далее</Btn></div>}
    </div>
    {confirm && <Dialog title={confirm === 'cancel' ? 'Отменить назначение' : 'Назначить обновление'} onClose={() => !action.busy && setConfirm(null)} busy={action.busy}
      footer={<><Btn disabled={action.busy} onClick={() => setConfirm(null)}>Отмена</Btn><Btn tone="primary" disabled={action.busy} onClick={() => void assign(confirm)}>{confirm === 'cancel' ? 'Отменить назначение' : 'Назначить'}</Btn></>}>
      {confirm === 'cancel' ? <p>Отменить обязательное обновление на {cancellable.length} устройствах? История назначений сохранится. Уже установленная версия останется.</p>
        : <p>Версия {version}. Устройств: {targets.length}. Обновление начнётся через {delay} мин.</p>}
      <p className="hint">Перед подписью появится окно подтверждения. Назначение подписывается ключом издателя из вашего хранилища.</p>
      <ul>{(confirm === 'cancel' ? cancellable : targets).slice(0, 12).map(d => <li key={key(d)}>{d.name} · {d.deviceId.slice(0, 8)} · {d.version}</li>)}</ul>
      <ErrorLine text={action.error} />
    </Dialog>}
  </div>;
}
