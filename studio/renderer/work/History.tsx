/**
 * Вкладка «История» нижней панели: версии проекта (снимки в скрытой `.flux/history`), «Сохранить версию» с заметкой,
 * «Сравнить» и «Откатить…». Сами снимки, сравнение и откат делает главный процесс (studio/shared/history.ts).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Empty, Status } from '../../../src/components/ui/controls';
import type { DamagedInfo, SnapshotInfo } from '../../shared/history';
import { call } from '../call';
import { CompareDialog, RollbackDialog } from './HistoryDialogs';
import { formatTime, REASON_TEXT, REASON_TONE } from './historyText';

export interface HistoryHooks {
  /** Меняется, когда снимок мог появиться сам (сборка, отправка, откат): список читается заново */
  version: number;
  getDirty: () => string[];
  saveAll: () => Promise<boolean>;
  onRolledBack: (restorePoint: SnapshotInfo) => void;
  onNote: (text: string) => void;
}

export default function HistoryPanel({ id, hooks }: { id: string; hooks: HistoryHooks }) {
  const [list, setList] = useState<{ snapshots: SnapshotInfo[]; damaged: DamagedInfo[] } | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [compare, setCompare] = useState<{ from: string; to: string } | null>(null);
  const [rollback, setRollback] = useState<SnapshotInfo | null>(null);

  const load = useCallback(async () => {
    try { setList(await call('historyList', { id })); setError(''); } catch (e) { setError((e as Error).message); }
  }, [id]);
  useEffect(() => { void load(); }, [load, hooks.version]);

  // Сохраняется то, что на диске: несохранённые правки редактора сначала записываются в файлы
  const save = async () => {
    setBusy(true); setError('');
    try {
      if (!(await hooks.saveAll())) return;
      const r = await call<{ snapshot: SnapshotInfo; created: boolean }>('historySave', { id, note });
      hooks.onNote(r.created ? 'Версия сохранена.' : 'Файлы не менялись с последней версии: она отмечена как сохранённая вручную, новая не нужна.');
      setNote('');
      await load();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const remove = async (snapshot: string) => { try { await call('historyRemove', { id, snapshot }); await load(); } catch (e) { setError((e as Error).message); } };

  const snapshots = list?.snapshots ?? [];
  return (
    <div data-testid="history-panel">
      <form className="studio-history-bar" onSubmit={e => { e.preventDefault(); void save(); }}>
        <input className="fx-input" aria-label="Заметка к версии" placeholder="Заметка к версии (необязательно)" maxLength={300} value={note} onChange={e => setNote(e.target.value)} />
        <button type="submit" className="fx-btn" disabled={busy}>{busy ? 'Сохраняем…' : 'Сохранить версию'}</button>
        {snapshots.length > 1 && <button type="button" className="fx-btn fx-btn-quiet" onClick={() => setCompare({ from: snapshots[1].id, to: snapshots[0].id })}>Сравнить две последние</button>}
      </form>
      {error && <p className="fx-error px-3" role="alert">{error}</p>}
      {list && snapshots.length === 0 && list.damaged.length === 0 && (
        <Empty title="Версий пока нет" text="Нажмите «Сохранить версию»: к ней можно будет вернуться. Версии сами появляются при сборке и отправке на публикацию." />)}
      {snapshots.length > 0 && (
        <table className="fx-table">
          <thead><tr><th>Время</th><th>Что это</th><th>Заметка</th><th>Файлов</th><th aria-label="Действия" /></tr></thead>
          <tbody>
            {snapshots.map(s => (
              <tr key={s.id}>
                <td className="data">{formatTime(s.time)}</td>
                <td><Status tone={REASON_TONE[s.reason]}>{REASON_TEXT[s.reason]}{s.version ? ` ${s.version}` : ''}</Status></td>
                <td>{s.note || <span className="fx-hint">—</span>}{!s.complete && <span className="fx-error"> Версия неполная: часть файлов потеряна.</span>}</td>
                <td className="data">{s.fileCount}</td>
                <td><div className="studio-history-acts">
                  <button type="button" className="fx-btn fx-btn-sm" aria-label={`Сравнить версию от ${formatTime(s.time)}`} disabled={!s.complete} onClick={() => setCompare({ from: s.id, to: 'current' })}>Сравнить</button>
                  <button type="button" className="fx-btn fx-btn-sm" aria-label={`Откатить к версии от ${formatTime(s.time)}`} disabled={!s.complete} onClick={() => setRollback(s)}>Откатить…</button>
                </div></td>
              </tr>))}
          </tbody>
        </table>)}
      {list?.damaged.map(d => (
        <p key={d.id} className="fx-error px-3" role="alert">{d.problem}{' '}<button type="button" className="fx-btn fx-btn-sm" onClick={() => void remove(d.id)}>Убрать из списка</button></p>))}
      {compare && <CompareDialog id={id} snapshots={snapshots} from={compare.from} to={compare.to} onClose={() => setCompare(null)} />}
      {rollback && <RollbackDialog id={id} snapshot={rollback} getDirty={hooks.getDirty} saveAll={hooks.saveAll} onClose={() => setRollback(null)}
        onDone={restorePoint => { setRollback(null); hooks.onRolledBack(restorePoint); void load(); }} />}
    </div>
  );
}
