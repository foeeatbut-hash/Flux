/**
 * Сводка по потоку обращений.
 *
 * Числа здесь показываются вместе с тем, сколько случаев за ними стоит. Без
 * этого сводка врёт убедительно: «медиана ответа — четыре минуты» читается
 * одинаково уверенно и по тремстам случаям, и по трём, а решения по ней
 * принимают такие же. Поэтому при малой выборке вместо числа стоит «мало
 * данных» — это честный ответ, а не пропуск.
 */
import React, { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { getSummary } from '../../feedback/feedbackApi';

const PERIODS = [
  { days: 1, name: 'Сегодня' },
  { days: 7, name: 'Неделя' },
  { days: 30, name: 'Месяц' },
  { days: 365, name: 'Год' },
];

/** Длительность человеческими словами: миллисекунды читать невозможно. */
export function humanMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms as number)) return 'мало данных';
  const minutes = Math.round((ms as number) / 60000);
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} ч`;
  return `${Math.round(hours / 24)} дн`;
}

function Number_({ name, value, note }: { name: string; value: React.ReactNode; note?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3">
      <div className="text-xs text-slate-500 dark:text-slate-400">{name}</div>
      <div className="text-sm font-bold text-slate-900 dark:text-white mt-0.5">{value}</div>
      {note && <div className="text-2xs text-slate-500 dark:text-slate-400 mt-0.5">{note}</div>}
    </div>
  );
}

function Slice({ title, rows }: { title: string; rows: Array<{ name: string; count: number }> }) {
  if (!rows?.length) return null;
  const top = rows[0]?.count || 1;
  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3 space-y-1.5">
      <div className="text-xs font-bold text-slate-800 dark:text-slate-150">{title}</div>
      {rows.map((row) => (
        <div key={row.name} className="flex items-center gap-2">
          <span className="w-32 shrink-0 truncate text-xs text-slate-700 dark:text-slate-300">{row.name}</span>
          <span className="flex-1 h-1.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
            <span className="block h-full bg-emerald-500" style={{ width: `${Math.round((row.count / top) * 100)}%` }} />
          </span>
          <span className="w-8 shrink-0 text-right text-xs text-slate-500 dark:text-slate-400">{row.count}</span>
        </div>
      ))}
    </div>
  );
}

export default function FeedbackSummary() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<any>(null);
  const [failure, setFailure] = useState('');

  const load = (period: number) => {
    getSummary(period).then((got) => { setData(got); setFailure(''); })
      .catch((error: any) => setFailure(error?.message || 'Сводка не собралась'));
  };

  useEffect(() => { load(days); }, [days]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5 flex-wrap">
        {PERIODS.map((one) => (
          <button key={one.days} type="button" onClick={() => setDays(one.days)}
            className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold cursor-pointer border
              ${days === one.days
                ? 'bg-emerald-600 border-emerald-600 text-white'
                : 'border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300'}`}>
            {one.name}
          </button>
        ))}
        <button type="button" onClick={() => load(days)} title="Пересчитать"
          className="w-8 h-8 rounded-lg flex items-center justify-center cursor-pointer text-slate-500
                     hover:bg-slate-100 dark:hover:bg-slate-850">
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>

      {failure && <p className="text-xs text-rose-600 dark:text-rose-400">{failure}</p>}
      {!data && !failure && <p className="text-xs text-slate-500 dark:text-slate-400">Считаем…</p>}

      {data && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            <Number_ name="Поступило" value={data.arrived} />
            <Number_ name="Закрыто" value={data.closed} note="по переходам в «Готово»" />
            <Number_ name="Открыто сейчас" value={data.open} />
            <Number_ name="Без исполнителя" value={data.unassigned} />
            <Number_ name="Ждут ответа автора" value={data.waitingAuthor} />
            <Number_ name="Вернули в работу" value={data.reopened} />
            <Number_ name="Первый ответ" value={humanMs(data.firstAnswerMs)}
              note={`случаев: ${data.answeredCount}`} />
            <Number_ name="До «Готово»" value={humanMs(data.solveMs)} note={`случаев: ${data.solvedCount}`} />
            <Number_ name="Разных авторов" value={data.authors} />
          </div>

          <Slice title="По видам" rows={data.byType} />
          <Slice title="По разделам" rows={data.bySection} />
          <Slice title="По версиям программы" rows={data.byVersion} />
          <Slice title="Чем заняты открытые" rows={data.byStatus} />

          <p className="text-xs text-slate-500 dark:text-slate-400">
            «Мало данных» значит, что случаев меньше {data.enough} — по такой выборке медиана
            обманывает сильнее, чем помогает.
          </p>
        </>
      )}
    </div>
  );
}
