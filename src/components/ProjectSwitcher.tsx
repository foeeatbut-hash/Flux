/**
 * Переключатель активного проекта.
 *
 * Раньше активный проект был подписью в углу под логотипом, а сменить его
 * можно было только со стартового экрана — при том что без выбранного
 * проекта пять разделов не работают вовсе. Теперь он виден всегда и
 * переключается на месте, из любого раздела.
 *
 * Два вида одной и той же вещи: широкий (`rail`) и в трее панели задач
 * (`tray`). В трее нажатие раньше открывало окно раздела «Проекты» целиком —
 * то есть на действие, которое делают по двадцать раз в день, человеку
 * показывали всё, что известно о проектах. Список из пяти последних, поиск и
 * строка «Все проекты» отвечают на тот же вопрос за одно нажатие.
 */
import React from 'react';
import { useOverlay } from '../store/overlayStore';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, FolderKanban, Search } from 'lucide-react';
import { useStore } from '../store/store';
import { dataService } from '../services/dataService';
import { BAR_BTN } from '../lib/metrics';

type Project = { id: string; name: string };

/** Сколько проектов показывать без поиска: дальше начинается пролистывание */
const RECENT_SHOWN = 5;
/** Размер всплывающей панели: по нему считается, куда она поместится */
const MENU_W = 288;
/**
 * Предел высоты панели, а не её высота.
 *
 * Разница существенная: раньше это число вычиталось из верха кнопки, и панель
 * вставала по выдуманной высоте. Теперь оно только ограничивает рост списка,
 * а место панели задаёт её низ.
 */
const MENU_H = 320;

export default function ProjectSwitcher({ compact, variant = 'rail', maxWidth, onOpenAll }: {
  compact: boolean;
  variant?: 'rail' | 'tray';
  /** Предел ширины кнопки в трее: её задаёт панель, а не сама кнопка */
  maxWidth?: number;
  /** «Все проекты» — то самое окно, которое раньше открывалось сразу */
  onOpenAll?: () => void;
}) {
  const { activeProject, setActiveProject } = useStore();
  const [open, setOpen] = React.useState(false);
  const [projects, setProjects] = React.useState<Project[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const btnRef = React.useRef<HTMLButtonElement>(null);
  /**
   * Где стоит панель. У панели в трее задаётся НИЗ, а не верх.
   *
   * Раньше верх считался как «верх кнопки минус высота меню», где высота —
   * записанное в коде число. Меню почти всегда ниже этого числа, и панель
   * повисала выше кнопки, оторванная от неё. Низ же известен точно: панель
   * задач. Так делает система, и так панель не оторвётся никогда — сколько бы
   * проектов в ней ни было.
   */
  const [pos, setPos] = React.useState<{ top?: number; bottom?: number; left: number } | null>(null);
  // Пока панель открыта, страница браузера уступает место
  useOverlay(open);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const list = await dataService.getProjects();
      setProjects((list || []).map((p: any) => ({ id: p.id, name: p.name })));
    } catch (_) {
      setProjects([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const openMenu = () => {
    const r = btnRef.current?.getBoundingClientRect();
    // В трее панель раскрывается вверх и прижимается к правому краю кнопки:
    // вниз ей некуда, там панель задач и край экрана
    if (r) {
      setPos(variant === 'tray'
        ? {
            // Отступ от панели задач тот же, что у остальных панелей трея
            bottom: Math.round(window.innerHeight - r.top + 6),
            left: Math.max(8, Math.min(r.right - MENU_W, window.innerWidth - MENU_W - 8)),
          }
        : { top: r.bottom + 6, left: Math.max(8, r.left) });
    }
    setOpen(true);
    setQuery('');
    load();
  };

  // Esc закрывает — как и все остальные всплывающие окна программы
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const matched = projects.filter((p) => p.name.toLowerCase().includes(query.trim().toLowerCase()));
  // Без поиска показываем пять: список из сорока проектов — это уже раздел
  // «Проекты», и для него есть строка внизу
  const shown = query.trim() ? matched : matched.slice(0, RECENT_SHOWN);
  const restCount = matched.length - shown.length;

  return (
    <>
      {variant === 'tray' ? (
        <button
          ref={btnRef}
          type="button"
          onClick={openMenu}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={activeProject ? `Активный проект: ${activeProject.name}. Сменить` : 'Выбрать проект'}
          title={activeProject ? `Проект «${activeProject.name}» — сменить` : 'Выбрать проект'}
          style={{ maxWidth, height: BAR_BTN }}
          className="flex items-center gap-2 px-2.5 rounded-[10px] cursor-pointer
                     border border-slate-200 dark:border-dark-border text-xs
                     text-slate-700 dark:text-slate-150 hover:bg-slate-100 dark:hover:bg-slate-850 transition-colors"
        >
          <span aria-hidden className="w-2 h-2 rounded-sm bg-emerald-500 shrink-0" />
          <span className="truncate font-semibold">{activeProject?.name || 'Проект не выбран'}</span>
        </button>
      ) : (
      <button
        ref={btnRef}
        type="button"
        onClick={openMenu}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={activeProject ? `Активный проект: ${activeProject.name}. Сменить` : 'Выбрать проект'}
        className={`w-full rounded-lg border border-slate-200 dark:border-dark-border bg-slate-50 dark:bg-dark-panel hover:border-emerald-600 dark:hover:border-emerald-400 cursor-pointer ${
          compact ? 'flex items-center justify-center p-1.5' : 'flex flex-col gap-0.5 px-1.5 py-1'
        }`}
        title={activeProject ? `Проект: ${activeProject.name}` : 'Проект не выбран'}
      >
        {compact && (
          <FolderKanban className={`w-3.5 h-3.5 shrink-0 ${activeProject ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-400'}`} />
        )}
        {!compact && (
          <>
            {/* Подпись графы отдельно от значения — язык штампа, принятый в
                программе. Слово «Проект» больше не отнимает ширину у названия. */}
            <span className="flex items-center justify-between gap-1 w-full">
              <span className="graf text-[9.5px] leading-none">Проект</span>
              <ChevronDown className="w-3 h-3 shrink-0 text-slate-400" />
            </span>
            {/* Одна строка с настоящим многоточием. Было line-clamp-2: в колонке
                шириной 96 px он обрывал название по букве — «Проек не…», и это
                читалось как сбой, а не как сокращение. Полное имя — в подсказке. */}
            <span className={`w-full text-2xs font-semibold leading-tight text-left truncate ${activeProject ? 'text-slate-700 dark:text-dark-text-main' : 'text-slate-400 dark:text-dark-text-muted'}`}>
              {activeProject?.name || 'не выбран'}
            </span>
          </>
        )}
      </button>
      )}

      {open && pos && createPortal(
        <div className="fixed inset-0 z-[80]" onMouseDown={() => setOpen(false)}>
          <div
            className="absolute max-h-[70vh] flex flex-col rounded-xl border border-slate-200 dark:border-dark-border bg-white dark:bg-dark-panel shadow-xl overflow-hidden"
            style={{ top: pos.top, bottom: pos.bottom, left: pos.left, width: MENU_W, maxHeight: MENU_H }}
            onMouseDown={(e) => e.stopPropagation()}
            role="listbox"
            aria-label="Выбор проекта"
          >
            <div className="flex items-center gap-2 px-2.5 py-2 border-b border-slate-200 dark:border-dark-border">
              <Search className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Найти проект"
                className="flex-1 bg-transparent text-xs outline-none text-slate-800 dark:text-dark-text-main placeholder:text-slate-400"
              />
            </div>

            <div className="overflow-y-auto scrollbar-thin py-1">
              {loading && <p className="px-3 py-3 text-xs text-slate-400">Загружаю список проектов…</p>}

              {!loading && shown.length === 0 && (
                <p className="px-3 py-3 text-xs text-slate-500 dark:text-dark-text-muted">
                  {projects.length === 0
                    ? 'Проектов пока нет. Создайте первый в разделе «Проекты».'
                    : 'Ничего не найдено — попробуйте другое название.'}
                </p>
              )}

              {shown.map((p) => {
                const active = activeProject?.id === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    role="option"
                    aria-selected={active}
                    onClick={() => { setActiveProject(p); setOpen(false); }}
                    className={`w-full flex items-center gap-2 px-3 py-2 text-left text-xs cursor-pointer ${
                      active
                        ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400 font-semibold'
                        : 'text-slate-700 dark:text-dark-text-main hover:bg-slate-100 dark:hover:bg-dark-surface'
                    }`}
                  >
                    <Check className={`w-3.5 h-3.5 shrink-0 ${active ? 'opacity-100' : 'opacity-0'}`} />
                    <span className="flex-1 min-w-0 truncate">{p.name}</span>
                  </button>
                );
              })}
            </div>

            {restCount > 0 && (
              <p className="shrink-0 px-3 py-1.5 text-2xs text-slate-400 border-t border-slate-200 dark:border-dark-border">
                …ещё {restCount}: найдите по названию
              </p>
            )}

            {onOpenAll && (
              <button
                type="button"
                onClick={() => { setOpen(false); onOpenAll(); }}
                className="shrink-0 flex items-center gap-2 px-3 py-2 text-2xs font-semibold text-slate-600 dark:text-slate-300
                           hover:bg-slate-100 dark:hover:bg-dark-surface border-t border-slate-200 dark:border-dark-border
                           text-left cursor-pointer"
              >
                <FolderKanban className="w-3.5 h-3.5 text-slate-400" />
                Все проекты
              </button>
            )}

            {activeProject && (
              <button
                type="button"
                onClick={() => { setActiveProject(null); setOpen(false); }}
                className="shrink-0 px-3 py-2 text-2xs text-slate-500 dark:text-dark-text-muted hover:bg-slate-100 dark:hover:bg-dark-surface border-t border-slate-200 dark:border-dark-border text-left cursor-pointer"
              >
                Работать без проекта
              </button>
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
