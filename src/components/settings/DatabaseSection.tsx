import { useState, useEffect } from 'react';
import { useStore } from '../../store/store';
import SectionShell from './SectionShell';
import { ENV_CONFIG } from '../../config/env';
import { Status } from '../ui';
import { useModalStore } from '../../store/modalStore';
import { hasAdminRole } from '../../lib/permissions';

// Диалоги программы вместо системных окон Windows
const { openConfirm, openAlert } = useModalStore.getState();

// ── База данных (перенесено из профиля) ────────────────────────────────────────
export default function DatabaseSection({ addToast }: any) {
  const user = useStore((s) => s.user);
  const isAdmin = hasAdminRole(user as any);
  const [dbLocation, setDbLocation] = useState('');
  const [dbDisplayLocation, setDbDisplayLocation] = useState('');
  const [dbType, setDbType] = useState<'LOCAL' | 'REMOTE' | string>('LOCAL');
  const [activeDbType, setActiveDbType] = useState<'LOCAL' | 'REMOTE' | string>('LOCAL');
  const [remoteUrl, setRemoteUrl] = useState('');
  const [isTesting, setIsTesting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{ text: string; success: boolean } | null>(null);

  const handleSyncSchema = async () => {
    setIsSyncing(true);
    setStatusMessage(null);
    try {
      const resp = await fetch(`${ENV_CONFIG.apiUrl}/admin/sync-schema`, { method: 'POST' });
      const d = await resp.json();
      if (resp.ok) setStatusMessage({ text: d.message || 'Готово', success: true });
      else setStatusMessage({ text: d.error || 'Не удалось проверить структуру', success: false });
    } catch (e: any) {
      setStatusMessage({ text: e?.message || 'Ошибка', success: false });
    } finally {
      setIsSyncing(false);
    }
  };

  const refresh = async () => {
    try {
      const resp = await fetch(`${ENV_CONFIG.apiUrl}/db/config`.replace('/api/api', '/api'));
      const config = await resp.json();
      setDbLocation(config.databasePath);
      setDbDisplayLocation(config.displayPath || config.databasePath);
      setDbType(config.current_db_type || 'LOCAL');
      setActiveDbType(config.current_db_type || 'LOCAL');
      setRemoteUrl(config.database_url || '');
    } catch (_) {}
  };

  useEffect(() => { refresh(); }, []);

  const handleSwitch = async (targetType: string, urlKey: string, dbPath?: string) => {
    setIsSaving(true);
    setStatusMessage(null);
    try {
      const resp = await fetch(`${ENV_CONFIG.apiUrl}/db/switch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          current_db_type: targetType,
          database_url: urlKey,
          ...(typeof dbPath === 'string' ? { database_path: dbPath } : {})
        })
      });
      const data = await resp.json();
      if (data.success) {
        setStatusMessage({ text: data.message, success: true });
        await refresh();
        void openAlert('Подключение обновлено', data.message || 'Программа работает с новой базой данных.');
        window.location.reload();
      } else {
        setStatusMessage({ text: data.message || 'Ошибка подключения!', success: false });
      }
    } catch (err: any) {
      setStatusMessage({ text: `Ошибка запроса: ${err.message}`, success: false });
    } finally {
      setIsSaving(false);
    }
  };

  const handlePickDbFile = async () => {
    const win = window as any;
    if (!win.electron?.ipcRenderer?.invoke) {
      void openAlert('Доступно только в программе', 'Выбрать файл можно в установленном приложении Flux — в браузере эта возможность недоступна.');
      return;
    }
    try {
      const filePath = await win.electron.ipcRenderer.invoke('database:select-file');
      if (filePath) await handleSwitch('LOCAL', '', String(filePath));
    } catch (err: any) {
      setStatusMessage({ text: `Ошибка выбора файла: ${err.message}`, success: false });
    }
  };

  const handleTest = async () => {
    setIsTesting(true);
    setStatusMessage(null);
    try {
      const resp = await fetch(`${ENV_CONFIG.apiUrl}/db/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_db_type: dbType, database_url: remoteUrl })
      });
      const data = await resp.json();
      setStatusMessage({ text: data.message, success: !!data.success });
    } catch (err: any) {
      setStatusMessage({ text: `Ошибка при проверке: ${err.message}`, success: false });
    } finally {
      setIsTesting(false);
    }
  };

  return (
    <SectionShell title="База данных" desc="Локальная SQLite (работает автономно) или сетевой PostgreSQL для совместной работы.">
      <div className="max-w-lg space-y-3">
        <div className="fx-segctl" role="group" aria-label="Тип базы данных">
          <button type="button" onClick={() => setDbType('LOCAL')} aria-pressed={dbType === 'LOCAL'}>Локальная</button>
          <button type="button" onClick={() => setDbType('REMOTE')} aria-pressed={dbType === 'REMOTE'}>Сеть / PostgreSQL</button>
        </div>

        {dbType === 'LOCAL' ? (
          <div className="space-y-2">
            <p className="font-mono text-xs text-slate-600 dark:text-slate-400 bg-slate-50 dark:bg-slate-900 p-2.5 border border-slate-200 dark:border-slate-800 rounded-lg select-all break-all" title={dbLocation}>
              {dbDisplayLocation || 'database.sqlite'}
            </p>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" disabled={isSaving} onClick={handlePickDbFile} className="fx-btn">Выбрать файл БД…</button>
              <button type="button" disabled={isSaving} onClick={async () => { if (await openConfirm('Вернуть базу в стандартную папку?', 'Программа снова будет работать с базой в папке AppData/pdm-app.', { confirmLabel: 'Вернуть' })) handleSwitch('LOCAL', '', ''); }} className="py-2 rounded-lg bg-slate-100 dark:bg-slate-900 hover:bg-slate-200 dark:hover:bg-slate-800 text-xs font-semibold text-slate-700 dark:text-slate-300 cursor-pointer disabled:opacity-50">Стандартный путь</button>
            </div>
            {activeDbType === 'LOCAL' && !isSaving
              ? <Status tone="emerald">Локальный режим активен</Status>
              : <button type="button" disabled={isSaving} onClick={() => handleSwitch('LOCAL', '')} className="fx-btn fx-btn-primary">
                  {isSaving ? 'Подключение…' : 'Включить локальный режим'}
                </button>}
          </div>
        ) : (
          <div className="space-y-2">
            <input
              type="text"
              value={remoteUrl}
              onChange={(e) => setRemoteUrl(e.target.value)}
              placeholder="mysql://user:password@host:3306/flux или postgresql://user:password@host:5432/flux"
              className="fx-input code"
            />
            <p className="text-xs text-slate-500 dark:text-slate-400">MariaDB/MySQL — адрес mysql://…, PostgreSQL — postgresql://…</p>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" disabled={isTesting} onClick={handleTest} className="fx-btn">
                {isTesting ? 'Проверка…' : 'Тестировать'}
              </button>
              <button type="button" disabled={isSaving} onClick={() => handleSwitch('REMOTE', remoteUrl)} className="fx-btn fx-btn-primary">
                {isSaving ? 'Загрузка…' : 'Сохранить и подключить'}
              </button>
            </div>
          </div>
        )}

        {statusMessage && (
          <div className={`p-2 text-xs font-semibold text-center rounded-lg ${statusMessage.success ? 'bg-emerald-50 dark:bg-emerald-950/20 text-emerald-600' : 'bg-rose-50 dark:bg-rose-950/20 text-rose-600'}`}>
            {statusMessage.text}
          </div>
        )}

        {isAdmin && (
          <div className="pt-3 mt-1 border-t border-slate-200 dark:border-slate-800 space-y-1.5">
            <button type="button" disabled={isSyncing} onClick={handleSyncSchema} className="fx-btn w-full">
              {isSyncing ? 'Проверка…' : 'Проверить / обновить структуру базы'}
            </button>
            <p className="text-xs text-slate-500 dark:text-slate-400">Достраивает недостающие таблицы и колонки после обновления программы.</p>
          </div>
        )}
      </div>
    </SectionShell>
  );
}
