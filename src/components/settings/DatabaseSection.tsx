import { useState } from 'react';
import { useStore } from '../../store/store';
import SectionShell from './SectionShell';
import { ConnectionPanel } from '../ConnectionPanel';
import EntityIdMigrationPanel from './EntityIdMigrationPanel';

export default function DatabaseSection() {
  const owner = useStore(s => s.user?.role === 'OWNER');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const sync = async () => {
    setBusy(true); setStatus('');
    try {
      const response = await fetch('/api/admin/sync-schema', { method: 'POST' });
      const result = await response.json();
      setStatus(response.ok ? result.message || 'Структура базы проверена.' : 'Не удалось проверить структуру базы. Подробности записаны в журнал.');
    } catch { setStatus('Нет связи с общей базой. Проверьте подключение.'); }
    finally { setBusy(false); }
  };
  return <SectionShell title="База данных">
    <div className="max-w-lg space-y-4">
      <ConnectionPanel />
      {owner && <div className="border-t border-slate-200 dark:border-slate-800 pt-4 space-y-2">
        <button type="button" className="fx-btn" disabled={busy} onClick={() => void sync()}>{busy ? 'Проверка…' : 'Проверить структуру базы'}</button>
        <p className="fx-hint">Достраивает недостающие таблицы и колонки после обновления программы.</p>
        <EntityIdMigrationPanel />
      </div>}
      {status && <p role="status" className="fx-hint">{status}</p>}
    </div>
  </SectionShell>;
}
