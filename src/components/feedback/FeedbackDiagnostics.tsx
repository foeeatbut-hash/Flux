/**
 * Что видно в приложенных записях — глазами разбирающего.
 *
 * Сводка отвечает на вопрос, ради которого записи и прикладывают: где ушло
 * время и что сломалось. Открывать для этого файл на тысячу строк — работа,
 * которую программа умеет сделать сама.
 *
 * **Покрытие идёт первым разделом, до чисел.** Это не оформление, а главное:
 * разбирающий, увидевший сводку без ошибок, делает вывод «ошибок не было» — а
 * их могло просто не записаться. Сводка, умалчивающая о своей неполноте, хуже
 * отсутствующей, потому что по ней принимают решения.
 *
 * Малая выборка называется малой. Показать p95 по трём измерениям и не
 * сказать, что их три, — значит выдать шум за измерение.
 */
import React, { useState } from 'react';
import { Activity, AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, FileDown } from 'lucide-react';
import {
  BUNDLE_STATE_NAMES, SOURCE_NAMES, SOURCE_STATE_NAMES,
  type SourceReport,
} from '../../../feedback/bundleSpec';

export interface Bundle {
  id: string;
  attachmentId: string;
  state?: string;
  snapshotId?: string;
  attempt?: number;
  manifest?: {
    bytes?: number; lines?: number; broken?: number;
    sources?: SourceReport[];
    requestedFrom?: string; requestedTo?: string;
    buildId?: string; error?: string;
  };
  summary?: any;
  fingerprint?: string;
}

const ms = (value: number): string => (value >= 1000 ? `${(value / 1000).toFixed(1)} с` : `${Math.round(value)} мс`);
const at = (iso?: string): string => (iso ? new Date(iso).toLocaleTimeString('ru-RU') : '—');

/** Меньше этого выборка ничего не измеряет — так и говорим. */
const ENOUGH = 5;

function Section({ title, children, open: initial = false }: {
  title: string; children: React.ReactNode; open?: boolean;
}) {
  const [open, setOpen] = useState(initial);
  return (
    <div className="border-t border-slate-200 dark:border-slate-800 pt-2 first:border-t-0 first:pt-0">
      <button type="button" onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-1.5 text-2xs font-semibold text-slate-600 dark:text-slate-300 cursor-pointer">
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        {title}
      </button>
      {open && <div className="mt-1.5 space-y-1">{children}</div>}
    </div>
  );
}

/** Медленные операции. Точность выборки называется рядом с числами. */
function Slow({ rows }: { rows: any[] }) {
  if (!rows?.length) return <p className="text-2xs text-slate-500 dark:text-slate-400">Ничего не замерено</p>;
  return (
    <>
      {rows.slice(0, 8).map((row) => (
        <div key={row.name} className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300">
          <span className="min-w-0 flex-1 truncate font-mono">{row.name}</span>
          <span className="shrink-0 tabular-nums text-slate-500 dark:text-slate-400">
            {row.count}×
            {row.count >= ENOUGH
              ? ` · p50 ${ms(row.p50)} · p95 ${ms(row.p95)} · макс ${ms(row.max)}`
              : ` · макс ${ms(row.max)}`}
          </span>
          {row.count < ENOUGH && (
            <span className="shrink-0 text-2xs text-amber-700 dark:text-amber-400" title="Меньше пяти измерений">
              мало данных
            </span>
          )}
          {row.count >= ENOUGH && row.exact === false && (
            <span className="shrink-0 text-2xs text-amber-700 dark:text-amber-400" title="Выборка усечена">
              оценка
            </span>
          )}
        </div>
      ))}
    </>
  );
}

/** Покрытие: что приложено, чего нет и почему. */
function Coverage({ sources, state, error }: { sources: SourceReport[]; state?: string; error?: string }) {
  if (error) {
    return (
      <div className="flex items-start gap-2 text-xs text-rose-600 dark:text-rose-400">
        <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
        <span>{error}</span>
      </div>
    );
  }
  if (!sources.length) {
    return (
      <p className="text-2xs text-amber-700 dark:text-amber-400">
        Опись источников не записана — судить о полноте нечем
      </p>
    );
  }
  return (
    <>
      {state && state !== 'READY' && (
        <p className="text-2xs text-amber-700 dark:text-amber-400">
          Пакет {BUNDLE_STATE_NAMES[state as keyof typeof BUNDLE_STATE_NAMES] || state}: часть записей отсутствует,
          и «нет ошибок» здесь не значит «ошибок не было»
        </p>
      )}
      {sources.map((one) => {
        const fine = one.state === 'available';
        // Отсутствие оболочки в браузере — устройство программы, а не изъян:
        // красить его тревожным цветом значит приучить не смотреть на цвет
        const expected = one.state === 'unavailable';
        return (
          <div key={one.source} className="flex items-start gap-2 text-xs">
            {fine
              ? <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 shrink-0 text-emerald-600" />
              : <AlertTriangle className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${expected ? 'text-slate-400' : 'text-amber-500'}`} />}
            <div className="min-w-0 flex-1">
              <span className="text-slate-700 dark:text-slate-300">
                {SOURCE_NAMES[one.source] || one.source} — {SOURCE_STATE_NAMES[one.state] || one.state}
              </span>
              <span className="text-slate-500 dark:text-slate-400">
                {one.events ? ` · событий ${one.events}` : ''}
                {one.omitted ? ` · не поместилось ${one.omitted}` : ''}
                {one.dropped ? ` · потеряно при записи ${one.dropped}` : ''}
                {one.broken ? ` · не разобрано ${one.broken}` : ''}
              </span>
              {one.reason && (
                <p className="text-2xs text-slate-500 dark:text-slate-400">{one.reason}</p>
              )}
              {one.from && one.to && (
                <p className="text-2xs text-slate-500 dark:text-slate-400">
                  покрывает {at(one.from)} — {at(one.to)}
                </p>
              )}
            </div>
          </div>
        );
      })}
    </>
  );
}

export default function FeedbackDiagnostics({ bundles, onPackage }: {
  bundles: Bundle[];
  /** Скачать пакет для разработчика. Право проверяет сервер. */
  onPackage?: () => void;
}) {
  if (!bundles?.length) return null;

  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <Activity className="w-3.5 h-3.5 text-slate-400" />
        <span className="text-xs font-bold text-slate-800 dark:text-slate-150">Что видно в записях</span>
        <span className="flex-1" />
        {onPackage && (
          <button type="button" onClick={onPackage}
            className="px-2.5 py-1 rounded-lg flex items-center gap-1 text-2xs font-semibold cursor-pointer
                       bg-slate-100 dark:bg-slate-900 hover:bg-slate-200 dark:hover:bg-slate-800
                       text-slate-700 dark:text-slate-300">
            <FileDown className="w-3 h-3" /> Пакет для разработчика
          </button>
        )}
      </div>

      {bundles.map((one) => {
        const s = one.summary || {};
        const manifest = one.manifest || {};
        const sources = (manifest.sources || []) as SourceReport[];
        const stalls = s.stalls || { count: 0, maxMs: 0 };

        if (one.state === 'PENDING') {
          return (
            <p key={one.id} className="text-2xs text-slate-500 dark:text-slate-400">
              Пакет собирается — записи сервера и базы ещё добираются
              {one.attempt ? ` (попытка ${one.attempt})` : ''}
            </p>
          );
        }

        return (
          <div key={one.id} className="space-y-2">
            <div className="text-2xs text-slate-500 dark:text-slate-400">
              {s.events || 0} событий
              {s.from ? ` · ${at(s.from)} — ${at(s.to)}` : ''}
              {manifest.buildId ? ` · сборка ${manifest.buildId}` : ''}
            </div>

            {/* Покрытие — первым: по нему читаются все остальные числа */}
            <Section title="Покрытие: что приложено и чего нет" open>
              <Coverage sources={sources} state={one.state} error={manifest.error} />
            </Section>

            <Section title="Задержки">
              <div className="text-2xs text-slate-500 dark:text-slate-400">Запросы</div>
              <Slow rows={s.slowRoutes} />
              <div className="mt-1.5 text-2xs text-slate-500 dark:text-slate-400">База</div>
              <Slow rows={s.slowDb} />
              {!!s.slowOffice?.length && (
                <>
                  <div className="mt-1.5 text-2xs text-slate-500 dark:text-slate-400">Офисный движок</div>
                  <Slow rows={s.slowOffice} />
                </>
              )}
              {stalls.count > 0 && (
                <p className="text-xs text-slate-700 dark:text-slate-300">
                  Паузы интерфейса: {stalls.count}, самая долгая {ms(stalls.maxMs)}
                </p>
              )}
            </Section>

            <Section title="Ошибки">
              {s.errors?.length ? s.errors.slice(0, 8).map((e: any) => (
                <div key={e.code} className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300">
                  <span className="min-w-0 flex-1 truncate font-mono">{e.code}</span>
                  <span className="shrink-0 tabular-nums text-slate-500 dark:text-slate-400">{e.count}×</span>
                </div>
              )) : (
                // Разница принципиальная, и она сказана словами
                <p className="text-2xs text-slate-500 dark:text-slate-400">
                  Ошибок в приложенных записях нет.
                  {one.state !== 'READY' && ' Но записаны не все источники — см. «Покрытие».'}
                </p>
              )}
            </Section>

            {!!s.chains?.length && (
              <Section title="Цепочки: запрос и работа базы">
                {s.chains.slice(0, 8).map((c: any) => (
                  <div key={c.trace} className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300">
                    <span className="min-w-0 flex-1 truncate font-mono">{c.route}</span>
                    <span className="shrink-0 tabular-nums text-slate-500 dark:text-slate-400">
                      всего {ms(c.totalMs)} · база {ms(c.dbMs)} ({c.dbOps})
                    </span>
                  </div>
                ))}
                {/* Отрезки базы объединены, а не сложены: параллельные операции
                    при сложении дали бы «база заняла больше, чем весь запрос» */}
                <p className="text-2xs text-slate-500 dark:text-slate-400">
                  Время базы — объединение отрезков работы, а не их сумма.
                </p>
              </Section>
            )}

            {(s.dropped > 0 || s.truncated || s.unfinished > 0 || (manifest.broken || 0) > 0) && (
              <div className="flex items-start gap-2 text-2xs text-amber-700 dark:text-amber-400">
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>
                  {s.dropped > 0 && `Потеряно событий: ${s.dropped}. `}
                  {s.truncated && 'Хвост записей неполон. '}
                  {(manifest.broken || 0) > 0 && `Строк не разобралось: ${manifest.broken}. `}
                  {s.unfinished > 0 && `Незавершённых операций: ${s.unfinished} — это не «всё прошло». `}
                  Счёт выше занижен.
                </span>
              </div>
            )}

            {one.fingerprint && (
              <p className="text-2xs font-mono text-slate-400 dark:text-slate-500 truncate">
                отпечаток {one.fingerprint.slice(0, 16)}…
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
