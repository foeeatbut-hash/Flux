/**
 * Что видно в приложенных записях.
 *
 * Сводка отвечает на вопрос, ради которого записи и прикладывают: где ушло
 * время и что сломалось. Открывать для этого сам файл на тысячу строк —
 * работа, которую программа умеет сделать сама.
 *
 * Две оговорки показываются рядом с числами, а не прячутся: если часть событий
 * потеряна, счёт занижен; если остались незавершённые операции, их не надо
 * читать как «всё прошло». Сводка, умалчивающая о своей неполноте, хуже
 * отсутствующей — по ней делают выводы.
 */
import React from 'react';
import { Activity, AlertTriangle } from 'lucide-react';

export interface Bundle {
  id: string;
  attachmentId: string;
  manifest?: { bytes?: number; lines?: number; broken?: number };
  summary?: any;
  fingerprint?: string;
}

const ms = (value: number): string => (value >= 1000 ? `${(value / 1000).toFixed(1)} с` : `${Math.round(value)} мс`);

function Rows({ title, rows }: { title: string; rows: any[] }) {
  if (!rows?.length) return null;
  return (
    <div className="space-y-1">
      <div className="text-2xs font-semibold text-slate-500 dark:text-slate-400">{title}</div>
      {rows.slice(0, 5).map((row) => (
        <div key={row.name} className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300">
          <span className="min-w-0 flex-1 truncate font-mono">{row.name}</span>
          <span className="shrink-0 tabular-nums text-slate-500 dark:text-slate-400">
            {row.count}× · p95 {ms(row.p95)} · макс {ms(row.max)}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function FeedbackDiagnostics({ bundles }: { bundles: Bundle[] }) {
  if (!bundles?.length) return null;

  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3 space-y-3">
      <div className="flex items-center gap-2">
        <Activity className="w-3.5 h-3.5 text-slate-400" />
        <span className="text-xs font-bold text-slate-800 dark:text-slate-150">Что видно в записях</span>
      </div>

      {bundles.map((one) => {
        const s = one.summary || {};
        const broken = one.manifest?.broken || 0;
        return (
          <div key={one.id} className="space-y-2">
            <div className="text-2xs text-slate-500 dark:text-slate-400">
              {s.events || 0} событий
              {s.from ? ` · с ${new Date(s.from).toLocaleTimeString('ru-RU')}` : ''}
              {s.to ? ` по ${new Date(s.to).toLocaleTimeString('ru-RU')}` : ''}
              {s.sources?.length ? ` · ${s.sources.join(', ')}` : ''}
            </div>

            {(s.dropped > 0 || s.truncated || broken > 0) && (
              <p className="flex items-start gap-1.5 text-2xs text-amber-700 dark:text-amber-400">
                <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                <span>
                  Записи неполны: {s.dropped > 0 ? `потеряно событий — ${s.dropped}. ` : ''}
                  {s.truncated ? 'хвост обрезан. ' : ''}
                  {broken > 0 ? `не разобралось строк — ${broken}. ` : ''}
                  Счёт операций ниже настоящего.
                </span>
              </p>
            )}

            <Rows title="Дольше всего отвечали" rows={s.slowRoutes} />
            <Rows title="Дольше всего работала база" rows={s.slowDb} />
            <Rows title="Дольше всего думал офисный движок" rows={s.slowOffice} />

            {!!s.errors?.length && (
              <div className="space-y-1">
                <div className="text-2xs font-semibold text-slate-500 dark:text-slate-400">Ошибки</div>
                {s.errors.slice(0, 5).map((e: any) => (
                  <div key={e.code} className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300">
                    <span className="min-w-0 flex-1 truncate font-mono">{e.code}</span>
                    <span className="shrink-0 tabular-nums text-slate-500 dark:text-slate-400">{e.count}×</span>
                  </div>
                ))}
              </div>
            )}

            <div className="flex flex-wrap gap-x-4 gap-y-1 text-2xs text-slate-500 dark:text-slate-400">
              {s.stalls?.count > 0 && <span>Замирало {s.stalls.count}× · дольше всего {ms(s.stalls.maxMs)}</span>}
              {s.memory?.maxRssBytes > 0 && <span>Память до {Math.round(s.memory.maxRssBytes / 1048576)} МБ</span>}
              {s.unfinished > 0 && <span>Незавершённых операций: {s.unfinished}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
