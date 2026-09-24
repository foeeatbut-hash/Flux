import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import {
  X, ArrowRight, ArrowLeft, Check, Loader2, Trash2, Plus, Undo2, Search,
  RotateCcw, ShieldCheck, AlertTriangle, ChevronDown,
} from 'lucide-react';
import { dataService } from '../services/dataService';
import { useStore } from '../store/store';
import { useToastStore } from '../store/toastStore';
import {
  recognize, buildTableRows, CaptureItem, Recognized, CaptureRow, Candidate, normCode, fitsShape,
} from '../capture/recognize';
import { FIELDS, FieldKey } from '../capture/fields';
import {
  buildPlan, summarize, PlanRow, Action, ACTION_LABEL, CLASS_LABEL, CLASS_TONE, ExistingTag,
} from '../capture/plan';

/**
 * Окно разбора захвата: слева исходник, справа то, во что программа его
 * разложила. Области связаны подсветкой в обе стороны — без этого разбивку
 * нельзя проверить, а значит и поверить ей.
 *
 * Три шага: разбор → план → отчёт. Ни одной записи в базу до «Применить»,
 * а после него ещё доступна отмена: снимок прежних значений снимается ДО
 * применения и лежит в отчёте, пока он открыт.
 */

const TONE_BADGE: Record<string, string> = {
  ok: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300',
  warn: 'bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300',
  bad: 'bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300',
  mute: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400',
};

/** Решения, которые инженер уже принимал в этом проекте */
const memKey = (pid: string) => `flux_capture_decisions_${pid}`;
const loadDecisions = (pid?: string): Partial<Record<string, Action>> => {
  if (!pid) return {};
  try { return JSON.parse(localStorage.getItem(memKey(pid)) || '{}'); } catch { return {}; }
};
const saveDecisions = (pid: string, plan: PlanRow[]) => {
  try {
    const map: Record<string, Action> = { ...(loadDecisions(pid) as any) };
    for (const r of plan) map[r.cls] = r.action;
    localStorage.setItem(memKey(pid), JSON.stringify(map));
  } catch {}
};

/** Поля тега помимо кода — показываются чипами и правятся в раскрытой строке */
const EXTRA = [
  { key: 'brand', label: 'Марка' },
  { key: 'name', label: 'Наименование' },
  { key: 'department', label: 'Отдел' },
  { key: 'fluid', label: 'Среда' },
  { key: 'wbs', label: 'WBS' },
] as const;

/** Как программа прочитала захват — инженеру важно понимать, что она поняла */
const MODE_LABEL: Record<string, string> = {
  table: 'таблица', lines: 'строки с данными', list: 'перечень кодов',
};
const MODE_HINT: Record<string, string> = {
  table: 'Колонки известны из шапки или определены по содержимому',
  lines: 'В каждой строке код и данные при нём — они разложены по полям',
  list: 'Сплошной перечень кодов, данных при них нет',
};

interface UndoSnapshot {
  deleteIds: string[];
  restore: { id: string; brand: string | null; department: string | null;
             fluid: string | null; wbs: string | null; metadata: string | null }[];
}

export default function CaptureReview() {
  const navigate = useNavigate();
  const activeProject = useStore((s) => s.activeProject);
  const { addToast } = useToastStore();

  const [items, setItems] = useState<CaptureItem[] | null>(null);
  const [step, setStep] = useState<'parse' | 'plan' | 'done'>('parse');
  const [rec, setRec] = useState<Recognized | null>(null);
  const [rows, setRows] = useState<CaptureRow[]>([]);
  const [junk, setJunk] = useState<Candidate[]>([]);
  const [dropped, setDropped] = useState<CaptureRow[]>([]);
  const [mapping, setMapping] = useState<Record<number, FieldKey | ''>>({});
  const [plan, setPlan] = useState<PlanRow[]>([]);
  const [lit, setLit] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [undoSnap, setUndoSnap] = useState<UndoSnapshot | null>(null);
  const [junkOpen, setJunkOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const existingRef = useRef<ExistingTag[]>([]);

  // Захват забираем сами: главный процесс кладёт его в ожидание и только
  // подсказывает. Проверяем и при появлении окна — иначе захват, сделанный
  // до того, как рендерер поднялся, пропадал бы молча
  useEffect(() => {
    const api = (window as any).electron?.capture;
    if (!api?.takePending) return;
    let alive = true;
    const take = async () => {
      try {
        const data = await api.takePending();
        if (!alive || !data?.items?.length) return;
        setItems(data.items);
        setStep('parse');
        setPlan([]); setLit(null); setResult(null); setUndoSnap(null);
        setDropped([]); setQuery(''); setJunkOpen(false); setExpanded(new Set());
      } catch {}
    };
    take();
    const off = api.onReady?.(take);
    return () => { alive = false; off?.(); };
  }, []);

  // Разбираем: образец кода снимается с тегов проекта, поэтому их надо прочитать
  useEffect(() => {
    if (!items) return;
    let cancelled = false;
    setLoading(true);
    const pid = activeProject?.id;
    const load = pid ? dataService.getTags(pid) : Promise.resolve(null);
    load
      .then((res: any) => {
        if (cancelled) return;
        const tags: ExistingTag[] = Array.isArray(res) ? res : (res?.tags || []);
        existingRef.current = tags;
        const r = recognize(items, tags.map((t) => t.identifier || ''), tags as any);
        setRec(r); setRows(r.rows); setJunk(r.junk);
        setMapping(r.table?.mapping || {});
      })
      .catch(() => {
        if (cancelled) return;
        existingRef.current = [];
        const r = recognize(items, []);
        setRec(r); setRows(r.rows); setJunk(r.junk); setMapping(r.table?.mapping || {});
      })
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [items, activeProject?.id]);

  const close = () => {
    setItems(null); setRec(null); setRows([]); setPlan([]); setStep('parse');
    setResult(null); setUndoSnap(null);
  };

  // ── Правки разбора ──────────────────────────────────────────────────────
  const editCode = (key: string, value: string) =>
    setRows((rs) => rs.map((r) => (r.key === key
      ? { ...r, identifier: value, verdict: rec && fitsShape(value.trim(), rec.shape) ? 'fits' : 'doubt' }
      : r)));

  const dropRow = (key: string) => {
    const row = rows.find((r) => r.key === key);
    if (row) setDropped((d) => [...d, row]);
    setRows((rs) => rs.filter((r) => r.key !== key));
  };
  const restoreRow = (key: string) => {
    const row = dropped.find((r) => r.key === key);
    if (!row) return;
    setDropped((d) => d.filter((r) => r.key !== key));
    setRows((rs) => [...rs, row]);
  };
  const restoreJunk = (c: Candidate) => {
    setJunk((j) => j.filter((x) => x !== c));
    setRows((rs) => [...rs, {
      key: `j${c.start}`, identifier: c.code, verdict: 'doubt',
      spans: [{ start: c.start, end: c.end }],
    }]);
  };
  const addRow = () =>
    setRows((rs) => [...rs, { key: `m${Date.now()}`, identifier: '', verdict: 'doubt', spans: [] }]);

  const editField = (key: string, field: string, value: string) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, [field]: value } : r)));
  const toggleExpand = (key: string) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });

  // Разметку колонок можно поправить: угадывание шапки ошибается
  const remap = (col: number, field: FieldKey | '') => {
    if (!rec?.table) return;
    const next = { ...mapping, [col]: field };
    setMapping(next);
    const { rows: rebuilt } = buildTableRows(rec.table, rec.shape, next);
    setRows(rebuilt);
  };

  // ── План ────────────────────────────────────────────────────────────────
  const goPlan = () => {
    if (!rec) return;
    const clean = rows.filter((r) => r.identifier.trim());
    const built = buildPlan(clean, existingRef.current, rec.shape);
    // Решения, принятые в этом проекте раньше, применяются сразу:
    // второй похожий захват проходит без вопросов
    const mem = loadDecisions(activeProject?.id);
    setPlan(built.map((r) => {
      const remembered = mem[r.cls];
      return remembered && r.options.includes(remembered)
        ? { ...r, action: remembered, on: remembered !== 'skip' }
        : r;
    }));
    setStep('plan');
  };

  const setRowAction = (key: string, action: Action) =>
    setPlan((p) => p.map((r) => (r.key === key ? { ...r, action, on: action !== 'skip' } : r)));
  const toggleRow = (key: string) =>
    setPlan((p) => p.map((r) => (r.key === key ? { ...r, on: !r.on } : r)));
  const applyToClass = (cls: string, action: Action) =>
    setPlan((p) => p.map((r) => (r.cls === cls && r.options.includes(action)
      ? { ...r, action, on: action !== 'skip' } : r)));
  const setAll = (on: boolean) => setPlan((p) => p.map((r) => ({ ...r, on })));

  const summary = useMemo(() => summarize(plan), [plan]);
  const visiblePlan = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? plan.filter((r) => r.identifier.toLowerCase().includes(q)) : plan;
  }, [plan, query]);

  // ── Применение и отмена ─────────────────────────────────────────────────
  const apply = async () => {
    if (!activeProject?.id) { addToast('Сначала выберите проект', 'error'); return; }
    setBusy(true);
    try {
      const chosen = plan.filter((r) => r.on);
      // Снимок прежних значений — до записи. После неё их уже не восстановить
      const snap: UndoSnapshot = {
        deleteIds: [],
        restore: chosen
          .filter((r) => (r.action === 'fill' || r.action === 'replace') && r.existing)
          .map((r) => ({
            id: r.existing!.id,
            brand: r.existing!.brand ?? null,
            department: r.existing!.department ?? null,
            fluid: r.existing!.fluid ?? null,
            wbs: r.existing!.wbs ?? null,
            metadata: r.existing!.metadata ?? null,
          })),
      };

      const res = await dataService.applyCapturedTags(activeProject.id, chosen.map((r) => ({
        identifier: r.identifier,
        brand: r.row.brand, name: r.row.name, department: r.row.department,
        fluid: r.row.fluid, wbs: r.row.wbs, actuality: r.row.actuality,
        action: r.action, targetId: r.existing?.id,
      })));

      snap.deleteIds = [...res.created.map((t) => t.id), ...res.duplicated.map((t) => t.id)];
      setUndoSnap(snap);
      setResult(res);
      if (remember) saveDecisions(activeProject.id, plan);

      window.dispatchEvent(new CustomEvent('flux:capture-applied', {
        detail: {
          created: (res.created ?? []).map((t) => t.id),
          filled: (res.filled ?? []).map((t) => t.id),
          duplicated: (res.duplicated ?? []).map((t) => t.id),
          at: Date.now(),
        },
      }));
      setStep('done');
    } catch (e: any) {
      addToast(`Не удалось применить: ${e?.message || 'ошибка сервера'}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const undo = async () => {
    if (!undoSnap || !activeProject?.id) return;
    setBusy(true);
    try {
      const r = await dataService.undoCapturedTags(activeProject.id, undoSnap);
      addToast(`Захват отменён: удалено ${r.deleted}, возвращено ${r.restored}`, 'success');
      window.dispatchEvent(new CustomEvent('flux:tags-changed'));
      close();
    } catch (e: any) {
      addToast(`Не удалось отменить: ${e?.message || 'ошибка сервера'}`, 'error');
    } finally { setBusy(false); }
  };

  // ── Клавиатура ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!items) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        if (step === 'parse' && rows.some((r) => r.identifier.trim())) goPlan();
        else if (step === 'plan' && !busy && plan.some((r) => r.on)) apply();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [items, step, rows, plan, busy]);

  // Исходник кусками: подсвеченные фрагменты и текст между ними
  const segments = useMemo(() => {
    if (!rec) return [];
    type Seg = { text: string; key?: string; junk?: boolean };
    const marks: { start: number; end: number; key?: string; junk?: boolean }[] = [];
    for (const r of rows) for (const s of r.spans) marks.push({ ...s, key: r.key });
    for (const j of junk) marks.push({ start: j.start, end: j.end, junk: true });
    marks.sort((a, b) => a.start - b.start);
    const out: Seg[] = [];
    let pos = 0;
    for (const m of marks) {
      if (m.start < pos) continue;
      if (m.start > pos) out.push({ text: rec.raw.slice(pos, m.start) });
      out.push({ text: rec.raw.slice(m.start, m.end), key: m.key, junk: m.junk });
      pos = m.end;
    }
    if (pos < rec.raw.length) out.push({ text: rec.raw.slice(pos) });
    return out;
  }, [rec, rows, junk]);

  if (!items) return null;

  const noProject = !activeProject?.id;
  const fitCount = rows.filter((r) => r.verdict === 'fits').length;
  const confidence = rows.length ? Math.round((fitCount / rows.length) * 100) : 0;
  const dupInside = new Set<string>();
  const seenNorm = new Set<string>();
  for (const r of rows) {
    const n = normCode(r.identifier);
    if (n && seenNorm.has(n)) dupInside.add(r.key);
    seenNorm.add(n);
  }

  return createPortal(
    <AnimatePresence>
      <motion.div
        key="capture"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        className="fixed inset-0 z-[95] bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-6"
      >
        <motion.div
          initial={{ scale: 0.97, y: 8 }} animate={{ scale: 1, y: 0 }}
          className="w-full max-w-5xl max-h-full flex flex-col rounded-lg overflow-hidden
                     bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-2xl"
        >
          <div className="flex items-center gap-3 px-4 py-2.5 border-b border-slate-200 dark:border-slate-800
                          bg-slate-50 dark:bg-slate-800/60">
            <span className="w-3.5 h-3.5 rounded bg-emerald-600" />
            <span className="text-xs font-bold text-slate-600 dark:text-slate-300">
              {step === 'parse' ? 'Разбор захвата' : step === 'plan' ? 'План захвата: теги' : 'Захват применён'}
            </span>
            {items.length > 1 && step === 'parse' && (
              <span className="text-2xs px-2 py-0.5 rounded-full bg-sky-50 text-sky-700
                               dark:bg-sky-950/60 dark:text-sky-300">
                склеено захватов: {items.length}
              </span>
            )}
            <span className="flex-1" />
            <span className="text-2xs text-slate-400 hidden sm:inline">Esc — закрыть · Ctrl+Enter — дальше</span>
            <button onClick={close} title="Закрыть разбор захвата" className="p-1 text-slate-400 hover:text-rose-500 cursor-pointer">
              <X className="w-4 h-4" />
            </button>
          </div>

          {noProject && (
            <div className="flex items-center gap-2 px-4 py-2 bg-amber-50 dark:bg-amber-950/40
                            text-amber-800 dark:text-amber-300 text-xs font-semibold">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              Проект не выбран — записать теги будет некуда. Выберите проект и захватите снова.
            </div>
          )}

          {loading && (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-slate-500">
              <Loader2 className="w-4 h-4 animate-spin" /> Разбираю захват…
            </div>
          )}

          {/* ── Шаг 1: разбор ─────────────────────────────────────────── */}
          {!loading && step === 'parse' && rec && (
            <>
              {rec.mode === 'table' && rec.table && (
                <div className="px-3 py-2 border-b border-slate-100 dark:border-slate-800 flex items-center gap-2 flex-wrap">
                  <span className="text-2xs font-bold text-slate-500">Колонки:</span>
                  {(rec.table.rows[0] || []).map((_, i) => (
                    <select
                      key={i}
                      value={mapping[i] || ''}
                      onChange={(e) => remap(i, e.target.value as FieldKey | '')}
                      className="text-2xs px-1.5 py-1 rounded-md border border-slate-200 dark:border-slate-700
                                 bg-white dark:bg-slate-800 cursor-pointer"
                      title={rec.table!.headerRow >= 0 ? rec.table!.rows[rec.table!.headerRow][i] : `колонка ${i + 1}`}
                    >
                      <option value="">— {i + 1} —</option>
                      {FIELDS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                    </select>
                  ))}
                </div>
              )}

              <div className="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-2">
                <div className="min-w-0 flex flex-col border-r border-slate-200 dark:border-slate-800">
                  <div className="px-3 py-2 border-b border-slate-100 dark:border-slate-800
                                  bg-slate-50 dark:bg-slate-800/40 flex items-center gap-2">
                    <span className="text-xs font-bold">Захват</span>
                    <span className="ml-auto text-2xs font-semibold px-2 py-0.5 rounded-full
                                     bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300"
                          title={MODE_HINT[rec.mode]}>
                      {MODE_LABEL[rec.mode]}
                    </span>
                  </div>
                  <div className="flex-1 overflow-auto p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap
                                  text-slate-600 dark:text-slate-300">
                    {segments.map((s, i) =>
                      s.key || s.junk ? (
                        <span
                          key={i}
                          onMouseEnter={() => s.key && setLit(s.key)}
                          onClick={() => s.key && setLit(s.key)}
                          className={`rounded px-0.5 cursor-pointer ${
                            s.junk
                              ? 'line-through text-slate-400'
                              : lit === s.key
                                ? 'bg-emerald-600 text-white font-bold'
                                : 'text-slate-900 dark:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800'
                          }`}
                        >{s.text}</span>
                      ) : <span key={i}>{s.text}</span>,
                    )}
                  </div>
                  {junk.length > 0 && (
                    <div className="border-t border-slate-100 dark:border-slate-800 px-3 py-2">
                      <button onClick={() => setJunkOpen((v) => !v)}
                              className="text-2xs font-bold text-slate-500 hover:text-emerald-600 cursor-pointer">
                        Отброшено {junk.length} {junkOpen ? '▴' : '▾'}
                      </button>
                      {junkOpen && (
                        <div className="flex flex-wrap gap-1.5 mt-2">
                          {junk.map((c, i) => (
                            <button key={i} onClick={() => restoreJunk(c)} title="Вернуть в разбор"
                                    className="text-2xs font-mono px-2 py-0.5 rounded-full border border-dashed
                                               border-slate-300 dark:border-slate-600 text-slate-500
                                               hover:border-emerald-500 hover:text-emerald-600 cursor-pointer">
                              {c.code} +
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <div className="min-w-0 flex flex-col">
                  <div className="px-3 py-2 border-b border-slate-100 dark:border-slate-800
                                  bg-slate-50 dark:bg-slate-800/40 flex items-center gap-2">
                    <span className="text-xs font-bold">Разобрано: теги</span>
                    <span className="text-2xs font-semibold px-2 py-0.5 rounded-full
                                     bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300">
                      {rows.length}
                    </span>
                    <button onClick={addRow} title="Добавить строку вручную"
                            className="ml-auto p-1 text-slate-400 hover:text-emerald-600 cursor-pointer">
                      <Plus className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <div className="flex-1 overflow-auto p-1.5 space-y-0.5">
                    {rows.map((r) => {
                      const filled = EXTRA.filter((f) => (r as any)[f.key]);
                      const open = expanded.has(r.key);
                      return (
                        <div
                          key={r.key}
                          onMouseEnter={() => setLit(r.key)}
                          className={`rounded-lg border group ${
                            lit === r.key
                              ? 'bg-emerald-50 border-emerald-500 dark:bg-emerald-950/40'
                              : 'border-transparent hover:bg-slate-50 dark:hover:bg-slate-800/60'
                          }`}
                        >
                          <div className="flex items-center gap-2 px-2 py-1">
                            {/* Код правится на месте: разбивка ошибается, и переснимать
                                захват из-за одного знака — издевательство */}
                            <input
                              value={r.identifier}
                              onChange={(e) => editCode(r.key, e.target.value)}
                              placeholder="код тега"
                              className="font-mono text-xs font-bold w-28 shrink-0 bg-transparent outline-none
                                         border-b border-transparent focus:border-emerald-500 py-0.5"
                            />
                            {/* Что разложилось по полям — видно сразу, иначе разбор
                                выглядит так, будто данные из строки потерялись */}
                            <div className="flex-1 min-w-0 flex flex-wrap gap-1 items-center">
                              {filled.map((f) => (
                                <span key={f.key} title={f.label}
                                      className="text-2xs px-1.5 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800
                                                 text-slate-600 dark:text-slate-300 max-w-[11rem] truncate">
                                  {(r as any)[f.key]}
                                </span>
                              ))}
                            </div>
                            {dupInside.has(r.key) && (
                              <span className="text-2xs font-semibold px-1.5 py-0.5 rounded-full shrink-0
                                               bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300">
                                повтор
                              </span>
                            )}
                            {r.spans.length > 1 && (
                              <span className="text-2xs font-semibold px-1.5 py-0.5 rounded-full shrink-0
                                               bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300">
                                {r.spans.length}×
                              </span>
                            )}
                            {r.verdict === 'doubt' && !dupInside.has(r.key) && (
                              <span className="text-2xs text-slate-400 shrink-0">сомнительный</span>
                            )}
                            <button onClick={() => toggleExpand(r.key)} title="Поля тега"
                                    className={`p-0.5 cursor-pointer shrink-0 ${
                                      open ? 'text-emerald-600' : 'text-slate-300 hover:text-emerald-600'}`}>
                              <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
                            </button>
                            <button onClick={() => dropRow(r.key)} title="Убрать"
                                    className="p-0.5 text-slate-300 hover:text-rose-500 cursor-pointer shrink-0
                                               opacity-0 group-hover:opacity-100">
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                          {open && (
                            <div className="grid grid-cols-2 gap-1.5 px-2 pb-2">
                              {EXTRA.map((f) => (
                                <label key={f.key} className="text-2xs text-slate-400">
                                  {f.label}
                                  <input
                                    value={(r as any)[f.key] || ''}
                                    onChange={(e) => editField(r.key, f.key, e.target.value)}
                                    className="w-full text-xs bg-white dark:bg-slate-800 rounded-md px-1.5 py-1
                                               border border-slate-200 dark:border-slate-700 outline-none
                                               focus:border-emerald-500 text-slate-800 dark:text-slate-100"
                                  />
                                </label>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                    {!rows.length && (
                      <div className="text-center text-xs text-slate-400 py-10 px-4">
                        Кодов не нашлось. Добавьте строку вручную или закройте и выделите иначе.
                      </div>
                    )}
                    {dropped.length > 0 && (
                      <div className="pt-2 mt-2 border-t border-slate-100 dark:border-slate-800">
                        <div className="text-2xs text-slate-400 px-2 mb-1">Убрано вручную:</div>
                        <div className="flex flex-wrap gap-1.5 px-2">
                          {dropped.map((r) => (
                            <button key={r.key} onClick={() => restoreRow(r.key)} title="Вернуть"
                                    className="text-2xs font-mono px-2 py-0.5 rounded-full border border-dashed
                                               border-slate-300 dark:border-slate-600 text-slate-500
                                               hover:border-emerald-500 hover:text-emerald-600 cursor-pointer">
                              {r.identifier || '—'} +
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2 flex-wrap px-3 py-2.5 border-t border-slate-200 dark:border-slate-800
                              bg-slate-50 dark:bg-slate-800/60">
                <span className="text-2xs text-slate-500">Это:</span>
                <span className="text-2xs font-bold px-2.5 py-1 rounded-md bg-emerald-600 text-white">Теги</span>
                <span className="text-2xs font-semibold px-2.5 py-1 rounded-md border border-slate-200
                                 dark:border-slate-700 text-slate-400" title="Следующим этапом">
                  Данные оборудования
                </span>
                {rows.length > 0 && (
                  <span className="text-2xs font-semibold px-2 py-0.5 rounded-full
                                   bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300"
                        title={rec.shape.fromCount
                          ? `образец снят с ${rec.shape.fromCount} тегов проекта`
                          : 'в проекте нет тегов — образец общий'}>
                    по образцу проекта {confidence}%
                  </span>
                )}
                <span className="flex-1" />
                {rec.collapsed > 0 && (
                  <span className="text-2xs px-2 py-0.5 rounded-full bg-amber-50 text-amber-700
                                   dark:bg-amber-950/60 dark:text-amber-300">
                    Свёрнуто дублей {rec.collapsed}
                  </span>
                )}
                <button
                  onClick={goPlan}
                  disabled={!rows.some((r) => r.identifier.trim())}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700
                             disabled:opacity-40 text-white text-xs font-bold cursor-pointer"
                >
                  Далее <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </>
          )}

          {/* ── Шаг 2: план ───────────────────────────────────────────── */}
          {!loading && step === 'plan' && (
            <>
              <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-100 dark:border-slate-800">
                <button onClick={() => setAll(true)}
                        className="text-2xs font-bold px-2 py-1 rounded-md border border-slate-200
                                   dark:border-slate-700 hover:border-emerald-500 cursor-pointer">
                  Отметить все
                </button>
                <button onClick={() => setAll(false)}
                        className="text-2xs font-bold px-2 py-1 rounded-md border border-slate-200
                                   dark:border-slate-700 hover:border-emerald-500 cursor-pointer">
                  Снять все
                </button>
                {plan.length > 10 && (
                  <div className="ml-auto relative">
                    <Search className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
                    <input
                      value={query} onChange={(e) => setQuery(e.target.value)}
                      placeholder="поиск по коду"
                      className="text-2xs pl-7 pr-2 py-1 rounded-md border border-slate-200 dark:border-slate-700
                                 bg-white dark:bg-slate-800 outline-none focus:border-emerald-500 w-44"
                    />
                  </div>
                )}
              </div>

              <div className="flex-1 min-h-0 overflow-auto">
                <table className="w-full border-collapse">
                  <thead className="sticky top-0 z-10">
                    <tr className="bg-slate-50 dark:bg-slate-800">
                      {['', 'Код', 'Класс', 'Что делаем', 'Почему', ''].map((h, i) => (
                        <th key={i} className="text-left text-2xs font-bold text-slate-400
                                               px-3 py-2 border-b border-slate-200 dark:border-slate-700">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {visiblePlan.map((r) => (
                      <tr key={r.key} className="border-b border-slate-100 dark:border-slate-800/70 group">
                        <td className="px-3 py-1.5">
                          <button
                            onClick={() => toggleRow(r.key)}
                            className={`w-4 h-4 rounded grid place-items-center border cursor-pointer ${
                              r.on ? 'bg-emerald-600 border-emerald-600 text-white'
                                   : 'border-slate-300 dark:border-slate-600'}`}
                          >{r.on && <Check className="w-2.5 h-2.5" />}</button>
                        </td>
                        <td className="px-3 py-1.5 font-mono text-xs font-bold whitespace-nowrap">
                          {r.identifier}
                          {/* Для расхождения полей показываем, что именно разойдётся */}
                          {r.diffs.length > 0 && (
                            <div className="font-sans text-2xs font-normal text-slate-400 mt-0.5">
                              {r.diffs.map((d) => `${d.mine} → ${d.theirs}`).join(', ')}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-1.5">
                          <span className={`text-2xs font-semibold px-2 py-0.5 rounded-full whitespace-nowrap
                                            ${TONE_BADGE[CLASS_TONE[r.cls]]}`}>
                            {CLASS_LABEL[r.cls]}
                          </span>
                        </td>
                        <td className="px-3 py-1.5 whitespace-nowrap">
                          <select
                            value={r.action}
                            onChange={(e) => setRowAction(r.key, e.target.value as Action)}
                            className="text-2xs font-semibold px-2 py-1 rounded-md border border-slate-200
                                       dark:border-slate-700 bg-white dark:bg-slate-800 cursor-pointer"
                          >
                            {r.options.map((o) => <option key={o} value={o}>{ACTION_LABEL[o]}</option>)}
                          </select>
                          {plan.filter((x) => x.cls === r.cls).length > 1 && (
                            <button
                              onClick={() => applyToClass(r.cls, r.action)}
                              title={`Применить ко всем строкам класса «${CLASS_LABEL[r.cls]}»`}
                              className="ml-1.5 text-2xs font-bold text-slate-400 hover:text-emerald-600
                                         cursor-pointer opacity-0 group-hover:opacity-100"
                            >
                              ко всем
                            </button>
                          )}
                        </td>
                        <td className="px-3 py-1.5 text-2xs text-slate-500 dark:text-slate-400">{r.why}</td>
                        <td className="px-3 py-1.5">
                          <button onClick={() => setPlan((p) => p.filter((x) => x.key !== r.key))}
                                  title="Убрать из плана"
                                  className="p-1 text-slate-300 hover:text-rose-500 cursor-pointer
                                             opacity-0 group-hover:opacity-100">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex items-center gap-2 flex-wrap px-3 py-2.5 border-t border-slate-200 dark:border-slate-800
                              bg-slate-50 dark:bg-slate-800/60">
                <button onClick={() => setStep('parse')}
                        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200
                                   dark:border-slate-700 text-xs font-bold cursor-pointer">
                  <ArrowLeft className="w-3.5 h-3.5" /> Назад
                </button>
                <label className="inline-flex items-center gap-1.5 text-2xs font-semibold cursor-pointer select-none"
                       title="Второй похожий захват пройдёт без вопросов">
                  <span onClick={() => setRemember((v) => !v)}
                        className={`w-3.5 h-3.5 rounded grid place-items-center border ${
                          remember ? 'bg-emerald-600 border-emerald-600 text-white'
                                   : 'border-slate-300 dark:border-slate-600'}`}>
                    {remember && <Check className="w-2 h-2" />}
                  </span>
                  Запомнить решения
                </label>
                <span className="inline-flex items-center gap-1 text-2xs font-bold text-emerald-700 dark:text-emerald-400">
                  <ShieldCheck className="w-3 h-3" /> удалений: 0
                </span>
                <span className="flex-1" />
                {([['create', 'создать', 'ok'], ['fill', 'дополнить', 'warn'], ['link', 'привязать', 'warn'],
                   ['replace', 'заменить', 'bad'], ['duplicate', 'дубль', 'bad'], ['skip', 'пропустить', 'mute']] as const)
                  .filter(([k]) => (summary as any)[k] > 0)
                  .map(([k, label, tone]) => (
                    <span key={k} className={`text-2xs font-semibold px-2 py-0.5 rounded-full ${TONE_BADGE[tone]}`}>
                      {label} {(summary as any)[k]}
                    </span>
                  ))}
                <button
                  onClick={apply}
                  disabled={busy || noProject || !plan.some((r) => r.on)}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700
                             disabled:opacity-40 text-white text-xs font-bold cursor-pointer"
                >
                  {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                  Применить
                </button>
              </div>
            </>
          )}

          {/* ── Шаг 3: отчёт ──────────────────────────────────────────── */}
          {step === 'done' && result && (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-px bg-slate-200 dark:bg-slate-800">
                {/* Счётчики через ?? []: неполный ответ сервера не должен ронять отчёт */}
                {([['создано', (result.created ?? []).length, 'text-emerald-600'],
                   ['дополнено', (result.filled ?? []).length, 'text-amber-600'],
                   ['привязано', (result.linked ?? []).length, 'text-sky-600'],
                   ['дублей', (result.duplicated ?? []).length, 'text-rose-600'],
                   ['пропущено', (result.skipped ?? []).length, 'text-slate-400']] as const).map(([l, v, c]) => (
                  <div key={l} className="bg-white dark:bg-slate-900 px-4 py-3">
                    <div className={`text-2xl font-mono font-extrabold tabular-nums ${c}`}>{v}</div>
                    <div className="text-2xs text-slate-400 mt-0.5">{l}</div>
                  </div>
                ))}
              </div>
              <div className="flex-1 min-h-0 overflow-auto px-4 py-3">
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  Источник: <b>Захват с экрана</b>
                  {rec?.mode === 'table' ? ' · таблица' : ' · текст'} · {new Date().toLocaleString('ru')}
                </div>
                {(result.skipped ?? []).length > 0 && (
                  <div className="mt-3">
                    <div className="text-2xs font-bold text-slate-400 mb-1">Пропущено</div>
                    <div className="flex flex-wrap gap-1.5">
                      {(result.skipped ?? []).map((c: string, i: number) => (
                        <span key={i} className="text-2xs font-mono px-2 py-0.5 rounded-full
                                                 bg-slate-100 dark:bg-slate-800 text-slate-500">{c}</span>
                      ))}
                    </div>
                  </div>
                )}
                <div className="mt-4 text-2xs text-slate-400">
                  Отмена доступна, пока открыт этот отчёт: она удалит созданное и вернёт
                  дополненным прежние значения.
                </div>
              </div>
              <div className="flex items-center gap-2 px-3 py-2.5 border-t border-slate-200 dark:border-slate-800
                              bg-slate-50 dark:bg-slate-800/60">
                <button onClick={undo} disabled={busy || !undoSnap}
                        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200
                                   dark:border-slate-700 text-xs font-bold hover:border-rose-400
                                   hover:text-rose-600 disabled:opacity-40 cursor-pointer">
                  {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Undo2 className="w-3.5 h-3.5" />}
                  Отменить захват
                </button>
                <button onClick={() => { setStep('parse'); setResult(null); }}
                        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200
                                   dark:border-slate-700 text-xs font-bold cursor-pointer">
                  <RotateCcw className="w-3.5 h-3.5" /> К разбору
                </button>
                <span className="flex-1" />
                <button onClick={() => { close(); navigate('/registry'); }}
                        className="px-3.5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white
                                   text-xs font-bold cursor-pointer">
                  Показать в Реестре
                </button>
              </div>
            </>
          )}
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body,
  );
}
