/**
 * Английская версия документа: сверка перед выпуском.
 *
 * Ни один документ не уходит заказчику «нажал — получил». Сначала показывается
 * таблица: слева русская ячейка, справа перевод, у каждой строки видно, откуда
 * он взялся. Строку можно поправить, и правка тут же ложится в память —
 * следующая ревизия переведётся ею сама.
 *
 * Английская версия рождается отдельным документом, а не переписывает открытый.
 * Так устроены все опасные действия программы: сначала план, потом решение
 * человека. Испорченная молча ведомость дороже любого удобства.
 */
import React from 'react';
import { motion } from 'motion/react';
import { X, Languages, Loader2, TriangleAlert } from 'lucide-react';
import SegmentRows, { type Row } from './SegmentRows';
import {
  BI_MODES, collectDocCells, docFingerprint, modesFor, applyTranslation, cellKey, type BiMode,
} from '../../translate/docPlan';
import { readiness } from '../../translate/engine';
import { detectLang } from '../../translate/lang';
import { useTranslateStore } from '../../store/translateStore';
import { useToastStore } from '../../store/toastStore';
import { useEscapeClose } from '../../lib/useDismiss';

interface Props {
  snapshot: any;
  docName: string;
  onClose: () => void;
  /** Создать документ: возвращает true, если получилось */
  onCreate: (mode: BiMode, workbook: string, name: string, sourcePrint: string) => Promise<boolean>;
}

export default function EnglishVersion({ snapshot, docName, onClose, onCreate }: Props) {
  const { addToast } = useToastStore();
  const one = useTranslateStore((s) => s.one);
  const remember = useTranslateStore((s) => s.remember);

  const cells = React.useMemo(() => collectDocCells(snapshot), [snapshot]);
  const allowed = React.useMemo(() => modesFor(snapshot), [snapshot]);
  const [mode, setMode] = React.useState<BiMode>('file');
  const [busy, setBusy] = React.useState(false);
  const [rows, setRows] = React.useState<Row[]>([]);

  useEscapeClose(!busy, onClose);

  React.useEffect(() => {
    setRows(cells.map((c) => {
      const from = detectLang(c.text) === 'en' ? 'en' : 'ru';
      const seg = one(c.text, from, from === 'ru' ? 'en' : 'ru');
      // Ячейка, уже написанная по-английски, переводу не подлежит: это чаще
      // всего марка, стандарт или шапка, оставленная как есть
      return from === 'en' ? { src: c.text, dst: c.text, origin: 'kept' as const, ok: true } : { ...seg };
    }));
  }, [cells, one]);

  React.useEffect(() => {
    if (!allowed.includes(mode)) setMode(allowed[0] || 'file');
  }, [allowed, mode]);

  const ready = readiness(rows);
  const empty = !cells.length;

  const build = async () => {
    const pairs = new Map<string, string>();
    rows.forEach((r, i) => {
      const cell = cells[i];
      if (!cell || !r.dst.trim() || r.origin === 'kept') return;
      pairs.set(cellKey(cell.sheetId, cell.r, cell.c), r.dst.trim());
    });
    if (!pairs.size) { addToast('Переводить нечего: ни одна строка не переведена', 'error'); return; }

    const res = applyTranslation(snapshot, pairs, mode);
    if (res.problem) { addToast(res.problem, 'error'); return; }
    if (!res.changed) { addToast('Перевод не встал в документ', 'error'); return; }

    setBusy(true);
    try {
      const suffix = mode === 'file' ? 'EN' : 'RU-EN';
      const okDone = await onCreate(mode, JSON.stringify(res.snap), `${docName} ${suffix}`, docFingerprint(snapshot));
      if (!okDone) return;
      // Подтверждённое человеком уходит в память: следующая ревизия этой же
      // ведомости переведётся его словами, а не заново придуманными
      const units = rows
        .filter((r) => r.ok && r.src.trim() && r.dst.trim() && r.origin !== 'kept')
        .map((r) => ({ src: r.src.trim(), dst: r.dst.trim(), from: 'ru' as const, to: 'en' as const }));
      if (units.length) await remember(units);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[85] overflow-y-auto" role="dialog" aria-modal="true" aria-label="Английская версия">
      <div className="fixed inset-0 fx-backdrop" onClick={() => !busy && onClose()} />
      <div className="flex min-h-full items-center justify-center p-4">
        <motion.div
          initial={{ opacity: 0, scale: 0.97, y: 12 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 0.15 }}
          className="fx-dialog @container relative w-full max-w-4xl max-h-[88vh] flex flex-col"
        >
          <div className="shrink-0 flex items-center gap-2 px-5 py-3 border-b border-slate-200 dark:border-slate-800">
            <Languages className="w-4 h-4 shrink-0 text-emerald-700 dark:text-emerald-400" />
            <h3 className="flex-1 min-w-0 truncate text-base font-semibold text-slate-900 dark:text-white">
              Английская версия · {docName}
            </h3>
            <button type="button" onClick={onClose} disabled={busy} aria-label="Закрыть"
              className="p-1 rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer">
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="shrink-0 px-5 py-3 border-b border-slate-200 dark:border-slate-800 space-y-2">
            <p className="text-2xs font-semibold text-slate-400 dark:text-slate-500">
              Как отдаём заказчику
            </p>
            <div className="flex flex-wrap gap-1.5">
              {BI_MODES.map((m) => {
                const off = !allowed.includes(m.id);
                return (
                  <button key={m.id} type="button" disabled={off || busy}
                    onClick={() => setMode(m.id)}
                    title={off ? 'На листе есть формулы: сдвиг столбцов увёл бы их ссылки' : m.hint}
                    className={`px-2.5 py-1.5 rounded-lg text-2xs font-semibold cursor-pointer
                      disabled:opacity-40 disabled:cursor-not-allowed ${mode === m.id
                      ? 'bg-emerald-600 text-white'
                      : 'bg-slate-100 dark:bg-slate-850 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-800'}`}>
                    {m.label}
                  </button>
                );
              })}
            </div>
            <p className="text-2xs text-slate-500 dark:text-slate-400">
              {BI_MODES.find((m) => m.id === mode)?.hint}
            </p>
          </div>

          {empty ? (
            <div className="flex-1 flex items-center justify-center p-10 text-sm text-slate-400 dark:text-slate-500 text-center">
              В документе нет текста, который стоило бы переводить: только числа, коды и формулы.
            </div>
          ) : (
            <div className="flex-1 min-h-0 overflow-hidden">
              <SegmentRows rows={rows} side showOrigin
                onChange={(i, dst) => setRows((l) => l.map((r, n) => (n === i ? { ...r, dst, ok: true } : r)))}
                onConfirm={(i) => setRows((l) => l.map((r, n) => (n === i ? { ...r, ok: !r.ok } : r)))} />
            </div>
          )}

          <div className="shrink-0 flex flex-wrap items-center gap-3 px-5 py-3 border-t border-slate-200 dark:border-slate-800">
            <span className="flex items-center gap-1.5 text-2xs text-slate-500 dark:text-slate-400">
              Строк: {rows.filter((r) => r.origin !== 'kept').length} · из памяти {ready.ready} из {ready.total}
            </span>
            {ready.total > ready.ready && (
              <span className="flex items-center gap-1.5 text-2xs text-amber-700 dark:text-amber-400">
                <TriangleAlert className="w-3.5 h-3.5" />
                Остальное сложено по словарю — прочитайте перед отправкой
              </span>
            )}
            <span className="flex-1" />
            <button type="button" onClick={onClose} disabled={busy}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-600 dark:text-slate-300
                         hover:bg-slate-100 dark:hover:bg-slate-850 cursor-pointer">
              Отмена
            </button>
            <button type="button" onClick={build} disabled={busy || empty}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600
                         text-white hover:bg-emerald-700 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed">
              {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Создать документ
            </button>
          </div>
        </motion.div>
      </div>
    </div>
  );
}
