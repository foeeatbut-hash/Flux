/**
 * Окна программы при наведении на её кнопку — карточки над панелью задач.
 *
 * Как только окон становится больше, чем разделов, кнопка перестаёт отвечать
 * на вопрос «какое из них». Здесь она отвечает: для каждого окна карточка со
 * значком, именем документа, крестиком и уменьшенной картинкой окна.
 * Наведение на карточку подсвечивает окно на столе, щелчок поднимает или
 * разворачивает, средняя кнопка закрывает.
 *
 * Картинку даёт основной процесс (lib/windowThumb): у свёрнутого окна —
 * последняя, снятая перед сворачиванием. В браузере снимать нечем, и вместо
 * картинки стоит значок программы: рамка с серыми полосками, выдающая себя за
 * снимок, обманывала бы.
 *
 * Когда окон больше PEEK_MAX_THUMBS, картинки не помещаются в ряд, и карточки
 * превращаются в строки списка (как в системе).
 */
import React from 'react';
import { X, Plus } from 'lucide-react';
import { useWindowStore, windowsOf } from '../store/windowStore';
import type { WinState } from '../lib/windows';
import { sectionForPath } from '../workspace/sections';
import { displayForRect } from '../../workspace/displays';
import { AppIcon } from './icons/FluxIcons';
import { peekPlan, PEEK_CARD_W, PEEK_GAP, PEEK_PAD } from '../lib/taskbar';
import { cachedThumb, subscribeThumbs, thumbsVersion } from '../lib/windowThumb';

const THUMB_H = 104;

export default function TaskbarPeek({ path, center, barWidth, displayId, onEnter, onLeave, onClose }: {
  path: string;
  displayId?: number;
  /** Середина кнопки в точках от левого края панели */
  center: number;
  barWidth: number;
  onEnter: () => void;
  onLeave: () => void;
  onClose: () => void;
}) {
  const windows = useWindowStore((s) => s.windows);
  const titles = useWindowStore((s) => s.titles);
  const peeked = useWindowStore((s) => s.peeked);
  const focus = useWindowStore((s) => s.focus);
  // Закрытие спрашивает раздел: в окне может быть несохранённая правка
  const requestClose = useWindowStore((s) => s.requestClose);
  const close = React.useCallback((id: string) => { void requestClose(id); }, [requestClose]);
  const openAnother = useWindowStore((s) => s.openAnother);
  const setPeeked = useWindowStore((s) => s.setPeeked);
  const desk = useWindowStore((s) => s.desk);
  const def = sectionForPath(path);
  // Список — про этот стол: на соседнем окна той же программы живут своей
  // жизнью, и мешать их в одну стопку значило бы поднимать невидимое
  const displays = useWindowStore((s) => s.displays);
  const mine = windowsOf(windows, path, desk)
    .filter((w) => displayId === undefined || displayForRect(displays, w)?.id === displayId);
  // Картинки приходят позже карточек
  React.useSyncExternalStore(subscribeThumbs, thumbsVersion, thumbsVersion);

  // Первое появление — с въездом; дальше, при переходе на соседнюю кнопку,
  // карточки переезжают на новое место, а не появляются заново
  const [settled, setSettled] = React.useState(false);
  React.useEffect(() => { const t = setTimeout(() => setSettled(true), 220); return () => clearTimeout(t); }, []);

  // Подсветка на столе гаснет вместе с панелью: она принадлежит наведению,
  // а не окну
  React.useEffect(() => () => setPeeked(null), [setPeeked]);

  // Закрыли последнее окно прямо из карточки — показывать больше нечего
  React.useEffect(() => { if (!mine.length) onClose(); }, [mine.length]);
  if (!mine.length) return null;

  const plan = peekPlan(mine.length, center, barWidth);
  const top = mine[0];

  return (
    <div
      data-taskbar-peek
      onMouseEnter={onEnter}
      onMouseLeave={() => { setPeeked(null); onLeave(); }}
      /* Нижний отступ прозрачный, но живой: он закрывает зазор до кнопки, и
         мышь доходит до карточек, не гася их по дороге */
      style={{ left: plan.left, width: plan.width, bottom: '100%', transition: settled ? 'left 140ms var(--flux-ease, ease)' : undefined }}
      className="absolute pb-2 z-40"
    >
      <div key={path} className={`fx-pop fx-peek ${settled ? '' : 'fx-peek-in'}`}>
        {plan.mode === 'thumbs' ? (
          <div className="flex" style={{ gap: PEEK_GAP, padding: PEEK_PAD - 4 }}>
            {mine.map((w) => (
              <PeekCard key={w.id} win={w} title={titles[w.id] || def.title} path={path}
                lit={peeked === w.id} front={w.id === top.id}
                onPeek={() => setPeeked(w.id)} onUnpeek={() => setPeeked(null)}
                onOpen={() => { focus(w.id); onClose(); }} onClose={() => close(w.id)} />
            ))}
          </div>
        ) : (
          <div className="max-h-[60vh] overflow-y-auto">
            {mine.map((w) => (
              <PeekRow key={w.id} win={w} title={titles[w.id] || def.title} path={path} lit={peeked === w.id}
                onPeek={() => setPeeked(w.id)}
                onOpen={() => { focus(w.id); onClose(); }} onClose={() => close(w.id)} />
            ))}
          </div>
        )}
        {def.multi && (
          <button type="button"
            onClick={() => { openAnother(mine[0].href); onClose(); }}
            className="fx-menu-item border-t border-slate-100 dark:border-slate-850 mt-1 rounded-t-none">
            <Plus className="w-3 h-3" /> Ещё одно окно
          </button>
        )}
      </div>
    </div>
  );
}

/** Общие действия карточки и строки: щелчок поднимает, средняя кнопка закрывает */
function cardHandlers(p: { onOpen: () => void; onClose: () => void; onPeek: () => void }) {
  return {
    onMouseEnter: p.onPeek,
    onClick: p.onOpen,
    onAuxClick: (e: React.MouseEvent) => { if (e.button === 1) { e.preventDefault(); p.onClose(); } },
    // Средняя кнопка в Chromium ещё и включает автопрокрутку — гасим на нажатии
    onMouseDown: (e: React.MouseEvent) => { if (e.button === 1) e.preventDefault(); },
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.target !== e.currentTarget) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); p.onOpen(); }
      if (e.key === 'Delete') { e.preventDefault(); p.onClose(); }
    },
  };
}

function CloseBtn({ onClose }: { onClose: () => void }) {
  return (
    <button type="button" aria-label="Закрыть окно" title="Закрыть окно"
      onClick={(e) => { e.stopPropagation(); onClose(); }}
      className="shrink-0 w-5 h-5 rounded flex items-center justify-center cursor-pointer text-slate-400
                 opacity-0 group-hover:opacity-100 focus-visible:opacity-100
                 hover:text-white hover:bg-rose-600 transition-colors">
      <X className="w-3 h-3" />
    </button>
  );
}

function PeekCard({ win, title, path, lit, front, onPeek, onUnpeek, onOpen, onClose }: {
  win: WinState; title: string; path: string; lit: boolean; front: boolean;
  onPeek: () => void; onUnpeek: () => void; onOpen: () => void; onClose: () => void;
}) {
  const thumb = cachedThumb(win.id);
  return (
    <div
      role="button" tabIndex={0} aria-label={title} data-peek-card={win.id}
      data-lit={lit || undefined}
      {...cardHandlers({ onOpen, onClose, onPeek })}
      onMouseLeave={onUnpeek}
      style={{ width: PEEK_CARD_W }}
      className={`group shrink-0 rounded-md p-1 cursor-pointer outline-none transition-colors
                  hover:bg-slate-100 dark:hover:bg-slate-800 focus-visible:bg-slate-100 dark:focus-visible:bg-slate-800
                  ${lit ? 'bg-slate-100 dark:bg-slate-800' : ''}`}
    >
      <div className="flex items-center gap-1.5 h-6 px-0.5">
        <AppIcon path={path} size={16} />
        <span className={`flex-1 min-w-0 truncate text-xs ${front && !win.minimized ? 'font-medium' : ''} text-slate-700 dark:text-slate-100`}>
          {title}
        </span>
        <CloseBtn onClose={onClose} />
      </div>
      <div
        style={{ height: THUMB_H }}
        className="relative mt-1 rounded overflow-hidden border border-slate-200 dark:border-slate-700
                   bg-slate-100 dark:bg-slate-900 flex items-center justify-center"
      >
        {thumb ? (
          <img src={thumb.url} alt="" draggable={false}
            style={{ objectFit: 'cover', objectPosition: 'top left', opacity: win.minimized ? 0.7 : 1 }}
            className="w-full h-full" />
        ) : (
          <AppIcon path={path} size={40} />
        )}
        {win.minimized && (
          <span className="absolute left-1 bottom-1 px-1.5 rounded bg-slate-900/70 text-white text-2xs leading-4">свёрнуто</span>
        )}
      </div>
    </div>
  );
}

function PeekRow({ win, title, path, lit, onPeek, onOpen, onClose }: {
  win: WinState; title: string; path: string; lit: boolean;
  onPeek: () => void; onOpen: () => void; onClose: () => void;
}) {
  return (
    <div
      role="button" tabIndex={0} aria-label={title} data-peek-card={win.id}
      {...cardHandlers({ onOpen, onClose, onPeek })}
      className={`group flex items-center gap-2 px-2 h-8 rounded cursor-pointer outline-none
                  hover:bg-slate-100 dark:hover:bg-slate-800 focus-visible:bg-slate-100 dark:focus-visible:bg-slate-800
                  ${lit ? 'bg-slate-100 dark:bg-slate-800' : ''}`}
    >
      <AppIcon path={path} size={16} />
      <span className="flex-1 min-w-0 truncate text-sm text-slate-700 dark:text-slate-100">{title}</span>
      {win.minimized && <span className="text-2xs text-slate-400">свёрнуто</span>}
      <CloseBtn onClose={onClose} />
    </div>
  );
}
