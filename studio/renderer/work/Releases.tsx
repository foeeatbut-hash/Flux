/**
 * Выпуски своей программы (вкладка «Публикация»): версия, кому доступна, дата, состояние. Выпуск, версию которого владелец
 * ограничил откатом, остаётся в списке с пометкой. Если версия отправлялась из этого проекта и снимок отправки цел,
 * доступно «Сравнить с текущим» — тем же окном, что в «Истории».
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Status } from '../../../src/components/ui/controls';
import type { SnapshotInfo } from '../../shared/history';
import { call } from '../call';
import { CompareDialog } from './HistoryDialogs';

interface Release { version: string; channel: 'test' | 'production'; createdAt: string; state: 'published' | 'revoked' | 'rolled-back'; limit: string | null; snapshot: string | null }

const AUDIENCE = { test: 'Тестировщикам', production: 'Всем пользователям' };
const STATE: Record<Release['state'], { text: string; tone: 'emerald' | 'rose' | 'amber' }> = {
  published: { text: 'Выпущен', tone: 'emerald' }, revoked: { text: 'Отозван', tone: 'rose' }, 'rolled-back': { text: 'Откат владельца', tone: 'amber' },
};

export default function Releases({ id, version }: { id: string; version: number }) {
  const [list, setList] = useState<Release[] | null>(null);
  const [snapshots, setSnapshots] = useState<SnapshotInfo[]>([]);
  const [error, setError] = useState('');
  const [compare, setCompare] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setList(await call<Release[]>('releaseList', { id }));
      setSnapshots((await call<{ snapshots: SnapshotInfo[] }>('historyList', { id }).catch(() => ({ snapshots: [] as SnapshotInfo[] }))).snapshots);
      setError('');
    } catch (e) { setError((e as Error).message); }
  }, [id]);
  useEffect(() => { void load(); }, [load, version]);

  if (error) return <p className="fx-error" role="alert">Выпуски не загрузились: {error}</p>;
  if (!list || list.length === 0) return <p className="fx-hint" data-testid="releases-empty">{list ? 'Выпусков этой программы ещё нет: владелец выпускает её после проверки отправленного запроса.' : 'Загружаем выпуски…'}</p>;
  return (
    <>
      <h4>Выпуски</h4>
      <table className="fx-table" data-testid="releases">
        <thead><tr><th>Версия</th><th>Кому доступна</th><th>Дата</th><th>Состояние</th><th aria-label="Действия" /></tr></thead>
        <tbody>
          {list.map(r => (
            <tr key={`${r.version}-${r.channel}`}>
              <td className="data">{r.version}</td>
              <td>{AUDIENCE[r.channel]}</td>
              <td className="data">{r.createdAt}</td>
              <td><Status tone={STATE[r.state].tone} title={r.limit ? `Владелец ограничил выпуски версией ${r.limit}: эта версия не запускается` : undefined}>{STATE[r.state].text}</Status>{r.limit && <span className="fx-hint"> до {r.limit}</span>}</td>
              <td>{r.snapshot
                ? <button type="button" className="fx-btn fx-btn-sm" aria-label={`Сравнить выпуск ${r.version} с текущими файлами`} onClick={() => setCompare(r.snapshot)}>Сравнить с текущим</button>
                : <span className="fx-hint" title="Версия отправлена не из этого проекта или её снимок убран из истории">нет снимка</span>}</td>
            </tr>))}
        </tbody>
      </table>
      {compare && <CompareDialog id={id} snapshots={snapshots} from={compare} to="current" onClose={() => setCompare(null)} />}
    </>
  );
}
