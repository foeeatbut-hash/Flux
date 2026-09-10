/**
 * Журналы и ошибки в параметрах.
 *
 * Вынесено из экрана параметров: он и без того на пределе размера, а здесь
 * два разных дела — где лежат файлы журналов и как рассказать о сбое.
 */
import React, { useEffect, useState } from 'react';
import SectionShell from './SectionShell';
import ReportProblem from './ReportProblem';
import DiagnosticsCard from './DiagnosticsCard';
import { logsFolder, openLogsFolder } from '../../lib/crashLog';
import { can } from '../../lib/permissions';
import { useStore } from '../../store/store';
import { ENV_CONFIG } from '../../config/env';
import { useModalStore } from '../../store/modalStore';

export default function LogsSection({ addLog }: { addLog: (level: string, where: string, text: string) => void }) {
  const openAlert = useModalStore.getState().openAlert;
  /**
   * Журналы — не дело сотрудника.
   *
   * Решение владельца: человек, у которого сломалось, нажимает «Сообщить об
   * ошибке» и пишет строку; записи уезжают с обращением сами. Папки, выгрузки и
   * счётчики потерь ему не нужны — они нужны тому, кто разбирает, и ему же
   * показываются. Раньше здесь было наоборот: файлы предлагалось найти и
   * отправить самому, и до отправки доходили единицы.
   */
  const me = useStore((s) => s.user);
  const forTriage = can(me as any, 'feedback.diagnostics') || can(me as any, 'feedback.triage');
  const [crashLogDir, setCrashLogDir] = useState('');
  const [deskFolder, setDeskFolder] = useState('');
  const [report, setReport] = useState(false);

  useEffect(() => { void logsFolder().then(setDeskFolder); }, []);

  useEffect(() => {
    fetch(`${ENV_CONFIG.apiUrl}/db/config`).then(r => r.json()).then((config: any) => {
      setCrashLogDir(config.crash_log_dir || '');
    }).catch(() => {});
  }, []);

  const save = async (dir: string) => {
    try {
      const resp = await fetch(`${ENV_CONFIG.apiUrl}/config/logs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ crash_log_dir: dir })
      });
      const data = await resp.json();
      if (data.success) {
        setCrashLogDir(data.crash_log_dir || '');
        addLog('INFO', 'Система', `Папка для crash-логов изменена: ${data.crash_log_dir || 'по умолчанию (AppData/pdm-app/logs)'}`);
      }
    } catch (err: any) {
      addLog('ERROR', 'Система', `Не удалось сохранить папку crash-логов: ${err.message}`);
    }
  };

  const pickDir = async () => {
    const win = window as any;
    if (!win.electron?.ipcRenderer?.invoke) {
      void openAlert('Доступно только в программе', 'Выбрать папку можно в установленном приложении Flux — в браузере эта возможность недоступна.');
      return;
    }
    try {
      const dirPath = await win.electron.ipcRenderer.invoke('dialog:openDirectory');
      if (dirPath) await save(String(dirPath));
    } catch (err: any) {
      addLog('ERROR', 'Система', `Ошибка выбора папки: ${err.message}`);
    }
  };

  return (
    <SectionShell title="Журналы и ошибки"
      desc={forTriage ? 'Куда пишутся журналы и как сообщить о сбое.' : 'Как сообщить о сбое.'}>
      <div className="max-w-lg space-y-4">
        {forTriage && <DiagnosticsCard />}

        {!forTriage && (
          <div className="rounded-lg border border-slate-200 dark:border-slate-850 p-3 space-y-2">
            <div className="text-xs font-bold text-slate-800 dark:text-slate-150">Что-то сломалось</div>
            <p className="text-2xs text-slate-500 dark:text-slate-400 leading-relaxed">
              Напишите, что случилось, — программа сама приложит свои технические записи
              за последнее время. Искать и отправлять файлы не нужно.
            </p>
            <button type="button" onClick={() => setReport(true)}
              className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold cursor-pointer">
              Сообщить об ошибке
            </button>
          </div>
        )}

        {forTriage && (<>
        {/* Папка на рабочем столе: её человек может открыть и отдать целиком.
            Раньше файлы лежали в AppData под именами вида pdm-crash-log-… и
            найти их не мог никто */}
        <div className="rounded-lg border border-slate-200 dark:border-slate-850 p-3 space-y-2">
          <div className="text-xs font-bold text-slate-800 dark:text-slate-150">Папка журналов</div>
          <p className="font-mono text-xs text-slate-600 dark:text-slate-400 bg-slate-50 dark:bg-slate-900 p-2.5
                        border border-slate-200 dark:border-slate-800 rounded-lg select-all break-all">
            {deskFolder || 'Рабочий стол → «Flux — журналы»'}
          </p>
          <p className="text-2xs text-slate-500 dark:text-slate-400">
            По файлу на день; старше тридцати дней убираются сами.
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => void openLogsFolder()}
              className="px-3 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-900 hover:bg-slate-200 dark:hover:bg-slate-800
                         text-xs font-semibold text-slate-700 dark:text-slate-300 cursor-pointer">
              Открыть папку
            </button>
            <button type="button" onClick={() => setReport(true)}
              className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold cursor-pointer">
              Сообщить об ошибке
            </button>
          </div>
        </div>

        {/* Копия на сервере: администратору не приходится собирать логи по
            компьютерам */}
        <div className="rounded-lg border border-slate-200 dark:border-slate-850 p-3 space-y-2">
          <div className="text-xs font-bold text-slate-800 dark:text-slate-150">Копия на сервере</div>
          <p className="font-mono text-xs text-slate-600 dark:text-slate-400 bg-slate-50 dark:bg-slate-900 p-2.5
                        border border-slate-200 dark:border-slate-800 rounded-lg select-all break-all">
            {crashLogDir || 'AppData/pdm-app/logs (по умолчанию)'}
          </p>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={pickDir} className="py-2 rounded-lg bg-slate-100 dark:bg-slate-900 hover:bg-slate-200 dark:hover:bg-slate-800 text-xs font-semibold text-slate-700 dark:text-slate-300 cursor-pointer">Выбрать папку…</button>
            <button type="button" onClick={() => save('')} className="py-2 rounded-lg bg-slate-100 dark:bg-slate-900 hover:bg-slate-200 dark:hover:bg-slate-800 text-xs font-semibold text-slate-700 dark:text-slate-300 cursor-pointer">По умолчанию</button>
          </div>
        </div>
        </>)}
      </div>

      {report && <ReportProblem onClose={() => setReport(false)} />}
    </SectionShell>
  );
}
