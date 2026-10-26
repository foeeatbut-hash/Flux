/**
 * Перевести выделенное — где угодно в программе.
 *
 * Строка ведомости, название файла, абзац в письме, ячейка реестра: выделили,
 * нажали Alt+T — перевод появился рядом с текстом. Ради одной строки не нужно
 * открывать программу-переводчик, копировать и возвращаться.
 *
 * Сочетание взято не Ctrl+Shift+T: в браузере оно занято под «вернуть закрытую
 * вкладку» и до страницы не доходит вовсе. Alt+T свободен и там, и в сборке для
 * Windows. Клавиша считывается по коду, а не по букве, — при русской раскладке
 * сочетание работает так же.
 */
import React from 'react';
import { motion } from 'motion/react';
import { TRANSITION } from '../../lib/motion';
import { Languages, Copy, BookMarked, Maximize2, X } from 'lucide-react';
import { useTranslateStore } from '../../store/translateStore';
import { useToastStore } from '../../store/toastStore';
import { useWindowStore } from '../../store/windowStore';
import { useEscape } from '../../lib/useEscape';
import { detectLang, worthTranslating } from '../../translate/lang';
import { joinSegments } from '../../translate/engine';
import { LANG_NAME, ORIGIN_LABEL, type Lang, type Segment } from '../../translate/types';

interface Shown {
  src: string;
  dst: string;
  from: Lang;
  to: Lang;
  origin: Segment['origin'];
  /** Сколько слов не нашлось в словаре */
  missing: number;
  x: number;
  y: number;
}

const WIDTH = 340;

export default function QuickTranslate() {
  const { addToast } = useToastStore();
  const many = useTranslateStore((s) => s.many);
  const saveTerm = useTranslateStore((s) => s.saveTerm);
  const setPending = useTranslateStore((s) => s.setPending);
  const [shown, setShown] = React.useState<Shown | null>(null);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.code !== 'KeyT') return;
      e.preventDefault();
      const sel = window.getSelection();
      const text = (sel?.toString() || '').trim();
      if (!text) { addToast('Выделите текст, который нужно перевести', 'error'); return; }
      if (!worthTranslating(text)) { addToast('В выделенном нечего переводить', 'error'); return; }
      const from = detectLang(text);
      if (from === 'und') { addToast('Не понял, на каком языке текст', 'error'); return; }
      const to: Lang = from === 'ru' ? 'en' : 'ru';
      const segs = many(text, from, to);
      const dst = joinSegments(segs).trim();
      if (!dst || dst === text) { addToast('Перевода не нашлось — пополните словарь в Переводчике', 'error'); return; }

      // Ставим окошко под выделением, не выпуская за край экрана
      let x = window.innerWidth / 2 - WIDTH / 2;
      let y = window.innerHeight / 2;
      try {
        const rect = sel!.getRangeAt(0).getBoundingClientRect();
        if (rect.width || rect.height) {
          x = Math.min(Math.max(8, rect.left), window.innerWidth - WIDTH - 8);
          y = Math.min(rect.bottom + 8, window.innerHeight - 160);
        }
      } catch (_) { /* выделение уже снято — покажем по центру */ }

      const worst = segs.filter((s) => s.origin !== 'kept');
      setShown({
        src: text, dst, from, to, x, y,
        origin: worst.some((s) => s.origin === 'glossary' || s.origin === 'none') ? 'glossary' : (worst[0]?.origin || 'kept'),
        // Сколько слов словарь не узнал. Число важнее слова «подстрочник»: по
        // нему сразу видно, читать перевод целиком или только сверить термин
        missing: worst.reduce((n, s) => n + (s.missing?.length || 0), 0),
      });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [many, addToast]);

  // Esc ловим на перехвате, а нажатие мышью — на всём документе: окошко висит
  // поверх чужого окна, и закрываться оно должно раньше, чем это окно решит,
  // что Esc адресован ему
  useEscape(!!shown, () => setShown(null));
  React.useEffect(() => {
    if (!shown) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement)?.closest?.('[data-quick-translate]')) setShown(null);
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [shown]);

  if (!shown) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shown.dst);
      addToast('Перевод скопирован', 'success');
      setShown(null);
    } catch (_) { addToast('Буфер обмена недоступен', 'error'); }
  };

  const toGlossary = async () => {
    const ru = shown.from === 'ru' ? shown.src : shown.dst;
    const en = shown.from === 'ru' ? shown.dst : shown.src;
    if (shown.from === 'zh') { addToast('В глоссарий кладём пары русский — английский', 'error'); return; }
    const saved = await saveTerm({ ru, en });
    addToast(saved ? 'Пара добавлена в словарь проекта' : 'Не удалось добавить в словарь', saved ? 'success' : 'error');
    setShown(null);
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={TRANSITION.enter}
      data-quick-translate
      style={{ left: shown.x, top: shown.y, width: WIDTH }}
      className="fixed z-[9500] rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-2xl overflow-hidden"
    >
      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-slate-100 dark:border-slate-850">
        <Languages className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
        <span className="flex-1 min-w-0 text-2xs font-semibold text-slate-500 dark:text-slate-400">
          {LANG_NAME[shown.from]} → {LANG_NAME[shown.to]} · {ORIGIN_LABEL[shown.origin]}
          {shown.missing > 0 && ` · не нашлось слов: ${shown.missing}`}
        </span>
        <button type="button" onClick={() => setShown(null)} aria-label="Закрыть"
          className="p-0.5 rounded text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-850 cursor-pointer">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <p className="px-3 py-2 text-xs text-slate-800 dark:text-slate-150 max-h-40 overflow-auto scrollbar-thin whitespace-pre-wrap">
        {shown.dst}
      </p>

      <div className="flex items-center gap-1 px-2 pb-2">
        <button type="button" onClick={copy}
          className="flex items-center gap-1 px-2 py-1 rounded-md text-2xs font-semibold text-emerald-700
                     dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950/40 cursor-pointer">
          <Copy className="w-3 h-3" /> Копировать
        </button>
        <button type="button" onClick={toGlossary}
          className="flex items-center gap-1 px-2 py-1 rounded-md text-2xs font-semibold text-slate-500
                     dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-850 cursor-pointer">
          <BookMarked className="w-3 h-3" /> В словарь
        </button>
        <span className="flex-1" />
        <button type="button" title="Открыть в Переводчике"
          onClick={() => { setPending(shown.src); useWindowStore.getState().open('/translate'); setShown(null); }}
          className="flex items-center gap-1 px-2 py-1 rounded-md text-2xs font-semibold text-slate-500
                     dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-850 cursor-pointer">
          <Maximize2 className="w-3 h-3" /> Окном
        </button>
      </div>
    </motion.div>
  );
}
