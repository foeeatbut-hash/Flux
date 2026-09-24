/**
 * Перевод письма прямо в письме.
 *
 * Раньше письмо на английском копировали в браузер, а китайское — туда же и с
 * опаской. Полоса появляется сама, когда язык письма не русский, и даёт три
 * ответа: оставить как есть, показать перевод в том же оформлении, показать
 * рядом. Выбор «всегда для этого отправителя» запоминается: если поставщик
 * пишет только по-английски, спрашивать об этом каждый раз незачем.
 *
 * Отдельно — разбор карточкой. Перевод отвечает «что здесь написано», а
 * человеку с сорока письмами в день нужно «что от меня хотят и к какому сроку».
 * Для китайского письма это и вовсе единственный честный итог: подстрочник по
 * словарю читается плохо, а «просят ревизию B к 12 сентября» понятно и по нему.
 */
import React from 'react';
import { Languages, Columns2, FileText, CalendarClock, CircleHelp } from 'lucide-react';
import { LANG_ON, type Lang } from '../../translate/types';
import { digestOf, dueLabel, type Digest } from '../../translate/mailDigest';

export type LetterView = 'orig' | 'ru' | 'both';

const PREF_KEY = 'flux_mail_translate';

/** Отправители, письма которых переводим сразу. Личный выбор — в браузере */
function prefs(): Record<string, boolean> {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(PREF_KEY);
    const p = raw ? JSON.parse(raw) : null;
    return p && typeof p === 'object' ? p : {};
  } catch (_) { return {}; }
}

export function alwaysFor(addr: string): boolean {
  return Boolean(prefs()[String(addr || '').toLowerCase()]);
}

export function setAlwaysFor(addr: string, on: boolean): void {
  const key = String(addr || '').toLowerCase();
  if (!key) return;
  const next = { ...prefs() };
  if (on) next[key] = true; else delete next[key];
  try { localStorage.setItem(PREF_KEY, JSON.stringify(next)); } catch (_) { /* приватный режим */ }
}

/**
 * Письмо в рамке со своей высотой.
 *
 * Высоту iframe не имеет, поэтому её спрашивают у самого документа. Раньше это
 * жило в письме одним экземпляром; теперь рамок бывает две — оригинал и
 * перевод рядом, — и каждая меряет себя сама.
 */
export function LetterFrame({ srcDoc, title }: { srcDoc: string; title: string }) {
  const ref = React.useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = React.useState(120);
  const measure = () => {
    try {
      const doc = ref.current?.contentDocument;
      if (!doc?.body) return;
      const h = Math.max(doc.body.scrollHeight, doc.documentElement?.scrollHeight || 0);
      if (h > 0) setHeight(Math.min(h + 8, 20000));
    } catch (_) { /* песочница не пустила — оставляем прежнюю высоту */ }
  };
  return (
    <iframe
      ref={ref}
      title={title}
      srcDoc={srcDoc}
      onLoad={measure}
      // Песочница без allow-scripts и без allow-same-origin: выполнить в ней
      // нечего, и до наших данных из неё не дотянуться
      sandbox=""
      referrerPolicy="no-referrer"
      className="w-full block border-0 bg-white dark:bg-slate-950"
      style={{ height }}
    />
  );
}

export function TranslateBar({
  lang, view, onView, addr, always, onAlways, digestOpen, onDigest,
}: {
  lang: Lang;
  view: LetterView;
  onView: (v: LetterView) => void;
  addr: string;
  always: boolean;
  onAlways: (v: boolean) => void;
  digestOpen: boolean;
  onDigest: () => void;
}) {
  const chip = (on: boolean) => `px-2 py-1 rounded-md text-2xs font-semibold cursor-pointer ${on
    ? 'bg-emerald-600 text-white'
    : 'text-emerald-700 dark:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-950/60'}`;

  return (
    <div className="m-3 flex flex-wrap items-center gap-2 rounded-lg border border-emerald-200 dark:border-emerald-900
                    bg-emerald-50 dark:bg-emerald-950/30 px-3 py-2">
      <Languages className="w-4 h-4 shrink-0 text-emerald-700 dark:text-emerald-400" />
      <p className="flex-1 min-w-[10rem] text-xs text-emerald-800 dark:text-emerald-300">
        Письмо на {LANG_ON[lang]}.
        {lang === 'zh' && ' Китайский разбирается по словарю — смысл проверьте.'}
      </p>
      <span className="flex items-center gap-1">
        <button type="button" className={chip(view === 'orig')} onClick={() => onView('orig')}>Оригинал</button>
        <button type="button" className={chip(view === 'ru')} onClick={() => onView('ru')}>Перевод</button>
        <button type="button" className={chip(view === 'both')} onClick={() => onView('both')}>
          <Columns2 className="w-3 h-3 inline -mt-0.5 mr-0.5" />
          Рядом
        </button>
      </span>
      <button type="button" onClick={onDigest}
        className={`px-2 py-1 rounded-md text-2xs font-semibold cursor-pointer ${digestOpen
          ? 'bg-emerald-600 text-white'
          : 'text-emerald-700 dark:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-950/60'}`}>
        <CircleHelp className="w-3 h-3 inline -mt-0.5 mr-0.5" />
        Что просят
      </button>
      {addr && (
        <label className="flex items-center gap-1.5 text-2xs text-emerald-800 dark:text-emerald-300 cursor-pointer">
          <input type="checkbox" checked={always} onChange={(e) => onAlways(e.target.checked)}
            className="accent-emerald-600 cursor-pointer" />
          всегда для этого отправителя
        </label>
      )}
    </div>
  );
}

/**
 * Карточка разбора. Просьбы показываются переводом — перевод делает вызывающий
 * (у него словарь проекта), сюда приходят уже готовые пары.
 */
export function DigestCard({ digest, asks, now = new Date() }: {
  digest: Digest;
  /** Просьбы парами: как в письме и как по-русски */
  asks: { src: string; ru: string }[];
  now?: Date;
}) {
  const nothing = !asks.length && !digest.deadline && !digest.codes.length;
  return (
    <div className="mx-3 mb-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 p-3 space-y-2">
      {nothing && (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Ни просьбы, ни срока, ни номера документа в письме не нашлось — похоже, это сообщение к сведению.
        </p>
      )}

      {asks.length > 0 && (
        <div>
          <p className="text-2xs font-semibold text-slate-400 dark:text-slate-500 mb-1">
            Просят
          </p>
          <ul className="space-y-1">
            {asks.map((a, i) => (
              <li key={i} className="text-xs text-slate-700 dark:text-slate-300">
                {a.ru || a.src}
                {a.ru && a.ru !== a.src && (
                  <span className="block text-2xs text-slate-400 dark:text-slate-500">{a.src}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {digest.deadline && (
          <span className="flex items-center gap-1.5 text-xs text-slate-700 dark:text-slate-300">
            <CalendarClock className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
            Срок: {digest.deadline.at.toLocaleDateString('ru-RU')}
            <span className="text-slate-400 dark:text-slate-500">
              — {dueLabel(digest.deadline.at, now)} · в письме «{digest.deadline.said}»
            </span>
          </span>
        )}
        {digest.codes.length > 0 && (
          <span className="flex items-center gap-1.5 text-xs text-slate-700 dark:text-slate-300">
            <FileText className="w-3.5 h-3.5 text-sky-600 dark:text-sky-400" />
            {digest.codes.join(' · ')}
          </span>
        )}
      </div>
    </div>
  );
}

export { digestOf };
