/**
 * Другие программы в тестовой базе: у запускаемой программы есть разрешение вызывать чужие (flux.programs.call), а чужой
 * программы в Studio нет. Своя программа с методами «ставится» в тестовую базу — и вызов получает настоящий ответ её логики.
 * Ставит и убирает главный процесс Studio (testProgramInstall / testProgramRemove); поставленное держится до закрытия Studio.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { call } from '../../call';
import type { TestProgramRow } from '../../../shared/runActions';

type TestProgram = TestProgramRow;

export default function TestPrograms({ id, onChange }: { id: string; onChange?: (line: string) => void }) {
  const [rows, setRows] = useState<TestProgram[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const load = useCallback(() => call<TestProgram[]>('testPrograms').then(setRows).catch(e => setError((e as Error).message)), []);
  useEffect(() => { setRows(null); setError(''); void load(); }, [id, load]);
  const act = async (row: TestProgram) => {
    setBusy(row.id); setError('');
    try {
      setRows(await call<TestProgram[]>(row.installed ? 'testProgramRemove' : 'testProgramInstall', { id: row.id }));
      onChange?.(`${row.name}: ${row.installed ? 'убрана из тестовой базы' : 'поставлена в тестовую базу'}`);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(''); }
  };
  // Саму запускаемую программу вызывать у себя нельзя: список — только остальные
  const others = (rows || []).filter(r => r.id !== id && r.exports.length > 0);
  return (
    <div data-testid="studio-test-programs" role="group" aria-labelledby="test-programs-title">
      <h4 id="test-programs-title">Другие программы в тестовой базе</h4>
      <p className="fx-hint">Вызов <span className="code">flux.programs.call</span> отвечает только программам, поставленным сюда. Поставленная программа выполняет метод своей логикой.</p>
      {error && <p className="fx-error" role="alert">{error}</p>}
      {rows && others.length === 0 && <div className="empty small">Других своих программ с методами пока нет.</div>}
      {others.length > 0 && (
        <table aria-label="Свои программы с методами">
          <thead><tr><th>Программа</th><th>Методы</th><th>В тестовой базе</th><th>Действие</th></tr></thead>
          <tbody>{others.map(r => (
            <tr key={r.id} data-testid="test-program">
              <td>{r.name} <span className="code">{r.id}</span></td>
              <td className="code">{r.exports.map(e => e.method).join(', ') || '—'}</td>
              <td><span className={`dot ${r.installed ? 'ok' : ''}`} />{r.installed ? 'Поставлена' : 'Нет'}{r.language === 'python' && !r.installed ? ' — Python во Flux' : ''}</td>
              <td><button className="fx-btn" disabled={busy === r.id} onClick={() => void act(r)} aria-label={`${r.installed ? 'Убрать' : 'Поставить в тестовую базу'}: ${r.name}`}>{r.installed ? 'Убрать' : 'Поставить в тестовую базу'}</button></td>
            </tr>))}</tbody>
        </table>
      )}
    </div>
  );
}
