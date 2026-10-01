import { useState, useEffect } from 'react';
import SectionShell from './SectionShell';
import { Loader2, Archive, PlayCircle, FolderOpen } from 'lucide-react';
import { countOf } from '../../lib/plural';

// ── Резервные копии ────────────────────────────────────────────────────────────
// Ежедневный «Архив»: копия базы + все файлы Проводника в родных форматах по
// папкам + данные проектов в Excel. Если всё полетит — папка с датой читается
// без программы. Плюс страховочные копии базы при каждом запуске.
export default function BackupSection({ isAdmin, mayRun = isAdmin, addToast }: any) {
  const [status, setStatus] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [runningNow, setRunningNow] = useState(false);

  const load = async () => {
    try {
      const r = await fetch('/api/backup/status');
      const d = await r.json();
      if (r.ok) setStatus(d);
    } catch (_) {}
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const runNow = async () => {
    setRunningNow(true);
    try {
      const r = await fetch('/api/backup/run', { method: 'POST' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `Сервер ответил ${r.status}`);
      addToast(`Архив создан: файлов Проводника — ${d.explorerFiles}, книг данных — ${d.dataWorkbooks}`, 'success');
      load();
    } catch (e: any) {
      addToast(`Не удалось создать архив: ${e.message}`, 'error');
    } finally {
      setRunningNow(false);
    }
  };

  const saveSettings = async (patch: any) => {
    try {
      const r = await fetch('/api/backup/settings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'ошибка');
      setStatus((prev: any) => prev ? { ...prev, settings: d.settings } : prev);
      addToast('Настройки резервных копий сохранены', 'success');
      load();
    } catch (e: any) {
      addToast(`Не удалось сохранить: ${e.message}`, 'error');
    }
  };

  const fmtSize = (bytes: number) => {
    if (!bytes) return '—';
    const mb = bytes / (1024 * 1024);
    return mb >= 1 ? `${mb.toFixed(1)} МБ` : `${Math.round(bytes / 1024)} КБ`;
  };

  if (loading) return <SectionShell title="Резервные копии" desc="Загрузка…"><Loader2 className="w-5 h-5 animate-spin text-emerald-600" /></SectionShell>;

  const settings = status?.settings || { enabled: true, dir: '', keep: 14 };
  const backups = status?.backups || [];

  return (
    <SectionShell title="Резервные копии" desc="Ежедневный архив: база, файлы Проводника и данные проектов.">
      <div className="space-y-5">
        {/* Статус и ручной запуск */}
        <div className="fx-set-group space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <div className="text-xs font-medium text-slate-400">Папка архивов</div>
              <div className="text-xs font-mono mt-1 text-slate-600 dark:text-slate-300 select-all break-all">{status?.dir || '—'}</div>
            </div>
            {mayRun && (
              <button type="button"
                onClick={runNow}
                disabled={runningNow || status?.running}
                className="fx-btn fx-btn-primary"
              >
                {runningNow ? <Loader2 className="w-4 h-4 animate-spin" /> : <PlayCircle className="w-4 h-4" />}
                {runningNow ? 'Создание архива…' : 'Создать архив сейчас'}
              </button>
            )}
          </div>
          <div className="text-xs text-slate-400 leading-relaxed">
            Внутри каждого архива: <span className="font-mono">database.sqlite</span> (вся база),
            папка <span className="font-mono">Проводник</span> (файлы как есть, по проектам и папкам),
            папка <span className="font-mono">Данные</span> (Excel-книги: теги, закупки, оборудование).
            Дополнительно при каждом запуске программы делается быстрая страховочная копия базы (хранятся 5 последних).
          </div>
        </div>

        {/* Настройки */}
        <div className="fx-set-group space-y-3">
          <div className="text-xs font-medium text-slate-400">Расписание</div>
          <label className="flex items-center gap-2 text-xs font-semibold text-slate-600 dark:text-slate-300 cursor-pointer select-none">
            <input
              type="checkbox"
              disabled={!isAdmin}
              checked={!!settings.enabled}
              onChange={(e) => saveSettings({ enabled: e.target.checked })}
              className="w-4 h-4 accent-emerald-500 cursor-pointer"
            />
            Делать архив автоматически каждый день
          </label>
          <div className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
            <span>Хранить архивов:</span>
            <input
              type="number" min={1} max={90}
              disabled={!isAdmin}
              defaultValue={settings.keep}
              onBlur={(e) => { const v = Number(e.target.value); if (v && v !== settings.keep) saveSettings({ keep: v }); }}
              className="w-20 px-2 py-1.5 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-xs text-center"
            />
            <span className="text-slate-400">(старые удаляются сами)</span>
          </div>
          <div className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
            <span className="shrink-0">Своя папка:</span>
            <input
              type="text"
              disabled={!isAdmin}
              defaultValue={settings.dir || ''}
              placeholder="пусто = стандартная в папке данных программы"
              onBlur={(e) => { const v = e.target.value.trim(); if (v !== (settings.dir || '')) saveSettings({ dir: v }); }}
              className="flex-1 min-w-0 px-2 py-1.5 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-xs font-mono"
            />
          </div>
          <p className="text-2xs text-amber-600 dark:text-amber-400">
            Совет: укажите папку на другом диске или сетевом хранилище — тогда архив переживёт даже поломку диска с программой.
          </p>
        </div>

        {/* Список архивов */}
        <div>
          <div className="fx-group-title mb-1 flex items-center gap-1.5">
            <FolderOpen className="w-3.5 h-3.5" /> Существующие архивы ({backups.length})
          </div>
          {backups.length === 0 ? (
            <p className="text-xs text-slate-400">Архивов ещё нет — первый создастся автоматически в течение часа, или нажмите «Создать архив сейчас».</p>
          ) : (
            <div className="space-y-1 max-h-64 overflow-y-auto">
              {backups.map((b: any) => (
                <div key={b.name} className="flex items-center justify-between px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-150 dark:border-slate-850 text-xs">
                  <div className="flex items-center gap-2 min-w-0">
                    <Archive className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                    <span className="font-mono font-medium truncate">{b.name}</span>
                  </div>
                  <div className="flex items-center gap-3 text-slate-400 shrink-0">
                    {b.manifest && <span title={`Файлов Проводника: ${b.manifest.explorerFiles}, книг данных: ${b.manifest.dataWorkbooks}`}>{countOf(b.manifest.explorerFiles, 'файл')}</span>}
                    <span>{fmtSize(b.size)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </SectionShell>
  );
}
