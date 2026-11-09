/**
 * «Журнал подпрограмм»: что подпрограммы делали на компьютерах людей. Владелец и
 * администратор видят всё, разработчик — только свои подпрограммы и без людей;
 * решает сервер, окно только показывает то, что он отдал. Содержимого вызовов и
 * данных проектов в записях нет.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Btn, Input, Select, Status } from '../ui';
import { CATEGORY_NAMES, JOURNAL_CATEGORIES, type JournalCategory, type JournalLevel } from '../../../modules/journal/model';
import { call } from '../../services/moduleReleaseService';

interface Row {
  id: string; userId?: string; userName?: string; moduleId: string; version: string; category: JournalCategory; level: JournalLevel;
  event: string; detail: string; outcome: string; ms: number; bytesIn: number; bytesOut: number; at: string;
}
const LEVEL_TONE = { info: 'slate', warn: 'amber', error: 'rose' } as const;
const PERIODS = [{ value: '1', label: 'Сутки' }, { value: '7', label: 'Неделя' }, { value: '30', label: 'Месяц' }];

export default function ModuleJournalView({ moduleNames = {} }: { moduleNames?: Record<string, string> }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [role, setRole] = useState<'admin' | 'developer'>('developer');
  const [error, setError] = useState('');
  const [filters, setFilters] = useState({ moduleId: '', version: '', userId: '', level: '', category: '', days: '7' });
  const query = useCallback((extra = '') => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) if (v && k !== 'days') p.set(k, v);
    p.set('from', String(Date.now() - Number(filters.days) * 86_400_000));
    return `/journal?${p.toString()}${extra}`;
  }, [filters]);
  const load = useCallback(() => {
    setError('');
    call<{ entries: Row[]; role: 'admin' | 'developer' }>('GET', query('&limit=200')).then(r => { setRows(r.entries); setRole(r.role); }).catch(e => { setRows([]); setError(e.message); });
  }, [query]);
  useEffect(load, [load]);
  const set = (key: keyof typeof filters) => (value: string) => setFilters(f => ({ ...f, [key]: value }));
  const exportCsv = async () => {
    const res = await fetch(`/api/modules${query('&format=csv')}`);
    if (!res.ok) { setError('Не удалось выгрузить журнал'); return; }
    const link = document.createElement('a');
    link.href = URL.createObjectURL(await res.blob());
    link.download = 'module-journal.csv';
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  };
  const name = (id: string) => moduleNames[id] || id;
  return <div data-testid="module-journal">
    <div className="stx-h">Журнал подпрограмм</div>
    <div className="fx-hint mb-2">{role === 'admin' ? 'Записи всех компьютеров за последние 30 дней. Содержимого вызовов и данных проектов в журнале нет.'
      : 'Только ваши подпрограммы, без имён людей и проектов. Записи хранятся 30 дней.'}</div>
    <div className="mb-3 flex flex-wrap items-end gap-2">
      <Input placeholder="Подпрограмма (идентификатор)" aria-label="Подпрограмма" value={filters.moduleId} onChange={e => set('moduleId')(e.target.value.trim())} />
      <Input placeholder="Версия" aria-label="Версия" value={filters.version} onChange={e => set('version')(e.target.value.trim())} style={{ width: 100 }} />
      {role === 'admin' && <Input placeholder="Пользователь (идентификатор)" aria-label="Пользователь" value={filters.userId} onChange={e => set('userId')(e.target.value.trim())} />}
      <Select value={filters.level} onChange={set('level')} aria-label="Уровень" options={[{ value: '', label: 'Все уровни' }, { value: 'info', label: 'info' }, { value: 'warn', label: 'warn' }, { value: 'error', label: 'error' }]} />
      <Select value={filters.category} onChange={set('category')} aria-label="Вид записей" options={[{ value: '', label: 'Все виды' }, ...JOURNAL_CATEGORIES.map(c => ({ value: c, label: CATEGORY_NAMES[c] }))]} />
      <Select value={filters.days} onChange={set('days')} aria-label="Период" options={PERIODS} />
      <Btn size="sm" onClick={() => void exportCsv()} data-testid="journal-export">Выгрузить CSV</Btn>
    </div>
    {error && <div className="fx-error mb-2">{error}</div>}
    {!rows ? <div className="stx-note">Загрузка…</div> : rows.length === 0 ? <div className="stx-note">За выбранный период записей нет.</div>
      : <table className="fx-table" data-testid="journal-table"><thead><tr><th>Когда</th>{role === 'admin' && <th>Кто</th>}<th>Подпрограмма</th><th>Вид</th><th>Событие</th><th>Итог</th><th>мс</th><th>Объём, Б</th></tr></thead>
        <tbody>{rows.map(r => <tr key={r.id}>
          <td>{new Date(r.at).toLocaleString('ru-RU')}</td>{role === 'admin' && <td>{r.userName || r.userId}</td>}
          <td>{name(r.moduleId)} <span className="fx-hint">{r.version}</span></td><td>{CATEGORY_NAMES[r.category]}</td>
          <td><Status tone={LEVEL_TONE[r.level]}>{r.level}</Status> {r.event}{r.detail ? ` · ${r.detail}` : ''}</td>
          <td>{r.outcome}</td><td className="tabular-nums">{r.ms || ''}</td><td className="tabular-nums">{r.bytesIn || r.bytesOut ? `${r.bytesIn}/${r.bytesOut}` : ''}</td></tr>)}</tbody></table>}
  </div>;
}
