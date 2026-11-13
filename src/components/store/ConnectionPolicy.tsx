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
  // Подключения, разрешения сети («@internet», «@lan») и обращения к программам («@program:<id>»): все запрещаются ролям одним правилом
  const programName = (id: string) => listings.find((l) => l.moduleId === id)?.name || id;
  const targetLabel = (connection: string) => connection === '@internet' ? 'Любой адрес в интернете' : connection === '@lan' ? 'Локальная сеть'
    : connection.startsWith('@program:') ? `Обращение к программе «${programName(connection.slice(9))}»` : connection;
  const targets = (l: StoreListing) => {
    const perms = (l.manifest.permissions || []) as Array<{ kind: string; program?: string }>;
    return [
      ...(l.manifest.connections || []).map((c) => ({ value: c.id, label: `${c.app} (${c.id})` })),
      ...perms.filter((p, i) => p.kind !== 'program' && perms.findIndex((q) => q.kind === p.kind) === i).map((p) => ({ value: `@${p.kind}`, label: targetLabel(`@${p.kind}`) })),
      // По строке на каждую объявленную программу: запрет относится к конкретному адресату, а не ко всем обращениям сразу
      ...perms.filter((p, i) => p.kind === 'program' && p.program && perms.findIndex((q) => q.kind === 'program' && q.program === p.program) === i).map((p) => ({ value: `@program:${p.program}`, label: targetLabel(`@program:${p.program}`) })),
    ];
  };
  const withConnections = listings.filter((l) => targets(l).length > 0);
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
        {rules.map((r, i) => <tr key={`${r.moduleId}:${r.connection}:${i}`}><td>{listings.find((l) => l.moduleId === r.moduleId)?.name || r.moduleId}</td><td>{targetLabel(r.connection)}</td>
          <td>{r.roles.length ? r.roles.join(', ') : 'все'}</td><td><Btn size="sm" onClick={() => void save(rules.filter((_, j) => j !== i))}>Снять запрет</Btn></td></tr>)}</tbody></table>
    <div className="flex flex-wrap items-center gap-2">
      <Select value={moduleId} onChange={(v) => { setModuleId(v); setConnection(''); }} aria-label="Программа" className="w-56" options={[{ value: '', label: 'Программа…' }, ...withConnections.map((l) => ({ value: l.moduleId, label: l.name }))]} />
      <Select value={connection} onChange={setConnection} aria-label="Подключение" className="w-80" options={[{ value: '', label: 'Подключение…' }, ...(chosen ? targets(chosen) : [])]} />
      {roles.map((r) => <label key={r.code} className="flex items-center gap-1 text-xs"><input type="checkbox" checked={picked.includes(r.code)} onChange={() => setPicked((p) => p.includes(r.code) ? p.filter((c) => c !== r.code) : [...p, r.code])} />{r.name}</label>)}
      <Btn size="sm" tone="primary" disabled={!moduleId || !connection} onClick={() => void save([...rules, { moduleId, connection, roles: picked }])}>Запретить</Btn>
    </div>
  </div>;
}
