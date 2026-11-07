import React, { useCallback, useEffect, useState } from 'react';
import { useStore } from '../store/store';
import { Empty, FilterSeg, SectionHead, Status, Tabs } from '../components/ui';
import PublishRequestView, { REQUEST_STATE } from '../components/modules/PublishRequestView';
import ModuleTrustPanel from '../components/modules/ModuleTrustPanel';
import { moduleReleaseService, type PublishRequest } from '../services/moduleReleaseService';

/**
 * Запросы на публикацию модулей — у владельца (docs/roadmap/modules.md,
 * «Запрос на публикацию и проверка владельцем»). Без этого ни один выпуск до
 * пользователей не доходит: выпуск подписывает только владелец.
 *
 * Минимальный вид: очередь, файлы и разница, решения, выпуски и отзывы.
 * Полноценный раздел — в Flux Studio (этап 4).
 */
export default function ModuleRequests() {
  const user = useStore((s) => s.user);
  const [tab, setTab] = useState<'requests' | 'releases'>('requests');
  const [filter, setFilter] = useState<'pending' | 'all'>('pending');
  const [list, setList] = useState<PublishRequest[]>([]);
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');
  const owner = user?.role === 'OWNER';
  const load = useCallback(() => {
    if (!owner) return;
    moduleReleaseService.requests().then(setList).catch((e) => setError(e.message));
  }, [owner]);
  useEffect(load, [load]);
  if (!owner) return <Empty title="Запросы на публикацию проверяет владелец" text="Выпуск подпрограммы подписывает только владелец программы." />;

  const pending = list.filter((r) => r.state === 'pending');
  const shown = filter === 'pending' ? pending : list;
  const current = list.find((r) => r.id === selected) || shown[0];
  return <div className="flex h-full min-h-0 flex-col bg-[var(--flux-surface)] text-[var(--flux-text)]">
    <SectionHead title="Запросы на публикацию" count={`${pending.length} ждут решения`}>
      <Tabs value={tab} onChange={setTab} label="Раздел" tabs={[{ value: 'requests', label: 'Запросы', count: pending.length }, { value: 'releases', label: 'Выпуски и сертификаты' }]} />
    </SectionHead>
    {error && <div className="fx-error px-3 py-2">{error}</div>}
    {tab === 'releases' ? <ModuleTrustPanel /> : <div className="flex min-h-0 flex-1">
      <div className="fx-side w-72 shrink-0 flex flex-col min-h-0">
        <div className="p-2"><FilterSeg value={filter} onChange={setFilter} label="Показать" options={[
          { value: 'pending', label: 'Ждут', count: pending.length }, { value: 'all', label: 'Все', count: list.length }]} /></div>
        <div className="overflow-auto flex-1">
          {shown.map((r) => <button key={r.id} type="button" className="fx-li w-full text-left" aria-current={current?.id === r.id} onClick={() => setSelected(r.id)}
            title={`${r.byOwner ? 'владелец' : r.authorId} · ${r.meta?.changelog.split('\n')[0] || ''}`}>
            <span className="flex-1 truncate">{r.moduleId} {r.version}</span><Status tone={REQUEST_STATE[r.state].tone}>{REQUEST_STATE[r.state].label}</Status>
          </button>)}
          {!shown.length && <Empty title="Запросов нет" text="Разработчики отправляют подпрограммы на проверку из Flux Studio." />}
        </div>
      </div>
      {current ? <PublishRequestView key={current.id} request={current} onChanged={load} /> : <Empty title="Выберите запрос" />}
    </div>}
  </div>;
}
