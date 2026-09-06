/**
 * Вкладка «Экспорт и импорт» раздела «Теги».
 *
 * Всё, чем теги попадают в программу и уходят из неё, собрано на одной
 * вкладке. Раньше это было раскидано: мастер импорта и захват с экрана лежали
 * внутри «Подбора» — вкладки про разбор кодов, где их никто не искал, — а
 * выгрузка была не вкладкой, а кнопкой в одном ряду со вкладками и оттого
 * читалась как вкладка, которая не открывается.
 *
 * Вкладка стоит после «Спецификации» — последней в ряду, как в любой
 * программе: сначала работа, потом обмен с внешним миром.
 *
 * Разделы — плитки, а не полосы во всю ширину. Полос было три, каждая с
 * абзацем пояснения и кнопкой у правого края: на широком окне название и
 * кнопка расходились в разные концы экрана, и глаз вёл по пустоте от одного к
 * другой. Плитка держит название, пояснение и действие вместе, и нажимается
 * вся целиком — целиться в кнопку не надо.
 */
import React from 'react';
import { FileSpreadsheet, Scissors, Download } from 'lucide-react';

/** Есть ли захват экрана: он живёт в оболочке, в браузере его нет */
export const hasCapture = (): boolean => !!(window as any).electron?.capture;

/** Одна плитка обмена: значок, название, строка пояснения, действие */
function Card({ tone, icon, title, hint, action, onClick, tour }: {
  tone: 'emerald' | 'slate' | 'sky';
  icon: React.ReactNode;
  title: string;
  hint: string;
  action: string;
  onClick: () => void;
  tour?: string;
}) {
  const box = {
    emerald: 'bg-emerald-100 dark:bg-emerald-950/50 text-emerald-600 dark:text-emerald-400',
    slate: 'bg-slate-100 dark:bg-slate-900 text-slate-600 dark:text-slate-300',
    sky: 'bg-sky-100 dark:bg-sky-950/50 text-sky-600 dark:text-sky-400',
  }[tone];
  const edge = {
    emerald: 'hover:border-emerald-300 dark:hover:border-emerald-800',
    slate: 'hover:border-slate-300 dark:hover:border-slate-700',
    sky: 'hover:border-sky-300 dark:hover:border-sky-800',
  }[tone];
  const label = {
    emerald: 'text-emerald-700 dark:text-emerald-400',
    slate: 'text-slate-700 dark:text-slate-300',
    sky: 'text-sky-700 dark:text-sky-400',
  }[tone];
  return (
    <button
      type="button"
      onClick={onClick}
      data-tour={tour}
      title={hint}
      className={`h-full flex flex-col items-start gap-2 p-4 text-left rounded-xl cursor-pointer
                  bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-850
                  shadow-xs hover:shadow-sm transition-ui ${edge}`}
    >
      <span className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${box}`}>{icon}</span>
      <b className="text-sm font-bold text-slate-900 dark:text-white">{title}</b>
      <span className="text-xs text-slate-500 leading-snug flex-1">{hint}</span>
      <span className={`text-2xs font-bold uppercase tracking-wide ${label}`}>{action} →</span>
    </button>
  );
}

export default function ExchangeTab({ total, onImport, onExport }: {
  /** Сколько тегов в проекте — чтобы человек видел, что именно уйдёт */
  total: number;
  onImport: () => void;
  onExport: () => void;
}) {
  return (
    <div className="grid grid-cols-1 @[520px]:grid-cols-2 @[880px]:grid-cols-3 gap-3 text-left items-stretch">
      <Card
        tone="emerald"
        icon={<FileSpreadsheet className="w-5 h-5" />}
        title="Импорт из таблицы"
        hint="Загрузите Excel в Проводник или вставьте данные и отметьте колонки."
        action="Открыть мастер"
        onClick={onImport}
        tour="tag-import-btn"
      />
      <Card
        tone="slate"
        icon={<Download className="w-5 h-5" />}
        title="Выгрузка тегов"
        hint={`Файл или буфер обмена, выбранные колонки, все теги или только отмеченные. Сейчас в проекте ${total}.`}
        action="Выгрузить"
        onClick={onExport}
      />
      {/* Захвата нет в браузере: обещать плиткой то, чего не будет, нельзя */}
      {hasCapture() && (
        <Card
          tone="sky"
          icon={<Scissors className="w-5 h-5" />}
          title="Захват с экрана"
          hint="Программа свернётся в угол. Выделите теги в любом окне и скопируйте — пульт увидит буфер сам. Ctrl+Shift+X."
          action="Свернуть и захватить"
          onClick={() => (window as any).electron?.capture?.start()}
        />
      )}
    </div>
  );
}
