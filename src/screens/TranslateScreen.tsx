/**
 * Переводчик программой.
 *
 * Отдельное окно нужно ровно затем же, зачем оно нужно помощнику: перевод идёт
 * рядом с работой, а не вместо неё. Ведомость слева, перевод справа, и ни одно
 * не закрывает другое.
 *
 * Три занятия под одной лентой: перевести текст, поправить словарь, посмотреть
 * память. Разделять их на три раздела было бы неправдой — это одно дело,
 * рассмотренное с трёх сторон, и человек ходит между ними по десять раз за
 * документ.
 */
import React from 'react';
import { useRibbonFold } from '../components/ribbon/useRibbonFold';
import { Languages } from 'lucide-react';
import RibbonBar from '../components/ribbon/RibbonBar';
import SegmentRows, { type Row } from '../components/translate/SegmentRows';
import TermTable from '../components/translate/TermTable';
import MemoryTable from '../components/translate/MemoryTable';
import { translateRibbon } from '../lib/ribbonTranslate';
import { useTranslateStore } from '../store/translateStore';
import { useToastStore } from '../store/toastStore';
import { useStore } from '../store/store';
import { useWindowStore } from '../store/windowStore';
import { useWindowTitle } from '../lib/paneTitle';
import { detectLang } from '../translate/lang';
import { LANG_NAME, type Lang } from '../translate/types';
import { readiness } from '../translate/engine';

type Mode = 'text' | 'terms' | 'memory';

const MODES: { id: Mode; label: string }[] = [
  { id: 'text', label: 'Текст' },
  { id: 'terms', label: 'Глоссарий' },
  { id: 'memory', label: 'Память' },
];

export default function TranslateScreen() {
  const { activeProject } = useStore();
  const { addToast } = useToastStore();
  const store = useTranslateStore();

  const [mode, setMode] = React.useState<Mode>('text');
  const [from, setFrom] = React.useState<string>('auto');
  const [to, setTo] = React.useState<Lang>('en');
  const [src, setSrc] = React.useState('');
  const [rows, setRows] = React.useState<Row[]>([]);
  const [side, setSide] = React.useState(true);
  const [showOrigin, setShowOrigin] = React.useState(true);
  const [tab, setTab] = React.useState('Главная');
  // Свёрнутая лента помнится между документами и программами семьи
  const [folded, setFolded] = useRibbonFold();
  const [adding, setAdding] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => { if (activeProject?.id) store.load(activeProject.id); }, [activeProject?.id]);

  // Текст, присланный строкой Ctrl+K или окошком над выделением. Забираем его
  // и переводим сразу: человек уже сказал, чего хочет, — спрашивать второй раз
  // нажатием «Перевести» незачем
  const pending = useTranslateStore((s) => s.pending);
  React.useEffect(() => {
    if (!pending) return;
    // Текст берём из самого значения, а не вторым обращением к хранилищу:
    // в строгом режиме React прогоняет эффект дважды, и второй проход получил
    // бы уже опустошённое поле — окно открывалось пустым
    const text = pending;
    store.setPending('');
    setMode('text');
    setSrc(text);
    setRows([]);
    const lang = detectLang(text);
    if (lang !== 'und') {
      const to: Lang = lang === 'ru' ? 'en' : 'ru';
      setFrom('auto');
      setTo(to);
      setRows(store.many(text, lang, to).map((s) => ({ ...s })));
    }
  }, [pending]);

  // Язык исходника определяем сами, но выбор человека главнее: он видит текст
  const guessed: Lang = React.useMemo(() => (from === 'auto' ? detectLang(src) : (from as Lang)), [from, src]);
  // Переводить на тот же язык бессмысленно: если выбрано одно и то же,
  // разворачиваем — человек почти наверняка просто не сменил второй список
  const target: Lang = to === guessed ? (guessed === 'ru' ? 'en' : 'ru') : to;

  useWindowTitle(src.trim() ? `Переводчик · ${src.trim().slice(0, 32)}` : 'Переводчик');

  const run = React.useCallback(() => {
    if (!src.trim()) { addToast('Нечего переводить', 'error'); return; }
    if (guessed === 'und') { addToast('Не понял, на каком языке текст — выберите язык слева', 'error'); return; }
    if (guessed === target) { addToast(`Текст и так на ${LANG_NAME[target]}`, 'error'); return; }
    const segs = store.many(src, guessed, target);
    setRows(segs.map((s) => ({ ...s })));
    const r = readiness(segs);
    if (r.total && !r.ready) {
      addToast('Перевод сложен по словарю — прочитайте строки перед отправкой', 'info');
    }
  }, [src, guessed, target, store, addToast]);

  const setRow = (i: number, dst: string) => {
    setRows((list) => list.map((r, n) => (n === i ? { ...r, dst, ok: true } : r)));
  };
  const confirmRow = (i: number) => {
    setRows((list) => list.map((r, n) => (n === i ? { ...r, ok: !r.ok } : r)));
  };

  const remember = async () => {
    const units = rows
      .filter((r) => r.ok && r.src.trim() && r.dst.trim())
      .map((r) => ({ src: r.src.trim(), dst: r.dst.trim(), from: guessed, to: target }));
    if (!units.length) { addToast('Подтвердите строки, которые стоит запомнить', 'error'); return; }
    const n = await store.remember(units);
    addToast(n ? `В память легло строк: ${n}` : 'Ничего нового — эти строки уже там', n ? 'success' : 'info');
  };

  const translated = React.useMemo(() => rows.map((r) => (r.dst || r.src)).join(''), [rows]);

  const copy = async () => {
    if (!translated.trim()) { addToast('Перевода ещё нет', 'error'); return; }
    try {
      await navigator.clipboard.writeText(translated);
      addToast('Перевод скопирован', 'success');
    } catch (_) { addToast('Буфер обмена недоступен', 'error'); }
  };

  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) { addToast('В буфере пусто', 'error'); return; }
      setSrc(text);
      setMode('text');
    } catch (_) { addToast('Буфер обмена недоступен — вставьте сочетанием Ctrl+V', 'error'); }
  };

  const swap = () => {
    // Меняем не только языки, но и текст местами: чаще всего человек хочет
    // проверить обратный перевод того, что только что получил
    const back = guessed === 'ru' ? (to as Lang) : 'ru';
    setFrom(target);
    setTo(back === 'zh' ? 'ru' : back);
    if (translated.trim()) setSrc(translated);
    setRows([]);
  };

  const tmxOut = async () => {
    try {
      const res = await fetch(`/api/translate/tmx?projectId=${encodeURIComponent(activeProject?.id || '')}&from=ru&to=en`);
      if (!res.ok) throw new Error('нет ответа');
      const xml = await res.text();
      const url = URL.createObjectURL(new Blob([xml], { type: 'application/xml' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'Память переводов.tmx';
      a.click();
      URL.revokeObjectURL(url);
      addToast('Память выгружена файлом TMX', 'success');
    } catch (_) { addToast('Не удалось выгрузить память', 'error'); }
  };

  const tmxIn = async (file: File) => {
    try {
      const text = await file.text();
      const res = await fetch('/api/translate/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: activeProject?.id, text, from: 'ru', to: 'en' }),
      });
      if (!res.ok) throw new Error('отказ');
      const data = await res.json();
      await store.load(activeProject?.id || '', true);
      addToast(
        `Из файла взято строк: ${data.added}${data.skipped ? `, своих не тронуто: ${data.skipped}` : ''}`,
        'success',
      );
    } catch (_) { addToast('Файл не разобрался: нужен TMX или две колонки через табуляцию', 'error'); }
  };

  const seed = async () => {
    const r = await store.seed();
    addToast(
      r.added ? `Из данных проекта собрано терминов: ${r.added}` : 'Новых пар в данных проекта не нашлось',
      r.added ? 'success' : 'info',
    );
    setMode('terms');
  };

  const command = (id: string, value?: string) => {
    switch (id) {
      case 'tr.from': setFrom(value || 'auto'); setRows([]); break;
      case 'tr.to': setTo((value as Lang) || 'en'); setRows([]); break;
      case 'tr.swap': swap(); break;
      case 'tr.run': setMode('text'); run(); break;
      case 'tr.copy': copy(); break;
      case 'tr.clear': setSrc(''); setRows([]); break;
      case 'tr.paste': paste(); break;
      case 'tr.remember': remember(); break;
      case 'tr.confirmAll': setRows((list) => list.map((r) => ({ ...r, ok: r.origin !== 'kept' }))); break;
      case 'tr.terms': setMode('terms'); break;
      case 'tr.termAdd': setMode('terms'); setAdding(true); break;
      case 'tr.memory': setMode('memory'); break;
      case 'tr.tmxOut': tmxOut(); break;
      case 'tr.tmxIn': fileRef.current?.click(); break;
      case 'tr.seed': seed(); break;
      case 'tr.vdrFill':
        useWindowStore.getState().open('/management');
        addToast('Реестр документации: кнопка «Английские названия» заполнит пустые', 'info');
        break;
      case 'tr.side': setSide((v) => !v); break;
      case 'tr.origin': setShowOrigin((v) => !v); break;
      case 'tr.model': useWindowStore.getState().open('/settings'); break;
      default: break;
    }
  };

  const tabs = React.useMemo(() => translateRibbon({ model: store.model.enabled }), [store.model.enabled]);
  const state: Record<string, boolean | string> = {
    'tr.from': from, 'tr.to': to, 'tr.side': side, 'tr.origin': showOrigin,
  };
  const disabled: Record<string, string> = {};
  if (!src.trim()) disabled['tr.run'] = 'Сначала вставьте текст';
  if (!rows.length) {
    disabled['tr.copy'] = 'Перевода ещё нет';
    disabled['tr.remember'] = 'Перевода ещё нет';
    disabled['tr.confirmAll'] = 'Перевода ещё нет';
  }

  const ready = readiness(rows);

  return (
    <div className="h-full flex flex-col bg-white dark:bg-slate-950">
      <div className="shrink-0 flex items-center gap-2 px-3 h-10 border-b border-slate-200 dark:border-slate-800">
        <Languages className="w-4 h-4 text-emerald-700 dark:text-emerald-400 shrink-0" />
        <span className="text-xs font-bold text-slate-800 dark:text-slate-150">Переводчик</span>
        <span className="flex items-center gap-1 ml-2">
          {MODES.map((m) => (
            <button key={m.id} type="button" onClick={() => setMode(m.id)}
              className={`px-2 py-1 rounded-md text-2xs font-semibold cursor-pointer ${mode === m.id
                ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400'
                : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-850'}`}>
              {m.label}
            </button>
          ))}
        </span>
        <span className="flex-1" />
        <span className="text-2xs text-slate-400 dark:text-slate-500 truncate hidden @[620px]:inline">
          работает без сети: память проекта, словарь и узоры писем
        </span>
      </div>

      <RibbonBar tabs={tabs} active={tab} onActive={setTab} state={state} disabled={disabled}
        onCommand={command} folded={folded} onFold={setFolded} />

      <div className="flex-1 min-h-0">
        {mode === 'terms' && <TermTable adding={adding} onAdded={() => setAdding(false)} />}
        {mode === 'memory' && <MemoryTable />}
        {mode === 'text' && (
          <div className="h-full min-h-0 grid grid-cols-1 @[720px]:grid-cols-2">
            <div className="min-h-0 flex flex-col border-b @[720px]:border-b-0 @[720px]:border-r
                            border-slate-200 dark:border-slate-800">
              <div className="shrink-0 px-3 py-1.5 text-[10px] uppercase tracking-wide text-slate-400 dark:text-slate-500">
                Исходник {guessed !== 'und' && `· ${LANG_NAME[guessed]}`}
              </div>
              <textarea value={src} onChange={(e) => setSrc(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); run(); } }}
                placeholder="Вставьте письмо, название документа или строку ведомости"
                className="flex-1 min-h-0 w-full resize-none bg-transparent px-3 pb-3 text-xs
                           text-slate-800 dark:text-slate-150 outline-none scrollbar-thin" />
            </div>
            <div className="min-h-0 flex flex-col">
              <div className="shrink-0 px-3 py-1.5 flex items-center gap-2 text-[10px] uppercase tracking-wide
                              text-slate-400 dark:text-slate-500">
                Перевод · {LANG_NAME[target]}
                {ready.total > 0 && (
                  <span className={ready.ready === ready.total ? 'text-emerald-600 dark:text-emerald-400' : ''}>
                    · из памяти {ready.ready} из {ready.total}
                  </span>
                )}
              </div>
              <div className="flex-1 min-h-0">
                <SegmentRows rows={rows} side={side && !!rows.length} showOrigin={showOrigin}
                  onChange={setRow} onConfirm={confirmRow} />
              </div>
            </div>
          </div>
        )}
      </div>

      <input ref={fileRef} type="file" accept=".tmx,.txt,.tsv,.xml" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) tmxIn(f); e.target.value = ''; }} />
    </div>
  );
}
