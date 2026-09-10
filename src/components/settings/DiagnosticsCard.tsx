/**
 * Подробная запись работы: состояние, режим и выгрузка.
 *
 * Смысл карточки — не «показать настройку», а ответить на два вопроса, которые
 * при разборе задают первыми: пишется ли вообще что-нибудь и всё ли записано.
 * Поэтому потери здесь на виду, а не спрятаны в файле: «событий не было» и
 * «события потеряны» — разные ответы, и второй меняет доверие к остальному.
 *
 * Второе — честность про покрытие. Программа записывает много, но не всё, и
 * обещать «записываем всё» нельзя: человек тогда решит, что причина сбоя
 * обязана найтись в файле, и будет искать её там, где её нет.
 */
import React, { useEffect, useState } from 'react';
import { rendererStatus, exportRendererDiagnostics, setDetailedMode } from '../../lib/diagnostics';

const DETAILED_SECONDS = 60;

type ShellStatus = {
  queued: number; dropped: number; failures: number; written: number;
  bytesOnDisk: number; freeDiskBytes: number; detailed: boolean;
};

const mb = (bytes: number) => `${(bytes / 1048576).toFixed(1)} МБ`;

export default function DiagnosticsCard() {
  const [own, setOwn] = useState(rendererStatus());
  const [shell, setShell] = useState<ShellStatus | null>(null);
  const [until, setUntil] = useState(0);

  useEffect(() => {
    const tick = async () => {
      setOwn(rendererStatus());
      try {
        const api = (window as any).electron?.diagnostics;
        setShell(api ? await api.status() : null);
      } catch (_) { setShell(null); }
    };
    void tick();
    const timer = setInterval(tick, 2000);
    return () => clearInterval(timer);
  }, []);

  const openFolder = async () => {
    const api = (window as any).electron?.diagnostics;
    if (!api) return;
    try { await api.folder(); } catch (_) { /* папка недоступна */ }
  };

  const detailedLeft = Math.max(0, Math.round((until - Date.now()) / 1000));
  const startDetailed = () => {
    setDetailedMode(DETAILED_SECONDS);
    setUntil(Date.now() + DETAILED_SECONDS * 1000);
  };

  const lost = own.dropped + (shell?.dropped || 0);

  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-850 p-3 space-y-2">
      <div className="text-xs font-bold text-slate-800 dark:text-slate-150">Подробная запись работы</div>
      <p className="text-xs text-slate-600 dark:text-slate-400">
        Запросы, работа базы, паузы отрисовки, мост оболочки и работа редакторов — со временем
        каждой операции. Содержимое документов, тела запросов и пароли не записываются.
      </p>
      <p className="text-2xs text-slate-500 dark:text-slate-400">
        Не записываются: старые запросы XMLHttpRequest, чтение ответа потоком, работа других
        программ и сетевые пакеты системы. При аварийном завершении последняя секунда может
        не доехать до файла.
      </p>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-2xs">
        <dt className="text-slate-500 dark:text-slate-400">Событий в этом окне</dt>
        <dd className="tabular-nums text-slate-700 dark:text-slate-300">{own.tail}</dd>
        <dt className="text-slate-500 dark:text-slate-400">Передача в оболочку</dt>
        <dd className="text-slate-700 dark:text-slate-300">
          {own.transport ? 'есть' : 'нет — работа в браузере'}
        </dd>
        {shell && (
          <>
            <dt className="text-slate-500 dark:text-slate-400">Записано на диск</dt>
            <dd className="tabular-nums text-slate-700 dark:text-slate-300">{shell.written}</dd>
            <dt className="text-slate-500 dark:text-slate-400">Занято файлами</dt>
            <dd className="tabular-nums text-slate-700 dark:text-slate-300">{mb(shell.bytesOnDisk)}</dd>
            <dt className="text-slate-500 dark:text-slate-400">Свободно на диске</dt>
            <dd className="tabular-nums text-slate-700 dark:text-slate-300">{mb(shell.freeDiskBytes)}</dd>
          </>
        )}
        <dt className="text-slate-500 dark:text-slate-400">Потеряно событий</dt>
        <dd className={`tabular-nums font-semibold ${lost > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-slate-700 dark:text-slate-300'}`}>
          {lost}
        </dd>
      </dl>

      {lost > 0 && (
        <p className="text-2xs text-amber-700 dark:text-amber-400">
          Часть событий не сохранена: их вытеснила очередь или отказала запись. Счёт операций
          в сводке при этом занижен.
        </p>
      )}

      <div className="flex flex-wrap gap-2 pt-1">
        <button type="button" onClick={() => exportRendererDiagnostics()}
          className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold cursor-pointer">
          Выгрузить события окна
        </button>
        <button type="button" onClick={startDetailed} disabled={detailedLeft > 0}
          className="px-3 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-900 hover:bg-slate-200 dark:hover:bg-slate-800
                     text-xs font-semibold text-slate-700 dark:text-slate-300 cursor-pointer disabled:cursor-default disabled:opacity-60">
          {detailedLeft > 0 ? `Пишем подробно: ${detailedLeft} с` : `Записать подробно ${DETAILED_SECONDS} с`}
        </button>
        {own.transport && (
          <button type="button" onClick={() => void openFolder()}
            className="px-3 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-900 hover:bg-slate-200 dark:hover:bg-slate-800
                       text-xs font-semibold text-slate-700 dark:text-slate-300 cursor-pointer">
            Открыть подробные журналы
          </button>
        )}
      </div>
      <p className="text-2xs text-slate-500 dark:text-slate-400">
        Подробный режим дороже обычного и включается на минуту: он добавляет начала операций,
        события связи и команды редакторов.
      </p>
    </div>
  );
}
