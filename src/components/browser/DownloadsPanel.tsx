/**
 * «Загрузки» в браузере: что скачано и где оно лежит.
 *
 * Раздел появился потому, что до него скачанное исчезало: браузер показывал
 * всплывающую подсказку «Скачивание: отчёт.pdf» и на этом всё — ни куда легло,
 * ни скачалось ли вообще. Теперь видно строку с полосой, а рядом — две
 * кнопки, отвечающие на единственные вопросы, которые тут задают: «открой» и
 * «покажи, где лежит».
 *
 * Наверху — путь к личной папке. Он не украшение: человек должен знать, где
 * искать файл, когда программа закрыта.
 */
import React from 'react';
import { Download, FolderOpen, FileDown, TriangleAlert, Trash2 } from 'lucide-react';
import { useDownloadStore } from '../../store/downloadStore';
import { progressText, progressRatio } from '../../lib/downloads';
import { useToastStore } from '../../store/toastStore';

const api = () => (window as any).electron?.browser || null;

export default function DownloadsPanel() {
  const items = useDownloadStore((s) => s.items);
  const clear = useDownloadStore((s) => s.clear);
  const { addToast } = useToastStore();
  const [dir, setDir] = React.useState('');

  React.useEffect(() => {
    let alive = true;
    api()?.downloadsDir?.().then((d: string) => { if (alive) setDir(d || ''); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const act = async (path: string, reveal: boolean) => {
    const r = await api()?.openDownload?.(path, reveal);
    if (r && !r.ok) addToast(r.error || 'Не удалось открыть файл', 'error');
  };

  return (
    <div className="absolute inset-0 overflow-y-auto p-4">
      <div className="flex items-center justify-between gap-3 mb-3">
        <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Загрузки</h2>
        {items.length > 0 && (
          <button type="button" onClick={clear}
            title="Убрать список. Сами файлы останутся на месте"
            className="flex items-center gap-1 text-2xs text-slate-500 hover:text-rose-600 cursor-pointer">
            <Trash2 className="w-3 h-3" /> Очистить список
          </button>
        )}
      </div>

      {!!dir && (
        <p className="text-2xs text-slate-400 font-mono mb-3 break-all">
          Всё скачивается сюда: {dir}
        </p>
      )}

      {items.length === 0 && (
        <p className="text-xs text-slate-400">
          Пока пусто. Скачанное с сайтов попадает в вашу личную папку — спрашивать, куда сохранить,
          программа не будет.
        </p>
      )}

      <ul className="space-y-1">
        {items.map((d) => {
          const bad = d.state === 'failed' || d.state === 'cancelled';
          const ratio = progressRatio(d);
          return (
            <li key={d.id}
              className="flex items-center gap-2.5 px-2 py-1.5 rounded-lg border border-slate-200 dark:border-dark-border">
              {bad
                ? <TriangleAlert className="w-4 h-4 shrink-0 text-amber-500" />
                : <Download className={`w-4 h-4 shrink-0 ${d.state === 'done' ? 'text-emerald-600' : 'text-slate-400'}`} />}
              <span className="flex-1 min-w-0">
                <span className="block text-xs font-semibold text-slate-800 dark:text-slate-100 truncate">{d.name}</span>
                <span className="block text-2xs text-slate-400 truncate">{progressText(d)}</span>
                {d.state === 'progress' && (
                  <span className="mt-1 block h-1 rounded-full bg-slate-150 dark:bg-slate-850 overflow-hidden">
                    {/* Без общего размера полосу не рисуем: заполненная наугад
                        полоса — это обещание, которого никто не давал */}
                    <span className="block h-full bg-emerald-500 transition-[width]"
                      style={{ width: `${Math.round(ratio * 100)}%` }} />
                  </span>
                )}
              </span>
              {d.state === 'done' && (
                <>
                  <button type="button" onClick={() => void act(d.path, false)} title="Открыть файл"
                    className="shrink-0 w-7 h-7 rounded-lg flex items-center justify-center cursor-pointer
                               text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-850">
                    <FileDown className="w-3.5 h-3.5" />
                  </button>
                  <button type="button" onClick={() => void act(d.path, true)} title="Показать в папке"
                    className="shrink-0 w-7 h-7 rounded-lg flex items-center justify-center cursor-pointer
                               text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-850">
                    <FolderOpen className="w-3.5 h-3.5" />
                  </button>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
