/**
 * Связь с базой в трее.
 *
 * Пока всё хорошо — один значок с зелёной точкой, места не больше соседей.
 * Медленно — точка янтарная. Связь пропала — значок разворачивается в
 * красную метку «Нет связи · 12 с»: обрыв обязан быть замечен, и место на
 * панели он занимает ровно тогда, когда это важно.
 *
 * По нажатию — карточка: состояние и что делать, дорога до сервера и запрос
 * к базе отдельно, полоска последних замеров, какая база, версия сервера,
 * живой канал событий и «Проверить сейчас».
 */
import React from 'react';
import { createPortal } from 'react-dom';
import { Database, RefreshCw, WifiOff } from 'lucide-react';
import { useDbStatusStore } from '../../store/dbStatusStore';
import { useRealTimeSync } from '../SocketProvider';
import {
  STATE_HINT, STATE_LABEL, SLOW_DB_MS, SLOW_RTT_MS, agoLabel, lastGood, modeLabel, msLabel, type DbSample, type DbState,
} from '../../lib/dbStatus';
import { BAR_BTN, BAR_H, TRAY_ICON } from '../../lib/metrics';
import { Z } from '../../lib/layers';

const DOT: Record<DbState, string> = {
  checking: 'bg-slate-400',
  ok: 'bg-emerald-500',
  slow: 'bg-amber-500',
  'db-down': 'bg-rose-600',
  offline: 'bg-rose-600',
};

export default function DbStatusTray({ trayBtn }: { trayBtn: (active: boolean) => string }) {
  const state = useDbStatusStore((s) => s.state);
  const samples = useDbStatusStore((s) => s.samples);
  const [open, setOpen] = React.useState(false);
  const [now, setNow] = React.useState(() => Date.now());
  const btnRef = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => useDbStatusStore.getState().subscribe(), []);
  const bad = state === 'offline' || state === 'db-down';
  // Секунды «нет связи N с» и «проверено N с назад» идут, только когда их видно
  React.useEffect(() => {
    if (!bad && !open) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [bad, open]);

  const last = samples[samples.length - 1];
  const good = lastGood(samples);
  const title = `${STATE_LABEL[state]}${last?.rtt != null ? ` · сервер ${msLabel(last.rtt)}` : ''}${last?.dbMs != null ? ` · база ${msLabel(last.dbMs)}` : ''}`;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={title}
        title={title}
        data-db-state={state}
        style={bad ? { height: BAR_BTN } : { width: BAR_BTN, height: BAR_BTN }}
        className={bad
          ? 'relative flex items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium cursor-pointer transition-colors bg-rose-50 text-rose-700 hover:bg-rose-100 dark:bg-rose-950/50 dark:text-rose-300 dark:hover:bg-rose-950'
          : trayBtn(open)}
      >
        {bad ? <WifiOff size={16} /> : <Database size={TRAY_ICON} />}
        {bad
          ? <span className="tabular-nums whitespace-nowrap">{state === 'offline' ? 'Нет связи' : 'База недоступна'}{good ? ` · ${short(now - good.at)}` : ''}</span>
          : <span aria-hidden className={`absolute bottom-2 right-2 h-2 w-2 rounded-full ring-2 ring-white dark:ring-dark-bg ${DOT[state]}`} />}
      </button>
      {open && <DbStatusCard state={state} samples={samples} now={now} anchor={btnRef.current} onClose={() => setOpen(false)} />}
    </>
  );
}

function short(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} с` : s < 3600 ? `${Math.floor(s / 60)} мин` : `${Math.floor(s / 3600)} ч`;
}

function DbStatusCard({ state, samples, now, anchor, onClose }: {
  state: DbState; samples: DbSample[]; now: number; anchor: HTMLElement | null; onClose: () => void;
}) {
  const info = useDbStatusStore((s) => s.info);
  const { isConnected } = useRealTimeSync();
  const [busy, setBusy] = React.useState(false);
  const boxRef = React.useRef<HTMLDivElement>(null);
  const last = samples[samples.length - 1];
  const good = lastGood(samples);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!boxRef.current?.contains(t) && !anchor?.contains(t)) onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown, true);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mousedown', onDown, true); };
  }, [onClose, anchor]);

  // Карточка встаёт над своей кнопкой, но не вылезает за правый край экрана
  const r = anchor?.getBoundingClientRect();
  const W = 300;
  const left = r ? Math.min(Math.max(8, r.right - W), window.innerWidth - W - 8) : window.innerWidth - W - 8;

  const recheck = async () => { setBusy(true); try { await useDbStatusStore.getState().checkNow(); } finally { setBusy(false); } };

  return createPortal(
    <div ref={boxRef} role="dialog" aria-label="Связь с базой"
      style={{ left, bottom: BAR_H + 6, width: W, zIndex: Z.tray }}
      className="fx-dialog fx-dialog-in fixed overflow-hidden text-xs dark:border-dark-border dark:bg-dark-surface">
      <div className="flex items-start gap-2.5 px-3.5 pt-3 pb-2.5">
        <span aria-hidden className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${DOT[state]}`} />
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-slate-900 dark:text-slate-100">{STATE_LABEL[state]}</div>
          <p className="mt-0.5 leading-snug text-slate-500 dark:text-slate-400">{STATE_HINT[state]}</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-px border-y border-slate-200 bg-slate-200 dark:border-dark-border dark:bg-dark-border">
        <Metric label="Сервер" value={msLabel(last?.rtt ?? null)} warn={(last?.rtt ?? 0) > SLOW_RTT_MS} />
        <Metric label="Запрос к базе" value={msLabel(last?.dbMs ?? null)} warn={(last?.dbMs ?? 0) > SLOW_DB_MS} />
      </div>

      <div className="px-3.5 pt-3">
        <Spark samples={samples} />
        <div className="mt-1 flex justify-between text-2xs text-slate-400 dark:text-slate-500">
          <span>последние {samples.length} замеров</span>
          <span>{last ? agoLabel(last.at, now) : '—'}</span>
        </div>
      </div>

      <dl className="space-y-1.5 px-3.5 py-3 text-slate-600 dark:text-slate-300">
        <Row k="База" v={info ? modeLabel(info.mode, info.dialect) : '—'} />
        <Row k="Сервер" v={info?.version ? `версия ${info.version}` : '—'} />
        <Row k="События" v={isConnected ? 'приходят сразу' : 'нет канала — данные обновятся при проверке'} dim={!isConnected} />
        {state !== 'ok' && state !== 'checking' && <Row k="Последний ответ" v={good ? agoLabel(good.at, now) : 'ещё не было'} />}
      </dl>

      <div className="flex justify-end border-t border-slate-200 px-3 py-2 dark:border-dark-border">
        <button type="button" onClick={() => void recheck()} disabled={busy} className="fx-btn">
          <RefreshCw className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} />
          Проверить сейчас
        </button>
      </div>
    </div>,
    document.body,
  );
}

function Metric({ label, value, warn }: { label: string; value: string; warn: boolean }) {
  return (
    <div className="bg-white px-3.5 py-2 dark:bg-dark-surface">
      <div className="text-2xs text-slate-400 dark:text-slate-500">{label}</div>
      <div className={`text-[15px] font-semibold tabular-nums ${warn ? 'text-amber-600 dark:text-amber-400' : 'text-slate-900 dark:text-slate-100'}`}>{value}</div>
    </div>
  );
}

function Row({ k, v, dim }: { k: string; v: string; dim?: boolean }) {
  return (
    <div className="flex gap-2">
      <dt className="w-24 shrink-0 text-slate-400 dark:text-slate-500">{k}</dt>
      <dd className={`min-w-0 ${dim ? 'text-amber-700 dark:text-amber-400' : ''}`}>{v}</dd>
    </div>
  );
}

/**
 * Полоска замеров: столбик на замер, высота — дорога до сервера. Пропущенный
 * замер — красная риска во всю высоту: обрыв видно в истории, даже когда
 * связь уже вернулась
 */
function Spark({ samples }: { samples: DbSample[] }) {
  const H = 28;
  const max = Math.max(SLOW_RTT_MS, ...samples.map((s) => (s.rtt ?? 0) + (s.dbMs ?? 0)));
  return (
    <div className="flex h-7 items-end gap-[3px]" aria-hidden>
      {samples.map((s, i) => {
        const v = (s.rtt ?? 0) + (s.dbMs ?? 0);
        const h = !s.reached || !s.dbOk ? H : Math.max(3, Math.round((v / max) * H));
        const cls = !s.reached || !s.dbOk ? 'bg-rose-500' : v > SLOW_RTT_MS ? 'bg-amber-400' : 'bg-emerald-500/70';
        return <span key={i} style={{ height: h }} className={`w-[7px] rounded-[2px] ${cls}`} />;
      })}
    </div>
  );
}
