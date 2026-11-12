/**
 * Политика подключений для администратора: запретить подключение программы роли (или всем).
 * Запрет сильнее выбора человека; хранит и применяет сервер, главный процесс получает его через окно.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Btn, Select } from '../ui';
import { call } from '../../services/moduleReleaseService';
import type { StoreListing } from '../../../modules/store/model';

interface Rule { moduleId: string; connection: string; roles: string[] }

export default function ConnectionPolicy({ listings, roles }: { listings: StoreListing[]; roles: Array<{ code: string; name: string }> }) {
  const withConnections = listings.filter((l) => (l.manifest.connections || []).length > 0);
  const [rules, setRules] = useState<Rule[]>([]);
  const [moduleId, setModuleId] = useState('');
  const [connection, setConnection] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState('');
  const load = useCallback(() => { call<{ rules: Rule[] }>('GET', '/connection-policy/rules').then((r) => setRules(r.rules)).catch((e) => setError(e.message)); }, []);
  useEffect(load, [load]);
  const save = async (next: Rule[]) => { setError(''); try { await call('PUT', '/connection-policy/rules', { rules: next }); setRules(next); } catch (e: any) { setError(e.message); } };
  const chosen = withConnections.find((l) => l.moduleId === moduleId);
  return <div className="mt-3 flex flex-col gap-3" data-testid="connection-policy">
    <div className="fx-hint">Запрещённое здесь программа не получит, даже если человек выбрал «Разрешить всегда». Без ролей запрет действует на всех.</div>
    {error && <div className="fx-error">{error}</div>}
    <table className="fx-table"><thead><tr><th>Программа</th><th>Подключение</th><th>Роли</th><th /></tr></thead>
      <tbody>{rules.length === 0 && <tr><td colSpan={4}>Запретов нет.</td></tr>}
        {rules.map((r, i) => <tr key={`${r.moduleId}:${r.connection}:${i}`}><td>{listings.find((l) => l.moduleId === r.moduleId)?.name || r.moduleId}</td><td>{r.connection}</td>
          <td>{r.roles.length ? r.roles.join(', ') : 'все'}</td><td><Btn size="sm" onClick={() => void save(rules.filter((_, j) => j !== i))}>Снять запрет</Btn></td></tr>)}</tbody></table>
    <div className="flex flex-wrap items-center gap-2">
      <Select value={moduleId} onChange={(v) => { setModuleId(v); setConnection(''); }} aria-label="Программа" className="w-56" options={[{ value: '', label: 'Программа…' }, ...withConnections.map((l) => ({ value: l.moduleId, label: l.name }))]} />
      <Select value={connection} onChange={setConnection} aria-label="Подключение" className="w-56" options={[{ value: '', label: 'Подключение…' }, ...(chosen?.manifest.connections || []).map((c) => ({ value: c.id, label: `${c.app} (${c.id})` }))]} />
      {roles.map((r) => <label key={r.code} className="flex items-center gap-1 text-xs"><input type="checkbox" checked={picked.includes(r.code)} onChange={() => setPicked((p) => p.includes(r.code) ? p.filter((c) => c !== r.code) : [...p, r.code])} />{r.name}</label>)}
      <Btn size="sm" tone="primary" disabled={!moduleId || !connection} onClick={() => void save([...rules, { moduleId, connection, roles: picked }])}>Запретить</Btn>
    </div>
  </div>;
}
