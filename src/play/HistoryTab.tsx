import React from 'react';
import { History } from 'lucide-react';
import { fetchHistory } from '../services/playService';
import { Empty, Failure } from './states';
interface PastMatch { id: string; title: string; state: string; startedAt: string; players: string[]; result: any }
export default function HistoryTab({ names, onOpen }: { names: Record<string, string>; onOpen: (id: string) => void }) {
  const [matches, setMatches] = React.useState<PastMatch[]>([]);
  const [loading, setLoading] = React.useState(true), [failure, setFailure] = React.useState('');
  const load = React.useCallback(async () => {
    setLoading(true); const response = await fetchHistory();
    if (response.ok) { setMatches(response.result || []); setFailure(''); } else setFailure(response.message || 'Не удалось прочитать историю');
    setLoading(false);
  }, []);
  React.useEffect(() => { void load(); }, [load]);
  if (loading) return <p className="p-4 text-xs text-slate-500 dark:text-slate-400">Загружаем историю…</p>;
  if (failure) return <Failure text={failure} onRetry={() => void load()} />;
  if (!matches.length) return <Empty icon={<History className="w-4 h-4" />} title="Завершённых партий пока нет" hint="Здесь появятся ваши результаты бильярда и Дурака." />;
  return <div className="overflow-auto p-3"><table className="fx-table w-full text-xs"><thead><tr><th>Игра</th><th>Участники</th><th>Дата</th><th>Результат</th><th /></tr></thead>
    <tbody>{matches.map(match => <tr key={match.id}>
      <td>{match.title}</td><td>{match.players.map(id => names[id] || 'Сотрудник').join(', ')}</td>
      <td className="whitespace-nowrap">{new Date(match.startedAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
      <td>{match.result?.why || (match.state === 'CANCELLED' ? 'Отменена' : 'Завершена')}</td>
      <td><button className="fx-btn fx-btn-sm" onClick={() => onOpen(match.id)}>Посмотреть</button></td>
    </tr>)}</tbody></table></div>;
}
