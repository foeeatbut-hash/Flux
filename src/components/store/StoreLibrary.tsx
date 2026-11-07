/**
 * Библиотека: установленное, обновления, подпрограммы с других компьютеров, загрузки.
 */
import React, { useState } from 'react';
import { Switch, Tabs } from '../ui';
import { compareVersions } from '../../../shared/versionCompare';
import { updateAvailable, formatSize, type StoreListing } from '../../../modules/store/model';
import { useModuleStore } from '../../store/moduleStoreState';
import { autoOn, installModule, rollbackModule, setAutoUpdate, setModuleAuto, updateAll } from '../../services/moduleStoreActions';
import { ActionButton, ModuleIcon, Ring, type ActionKind } from './StoreParts';

type Tab = 'installed' | 'updates';

export default function StoreLibrary({ initialTab = 'installed', listings, onOpen, onAct, onRemove }: { initialTab?: Tab; listings: StoreListing[]; onOpen: (l: StoreListing) => void; onAct: (l: StoreListing, k: ActionKind) => void; onRemove: (l: StoreListing) => void }) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [message, setMessage] = useState('');
  const local = useModuleStore((s) => s.local);
  const autoUpdate = useModuleStore((s) => s.autoUpdate);
  const busy = useModuleStore((s) => s.busy);
  const mine = listings.filter((l) => l.mine);
  const updates = mine.filter(updateAvailable);
  const here = (l: StoreListing) => !!local?.installed[l.moduleId];
  const elsewhere = local ? mine.filter((l) => !here(l)) : [];
  const run = async (fn: () => Promise<unknown>) => { setMessage(''); try { await fn(); } catch (e: any) { setMessage(e?.message || 'Не выполнено'); } };
  const previous = (l: StoreListing) => !!l.mine && (local?.available || []).some((a) => a.moduleId === l.moduleId && compareVersions(a.version, l.mine!.version) < 0);

  return <div data-testid="stx-library">
    <div className="stx-h">Библиотека</div>
    <div className="mb-3 flex flex-wrap items-center gap-3">
      <Tabs label="Библиотека" value={tab} onChange={setTab} tabs={[{ value: 'installed', label: 'Установленные', count: mine.length }, { value: 'updates', label: 'Обновления', count: updates.length }]} />
      <span className="flex-1" />
      <label className="flex items-center gap-2 text-sm" title="Включённое ставит новую версию при следующем запуске Flux, а не посреди работы">
        <Switch checked={autoUpdate} onChange={(v) => void run(() => setAutoUpdate(v))} label="Автообновление подпрограмм" />Автообновление</label>
      {tab === 'updates' && updates.length > 0 && <button type="button" className="stx-act" onClick={() => void run(async () => { const r = await updateAll(); if (r.failed.length) throw new Error(r.failed.join('; ')); })}>Обновить все</button>}
    </div>
    {message && <div className="fx-error mb-2">{message}</div>}
    {Object.keys(busy).length > 0 && <div className="stx-note flex items-center gap-2" data-testid="stx-downloads"><Ring label="Загрузка" />
      {Object.entries(busy).map(([id, text]) => `${listings.find((l) => l.moduleId === id)?.name || id}: ${text}`).join(' · ')}</div>}

    {tab === 'installed' && <div className="grid gap-2">
      {mine.length === 0 && <div className="stx-note">Установленных подпрограмм пока нет. Выберите их в Store.</div>}
      {mine.filter(here).map((l) => <div key={l.moduleId} className="stx-card" style={{ cursor: 'default' }}>
        <ModuleIcon listing={l} size={48} />
        <div className="stx-card-body"><button type="button" className="stx-card-name" style={{ background: 'none', border: 0, padding: 0, color: 'inherit', font: 'inherit', fontWeight: 600, cursor: 'pointer' }} onClick={() => onOpen(l)}>{l.name}</button>
          <div className="stx-card-sub">Версия {l.mine!.version}{l.mine!.source === 'required' ? ' · обязательная для должности' : ''}{updateAvailable(l) ? ` · доступна ${l.version}` : ''}
            {local?.fallbacks[l.moduleId] ? ` · запущена ${local.fallbacks[l.moduleId].running || '—'}: выбранная версия больше не проходит проверку` : ''}</div></div>
        <label className="flex items-center gap-2 text-xs" title="Свой переключатель подпрограммы: перекрывает общий">
          <Switch checked={autoOn(l, autoUpdate)} onChange={(v) => void run(() => setModuleAuto(l.moduleId, l.mine!.version, v ? 'on' : 'off'))} label={`Автообновление ${l.name}`} />авто</label>
        <button type="button" className="fx-btn" disabled={!previous(l)} title={previous(l) ? 'Версия лежит на этом компьютере: связь не нужна' : 'Прошлой версии на этом компьютере нет'}
          onClick={() => void run(() => rollbackModule(l.moduleId))}>Вернуть предыдущую версию</button>
        <ActionButton listing={l} onAct={(k) => onAct(l, k)} />
        {!l.required && <button type="button" className="fx-btn" onClick={() => onRemove(l)}>Удалить</button>}
      </div>)}
      {elsewhere.length > 0 && <><div className="stx-h" style={{ fontSize: 16 }}>Ваши подпрограммы на других компьютерах</div>
        {elsewhere.map((l) => <div key={l.moduleId} className="stx-card" style={{ cursor: 'default' }}><ModuleIcon listing={l} size={48} />
          <div className="stx-card-body"><div className="stx-card-name">{l.name}</div><div className="stx-card-sub">Версия {l.mine!.version}</div></div>
          <button type="button" className="stx-act" onClick={() => void run(() => installModule(l))}>Установить здесь</button></div>)}</>}
    </div>}

    {tab === 'updates' && <div className="grid gap-2" data-testid="stx-updates">
      {updates.length === 0 && <div className="stx-note">Всё обновлено.</div>}
      {updates.map((l) => <div key={l.moduleId} className="stx-card" style={{ cursor: 'default' }}><ModuleIcon listing={l} size={48} />
        <div className="stx-card-body"><div className="stx-card-name">{l.name}: {l.mine!.version} → {l.version}</div>
          <div className="stx-card-sub" style={{ whiteSpace: 'normal' }}>{l.changelog || 'Описание не указано'} · {formatSize(l.size)}</div></div>
        <ActionButton listing={l} onAct={(k) => onAct(l, k)} /></div>)}
    </div>}
  </div>;
}
