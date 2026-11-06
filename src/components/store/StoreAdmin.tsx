/**
 * Администрирование Store: допуск, закрепление версии, обязательные для должностей, журнал.
 * Видят администратор и владелец; решает сервер, окно только показывает кнопки.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Btn, Select, Status, Tabs } from '../ui';
import { STATUS_NAMES, type StoreListing, type StoreStatus } from '../../../modules/store/model';
import { moduleStoreApi, type AdminData } from '../../services/moduleStoreService';
import { refreshStore } from '../../services/moduleStoreActions';

type Tab = 'admission' | 'versions' | 'log';
const ACTIONS: Record<string, string> = {
  install: 'поставил', update: 'обновил', rollback: 'вернул версию', uninstall: 'удалил', 'admission-admitted': 'допустил в Store', 'admission-delisted': 'снял из Store',
  'admission-banned': 'запретил', 'admission-pending': 'вернул на проверку', deprecate: 'пометил устаревшей', undeprecate: 'снял пометку «устаревшая»',
  pin: 'закрепил версию', unpin: 'снял закрепление', required: 'сделал обязательной', unrequired: 'снял обязательность', 'auto-on': 'включил автообновление', 'auto-off': 'выключил автообновление',
};
const tone = (s: StoreStatus) => (s === 'admitted' ? 'emerald' : s === 'pending' ? 'amber' : 'rose');

export default function StoreAdmin() {
  const [tab, setTab] = useState<Tab>('admission');
  const [data, setData] = useState<AdminData | null>(null);
  const [roles, setRoles] = useState<Array<{ code: string; name: string }>>([]);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    Promise.all([moduleStoreApi.admin(), moduleStoreApi.roles()]).then(([d, r]) => { setData(d); setRoles(r); }).catch((e) => setError(e.message));
  }, []);
  useEffect(load, [load]);
  const act = async (fn: () => Promise<unknown>) => { setError(''); try { await fn(); load(); await refreshStore(); } catch (e: any) { setError(e.message); } };
  if (!data) return <div className="stx-note">{error || 'Загрузка…'}</div>;
  const waiting = data.listings.filter((l) => l.status === 'pending').length;
  const name = (id: string) => data.listings.find((l) => l.moduleId === id)?.name || id;
  return <div data-testid="stx-admin">
    <div className="stx-h">Администрирование Store</div>
    <Tabs label="Администрирование" value={tab} onChange={setTab} tabs={[{ value: 'admission', label: 'Допуск', count: waiting }, { value: 'versions', label: 'Версии и обязательные' }, { value: 'log', label: 'Журнал' }]} />
    {error && <div className="fx-error my-2">{error}</div>}
    {tab === 'admission' && <table className="fx-table mt-3"><thead><tr><th>Подпрограмма</th><th>Версия</th><th>Состояние</th><th>Установлена у</th><th>Сбои версии</th><th /></tr></thead>
      <tbody>{data.listings.map((l) => <AdmissionRow key={l.moduleId} l={l} spread={data.spread[l.moduleId]} act={act} />)}</tbody></table>}
    {tab === 'versions' && <div className="mt-3 grid gap-3">{data.listings.map((l) => <VersionsRow key={l.moduleId} l={l} spread={data.spread[l.moduleId] || {}} entry={data.entries.find((e) => e.moduleId === l.moduleId)} roles={roles} act={act} />)}</div>}
    {tab === 'log' && <table className="fx-table mt-3" data-testid="stx-log"><thead><tr><th>Когда</th><th>Кто</th><th>Что</th><th>Подпрограмма</th><th>Версия</th></tr></thead>
      <tbody>{data.logs.map((r) => <tr key={r.id}><td>{new Date(r.createdAt).toLocaleString('ru-RU')}</td><td>{r.userName || r.userId}</td><td>{ACTIONS[r.action] || r.action}</td>
        <td>{r.moduleId === '*' ? '—' : name(r.moduleId)}</td><td className="tabular-nums">{r.fromVersion ? `${r.fromVersion} → ` : ''}{r.toVersion}</td></tr>)}</tbody></table>}
  </div>;
}

function AdmissionRow({ l, spread, act }: { l: StoreListing; spread?: Record<string, number>; act: (fn: () => Promise<unknown>) => void }) {
  const total = Object.values(spread || {}).reduce((a, b) => a + b, 0);
  const set = (status: string, deprecated?: boolean) => act(() => moduleStoreApi.admission(l.moduleId, { status, deprecated }));
  return <tr>
    <td><b>{l.name}</b><div className="fx-hint">{l.developer}</div></td><td className="tabular-nums">{l.version}</td>
    <td><Status tone={tone(l.status)}>{STATUS_NAMES[l.status]}</Status>{l.deprecated && <> <Status tone="slate">устаревшая</Status></>}</td>
    <td>{total}</td>
    <td>{l.crashes ? <span title="Всплеск сбоев после выпуска: подумайте об отзыве выпуска у владельца">{l.crashes.count} в {l.crashes.version}</span> : '—'}</td>
    <td><div className="fx-row-acts">
      {l.status !== 'admitted' && <Btn size="sm" tone="primary" onClick={() => set('admitted')}>Допустить</Btn>}
      {l.status === 'admitted' && <Btn size="sm" onClick={() => set('delisted')}>Снять из Store</Btn>}
      <Btn size="sm" onClick={() => set(l.status, !l.deprecated)}>{l.deprecated ? 'Снять «устаревшая»' : 'Устаревшая'}</Btn>
      {l.status !== 'banned' && <Btn size="sm" tone="danger" title="Удалится у всех; данные сохранятся" onClick={() => set('banned')}>Запретить</Btn>}
    </div></td></tr>;
}

function VersionsRow({ l, spread, entry, roles, act }: { l: StoreListing; spread: Record<string, number>; entry: any; roles: Array<{ code: string; name: string }>; act: (fn: () => Promise<unknown>) => void }) {
  const live = l.versions.filter((v) => !v.revoked);
  const [pin, setPin] = useState<string>(entry?.pinVersion || '');
  const [req, setReq] = useState<string>(entry?.requiredVersion || live[0]?.version || '');
  const parse = (t: string): string[] => { try { return JSON.parse(t || '[]'); } catch { return []; } };
  const [pinRoles, setPinRoles] = useState<string[]>(parse(entry?.pinRoles));
  const [reqRoles, setReqRoles] = useState<string[]>(parse(entry?.requiredRoles));
  const toggle = (list: string[], set: (v: string[]) => void, code: string) => set(list.includes(code) ? list.filter((c) => c !== code) : [...list, code]);
  const options = [{ value: '', label: 'не закреплять' }, ...live.map((v) => ({ value: v.version, label: v.version }))];
  const picker = (list: string[], set: (v: string[]) => void) => <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">{roles.map((r) =>
    <label key={r.code} className="flex items-center gap-1"><input type="checkbox" checked={list.includes(r.code)} onChange={() => toggle(list, set, r.code)} />{r.name}</label>)}</div>;
  return <div className="stx-block"><h3>{l.name}</h3>
    <div className="text-xs mb-2" style={{ color: 'var(--flux-text-muted)' }}>У кого какая версия: {Object.entries(spread).map(([v, n]) => `${v} — ${n}`).join(', ') || 'никто не поставил'}</div>
    <div className="grid gap-3 md:grid-cols-2">
      <div className="grid gap-2"><b className="text-sm">Закрепить версию</b>
        <Select value={pin} onChange={setPin} options={options} />
        {picker(pinRoles, setPinRoles)}<div className="fx-hint">Роли не выбраны — для всех. Пользователи не обновят выше.</div>
        <div><Btn size="sm" onClick={() => act(() => moduleStoreApi.pin(l.moduleId, pin || null, pinRoles))}>Сохранить закрепление</Btn></div></div>
      <div className="grid gap-2"><b className="text-sm">Обязательная для должностей</b>
        <Select value={req} onChange={setReq} options={live.map((v) => ({ value: v.version, label: v.version }))} />
        {picker(reqRoles, setReqRoles)}<div className="fx-hint">Ставится сама в выбранной версии; обновляет администратор или человек сам.</div>
        <div><Btn size="sm" onClick={() => act(() => moduleStoreApi.required(l.moduleId, req, reqRoles))}>{reqRoles.length ? 'Сохранить' : 'Снять обязательность'}</Btn></div></div>
    </div></div>;
}
