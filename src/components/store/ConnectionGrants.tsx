/**
 * «Разрешения» подключений: каждое подключение программы с переключателем
 * «Разрешено / Спрашивать / Запрещено» и «Сбросить все». Список и запись идут через
 * главный процесс: решение хранится у него, а запрещённое политикой администратора
 * показывается заблокированным — выбор человека эту политику не отменяет.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Btn, Select } from '../ui';
import { bridge } from '../../services/moduleReleaseService';
import { ACCESS_NAMES, type AccessKind } from '../../../modules/connections/model';

interface Row {
  moduleId: string; moduleName: string; version: string; connection: string; app: string; does: string; access: AccessKind;
  technical: string; state: 'allowed' | 'denied' | 'ask'; byPolicy: boolean;
}
const STATES = [{ value: 'allowed', label: 'Разрешено' }, { value: 'ask', label: 'Спрашивать' }, { value: 'denied', label: 'Запрещено' }];
const TO_DECISION = { allowed: 'always', denied: 'never', ask: 'ask' } as const;

export default function ConnectionGrants({ moduleId }: { moduleId?: string }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    const ipc = bridge();
    if (!ipc) { setRows([]); return; }
    const reply = await ipc.invoke('modules:grants', {}).catch(() => null);
    setRows(reply?.ok ? (reply.rows as Row[]).filter(r => !moduleId || r.moduleId === moduleId) : []);
  }, [moduleId]);
  useEffect(() => { void load(); }, [load]);
  const set = async (row: Row, state: Row['state']) => {
    setError('');
    const reply = await bridge()?.invoke('modules:grant', { moduleId: row.moduleId, version: row.version, connection: row.connection, session: 'settings', decision: TO_DECISION[state] }).catch(() => null);
    if (!reply?.ok) setError(reply?.error || 'Не удалось сохранить выбор');
    await load();
  };
  const reset = async () => { await bridge()?.invoke('modules:grants-reset', moduleId ? { moduleId } : {}); await load(); };
  if (!rows) return <div className="stx-note">Загрузка…</div>;
  if (!rows.length) return <div className="stx-note" data-testid="grants-empty">{bridge() ? 'У установленных программ нет подключений к внешним программам.' : 'Разрешения подключений действуют в программе Flux на компьютере.'}</div>;
  return <div className="flex flex-col gap-3" data-testid="grants">
    {error && <div className="fx-error">{error}</div>}
    <table className="fx-table"><thead><tr>{!moduleId && <th>Программа</th>}<th>Подключение</th><th>Что делает</th><th>Выбор</th></tr></thead>
      <tbody>{rows.map(r => <tr key={`${r.moduleId}:${r.connection}`} data-testid="grants-row">
        {!moduleId && <td><b>{r.moduleName}</b></td>}
        <td><b>{r.app}</b><div className="fx-hint">{ACCESS_NAMES[r.access]} · {r.technical}</div></td>
        <td>{r.does}</td>
        <td>{r.byPolicy ? <span title="Запрещено администратором: выбор человека это не отменяет">Запрещено администратором</span>
          : <Select value={r.state} onChange={v => void set(r, v as Row['state'])} options={STATES} aria-label={`Выбор для ${r.app}`} />}</td>
      </tr>)}</tbody></table>
    <div><Btn size="sm" onClick={() => void reset()} data-testid="grants-reset">Сбросить все</Btn></div>
  </div>;
}
