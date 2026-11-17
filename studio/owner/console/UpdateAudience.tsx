/**
 * Обычное обновление сотрудникам и подразделениям («Flux: обновления» → «Кому»).
 *
 * Владелец выбирает выпуск, подразделения и сотрудников; у выбранных появляется плашка обновления,
 * отложить его можно кнопкой «Позже». Состав подразделения считается на момент проверки: добавленный
 * позже получает обновление, выведенный — перестаёт, если ещё не поставил. Обязательное обновление со
 * сроком назначается по компьютерам (раздел «По компьютерам»).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { coversUser } from '../../../server/updateAudience';
import { call } from './api';
import { Badge, Btn, Empty, ErrorLine, Field, useAction } from './ui';
import type { AudienceDepartment, AudienceState } from './types';

/** Дерево подразделений плоским списком с уровнем вложенности: порядок «родитель, затем его дети» */
export function flattenDepartments(list: AudienceDepartment[]): Array<AudienceDepartment & { level: number }> {
  const byParent = new Map<string, AudienceDepartment[]>(), known = new Set(list.map(d => d.id)), out: Array<AudienceDepartment & { level: number }> = [];
  for (const d of list) { const key = d.parentId && known.has(d.parentId) ? d.parentId : ''; byParent.set(key, [...(byParent.get(key) || []), d]); }
  const walk = (parent: string, level: number, seen: Set<string>) => {
    for (const d of byParent.get(parent) || []) { if (seen.has(d.id)) continue; seen.add(d.id); out.push({ ...d, level }); walk(d.id, level + 1, seen); }
  };
  walk('', 0, new Set());
  return out;
}
const SHOWN_PEOPLE = 150;

export default function UpdateAudience() {
  const [state, setState] = useState<AudienceState | null>(null);
  const [version, setVersion] = useState('');
  const [units, setUnits] = useState<Set<string>>(new Set());
  const [people, setPeople] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [notice, setNotice] = useState('');
  const [loadError, setLoadError] = useState('');
  const action = useAction();

  const refresh = useCallback(async () => {
    try {
      const data = await call<AudienceState>('updateAudience');
      setState(data); setLoadError('');
      setVersion(current => data.releases.some(r => r.version === current) ? current : data.releases[0]?.version || '');
      // Подразделение ушло в архив или сотрудник удалён, пока список был открыт: выбор не держит несуществующего
      setUnits(prev => new Set([...prev].filter(id => data.departments.some(d => d.id === id))));
      setPeople(prev => new Set([...prev].filter(id => data.users.some(u => u.id === id))));
    } catch (e: any) { setLoadError(e.message); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const tree = useMemo(() => flattenDepartments(state?.departments || []), [state]);
  const covered = useMemo(() => state
    ? state.users.filter(u => coversUser({ v: 1, id: '', version, generation: '', userIds: [...people], departmentIds: [...units], createdAt: 0, createdBy: '' }, u, state.departments)).length : 0, [state, people, units, version]);
  const query = search.trim().toLowerCase();
  const matches = useMemo(() => (state?.users || []).filter(u => !query || u.name.toLowerCase().includes(query) || u.symbol.toLowerCase().includes(query)), [state, query]);
  const toggle = (set: Set<string>, put: (s: Set<string>) => void, id: string) => { const next = new Set(set); if (next.has(id)) next.delete(id); else next.add(id); put(next); };
  const nobody = !units.size && !people.size;

  const assign = async () => {
    const done = await action.run(() => call('assignAudience', { version, userIds: [...people], departmentIds: [...units] }));
    if (done) { setUnits(new Set()); setPeople(new Set()); setNotice(`Обновление ${version} назначено: получат ${covered} чел.`); await refresh(); }
  };
  const cancel = async (id: string, label: string) => {
    const done = await action.run(() => call('cancelAudience', { id }));
    if (done) { setNotice(`Назначение ${label} отменено.`); await refresh(); }
  };

  if (!state) return <div className="pane"><ErrorLine text={loadError} />{!loadError && <p className="muted pad">Загрузка…</p>}</div>;
  return <div className="pane">
    <div className="bar">
      <label>Выпуск <select aria-label="Выпуск" value={version} onChange={e => setVersion(e.target.value)}>
        {!state.releases.length && <option value="">Нет доступных выпусков</option>}{state.releases.map(r => <option key={r.version} value={r.version}>{r.version}</option>)}</select></label>
      <span className="muted">Получат сейчас: <b>{covered}</b> чел.</span>
      <span className="grow" />
      {!nobody && <Btn tone="ghost" onClick={() => { setUnits(new Set()); setPeople(new Set()); }}>Снять выбор</Btn>}
      <Btn tone="primary" disabled={action.busy || !version || nobody} onClick={() => void assign()}>Назначить обновление</Btn>
    </div>
    <ErrorLine text={loadError || action.error} />
    {notice && <div className="notice" role="status">{notice}</div>}
    <div className="scroll">
      <div className="cols">
        <section className="sect" aria-label="Подразделения">
          <h3>Подразделения</h3>
          <p className="hint">Выбранное подразделение включает вложенные.</p>
          {!tree.length ? <p className="muted">Подразделений пока нет. Они создаются в разделе «Сотрудники».</p>
            : <div className="people">{tree.map(d => <label key={d.id} className="person" style={{ paddingLeft: d.level * 16 }}>
              <input type="checkbox" checked={units.has(d.id)} onChange={() => toggle(units, setUnits, d.id)} aria-label={`Подразделение ${d.name}`} /> {d.name}</label>)}</div>}
        </section>
        <section className="sect" aria-label="Сотрудники">
          <h3>Сотрудники</h3>
          <Field label="Поиск по имени или табельному номеру" id="audience-search"><input id="audience-search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Иванов" /></Field>
          <div className="people">{matches.slice(0, SHOWN_PEOPLE).map(u => <label key={u.id} className="person">
            <input type="checkbox" checked={people.has(u.id)} onChange={() => toggle(people, setPeople, u.id)} aria-label={`Сотрудник ${u.name}`} /> {u.name}{!u.isActive && <> <Badge tone="warn">доступ закрыт</Badge></>}</label>)}
            {!matches.length && <p className="muted">Никого не нашли.</p>}
            {matches.length > SHOWN_PEOPLE && <p className="muted">Показаны первые {SHOWN_PEOPLE} из {matches.length}: уточните поиск.</p>}</div>
        </section>
      </div>
      <div className="sect">
        <h3>Назначено</h3>
        {!state.assignments.length ? <Empty title="Назначений пока нет" text="Выберите выпуск, подразделения и сотрудников и нажмите «Назначить обновление»." />
          : <table className="tbl" data-testid="update-assignments">
            <thead><tr><th>Выпуск</th><th>Кому</th><th>Получают сейчас</th><th>Когда</th><th /></tr></thead>
            <tbody>{state.assignments.map(a => <tr key={a.id}>
              <td>{a.version}</td>
              <td>{[...a.units, ...a.people].join(', ') || '—'}</td>
              <td>{a.cancelledAt ? <Badge>отменено</Badge> : `${a.covered} чел.`}</td>
              <td>{new Date(a.createdAt).toLocaleString('ru')}</td>
              <td>{!a.cancelledAt && <Btn tone="ghost" disabled={action.busy} aria-label={`Отменить назначение ${a.version}`} onClick={() => void cancel(a.id, a.version)}>Отменить</Btn>}</td></tr>)}</tbody></table>}
      </div>
    </div>
  </div>;
}
