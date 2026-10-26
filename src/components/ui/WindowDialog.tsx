/**
 * Диалог как дочернее окно программы.
 *
 * Раньше любой диалог ложился подложкой `fixed inset-0` на весь экран: пока он
 * открыт, нельзя было ни переключиться на другую программу, ни сдвинуть сам
 * диалог, ни поменять ему размер. Теперь диалог ведёт себя как окно Windows,
 * открытое программой: его двигают за шапку, тянут за края, разворачивают
 * двойным щелчком, а недоступной становится только программа-родитель (и
 * родительский диалог, если этот открыт из диалога). Остальные окна, панель
 * задач и Пуск работают как обычно.
 *
 * Где живёт: в окне программы диалог уходит порталом на стол (`[data-desk]`)
 * и стоит на высоте своего окна — чужое окно, поднятое поверх, закрывает и
 * диалог, как в системе. Свернули родителя или ушли на другой стол — диалог
 * прячется вместе с ним. Вне окна (панель, браузер без рабочего стола) места
 * для «окна в окне» нет: диалог встаёт по центру экрана поверх всего, тоже
 * двигается и тянется, но остальное под ним не блокирует.
 *
 * Шапка для перетаскивания — любой узел с атрибутом `data-dialog-drag`;
 * кнопки, поля и ссылки внутри неё нажимаются как обычно.
 */
import React from 'react';
import { createPortal } from 'react-dom';
import { usePaneId } from '../../lib/paneTitle';
import { useWindowStore } from '../../store/windowStore';
import { Z } from '../../lib/layers';

type Edge = 'n' | 's' | 'w' | 'e' | 'nw' | 'ne' | 'sw' | 'se';
interface Box { x: number; y: number; w: number; h: number }

/** Те же края, что у окна программы: полоса 6 точек, углы 12 */
const EDGES: { edge: Edge; cls: string }[] = [
  { edge: 'n', cls: 'top-0 left-2 right-2 h-1.5 cursor-ns-resize' },
  { edge: 's', cls: 'bottom-0 left-2 right-2 h-1.5 cursor-ns-resize' },
  { edge: 'w', cls: 'left-0 top-2 bottom-2 w-1.5 cursor-ew-resize' },
  { edge: 'e', cls: 'right-0 top-2 bottom-2 w-1.5 cursor-ew-resize' },
  { edge: 'nw', cls: 'top-0 left-0 w-3 h-3 cursor-nwse-resize' },
  { edge: 'ne', cls: 'top-0 right-0 w-3 h-3 cursor-nesw-resize' },
  { edge: 'sw', cls: 'bottom-0 left-0 w-3 h-3 cursor-nesw-resize' },
  { edge: 'se', cls: 'bottom-0 right-0 w-3 h-3 cursor-nwse-resize' },
];

const MIN_W = 280;
const MIN_H = 140;
/** Сколько шапки обязано остаться на столе, чтобы диалог можно было вернуть */
const KEEP = 80;

/**
 * Узел, который диалог закрывает своей заглушкой. Вложенный диалог (вопрос
 * «Удалить?» из окна импорта) блокирует родительский диалог, а не окно.
 */
const DialogParentContext = React.createContext<HTMLElement | null>(null);

/** Начать перетаскивание можно не с любой точки шапки: кнопка остаётся кнопкой */
const INTERACTIVE = 'button, a, input, select, textarea, label, [role="button"], [role="tab"], [contenteditable="true"], [data-no-drag]';

export interface WindowDialogProps {
  onClose: () => void;
  children: React.ReactNode;
  /** Классы самого окна диалога: `fx-dialog w-full max-w-md …` */
  className?: string;
  /** Имя для чтения с экрана */
  label?: string;
  /** Идёт операция: Esc и щелчок по заглушке не закрывают */
  busy?: boolean;
  /** Закрывать по Esc. Диалоги с несохранённым вводом могут отказаться */
  closeOnEsc?: boolean;
  /** Можно ли тянуть за края. Подтверждения в одну строку размер не меняют */
  resizable?: boolean;
  /** Дополнительные свойства окна: перетаскивание файлов внутрь и т. п. */
  boxProps?: React.HTMLAttributes<HTMLDivElement>;
  /**
   * Окно-родитель, если диалог рисуется вне него: общие вопросы
   * (`openConfirm`) живут в корне приложения и берут верхнее окно на момент
   * вызова. Пустая строка — родителя нет, диалог над экраном
   */
  winId?: string;
}

/**
 * Верхнее видимое окно этого стола. Диалоги, которые рисуются в корне
 * приложения (захват, «Поделиться», панель подсказок), берут его родителем на
 * момент открытия: блокируется оно, остальные программы остаются доступны
 */
export function topWindowId(): string {
  const { windows, desk } = useWindowStore.getState();
  const visible = windows.filter((w) => w.desk === desk && !w.minimized);
  return visible.length ? visible.reduce((a, b) => (b.z > a.z ? b : a)).id : '';
}

export function WindowDialog({
  onClose, children, className = 'fx-dialog w-full max-w-md', label, busy, closeOnEsc = true, resizable = true, boxProps, winId: ownerId,
}: WindowDialogProps) {
  const paneId = usePaneId();
  const winId = ownerId ?? (paneId.startsWith('win:') ? paneId.slice(4) : '');
  const win = useWindowStore((s) => (winId ? s.windows.find((w) => w.id === winId) : undefined));
  const desk = useWindowStore((s) => s.desk);
  const parentDialog = React.useContext(DialogParentContext);

  // Узлы находим после монтирования окна: рама и стол уже в документе
  const [host, setHost] = React.useState<{ layer: HTMLElement; guard: HTMLElement | null } | null>(null);
  React.useLayoutEffect(() => {
    if (!winId) { setHost({ layer: document.body, guard: null }); return; }
    const frame = document.querySelector<HTMLElement>(`[data-win="${winId}"]`);
    const layer = frame?.closest<HTMLElement>('[data-desk]') ?? null;
    if (!frame || !layer) { setHost({ layer: document.body, guard: null }); return; }
    setHost({ layer, guard: parentDialog ?? frame.querySelector<HTMLElement>('[data-window-body]') });
  }, [winId, parentDialog]);
  const inWindow = !!host && host.layer !== document.body;

  const boxRef = React.useRef<HTMLDivElement | null>(null);
  const [boxEl, setBoxEl] = React.useState<HTMLDivElement | null>(null);
  const setBox = React.useCallback((el: HTMLDivElement | null) => { boxRef.current = el; setBoxEl(el); }, []);
  /** Положение; размер задаётся явно, только когда человек потянул за край */
  const [pos, setPos] = React.useState<{ x: number; y: number } | null>(null);
  const [size, setSize] = React.useState<{ w: number; h: number } | null>(null);
  const restoreRef = React.useRef<Box | null>(null);
  const [flash, setFlash] = React.useState(0);

  const area = React.useCallback((): Box => {
    if (inWindow && host) { const r = host.layer.getBoundingClientRect(); return { x: 0, y: 0, w: r.width, h: r.height }; }
    return { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
  }, [inWindow, host]);

  // Первое положение — по центру родительского окна, чуть выше середины, как
  // ставит диалоги система. Мерим уже отрисованное окно, поэтому до замера оно
  // невидимо
  React.useLayoutEffect(() => {
    if (!host || pos || !boxRef.current) return;
    const a = area();
    const r = boxRef.current.getBoundingClientRect();
    const parent = inWindow && win ? { x: win.x, y: win.y, w: win.w, h: win.h } : a;
    const x = parent.x + (parent.w - r.width) / 2;
    const y = parent.y + Math.max(16, (parent.h - r.height) / 3);
    setPos(clamp({ x, y }, r.width, a));
  }, [host, pos, area, inWindow, win]);

  // Содержимое может вырасти уже после показа (загрузили файл — появились
  // поля): окно, поставленное по центру пустого диалога, ушло бы нижним краем
  // за стол, и кнопки в подвале оказались бы вне экрана. Когда размер меняется,
  // возвращаем окно в границы стола, не трогая то, что в них уже помещается
  React.useEffect(() => {
    if (!boxEl || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      const r = boxEl.getBoundingClientRect();
      const a = area();
      setPos((p) => {
        if (!p) return p;
        const x = Math.max(0, Math.min(p.x, a.w - 8 - r.width));
        const y = Math.max(0, Math.min(p.y, a.h - 8 - r.height));
        return x === p.x && y === p.y ? p : { x, y };
      });
    });
    ro.observe(boxEl);
    return () => ro.disconnect();
  }, [boxEl, area]);

  // Esc закрывает только «свой» диалог: фокус внутри него или в окне-родителе.
  // Слушатель на всём окне браузера закрывал бы диалог, пока человек печатает
  // в соседней программе
  React.useEffect(() => {
    if (!closeOnEsc) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || busy || e.defaultPrevented) return;
      const box = boxRef.current;
      const active = document.activeElement;
      if (!box) return;
      // Вложенный диалог отвечает первым: Esc закрывает верхний, а не оба
      if (box.querySelector('[data-window-dialog]')) return;
      const mine = box.contains(active) || active === document.body || !active;
      if (!mine) return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy, closeOnEsc]);

  // Фокус в диалог при открытии, если содержимое не взяло его само (autoFocus)
  React.useEffect(() => {
    if (!pos) return;
    const box = boxRef.current;
    if (box && !box.contains(document.activeElement)) box.focus({ preventScroll: true });
    // Только при первом показе
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!pos]);

  const startDrag = (e: React.PointerEvent, edge: Edge | null) => {
    if (e.button !== 0 || !boxRef.current) return;
    if (!edge) {
      const target = e.target as HTMLElement;
      if (!target.closest('[data-dialog-drag]') || target.closest(INTERACTIVE)) return;
    }
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const start = boxRef.current.getBoundingClientRect();
    const origin = { x: e.clientX, y: e.clientY };
    const base: Box = { x: pos?.x ?? 0, y: pos?.y ?? 0, w: start.width, h: start.height };
    restoreRef.current = null;
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - origin.x, dy = ev.clientY - origin.y;
      const a = area();
      if (!edge) { setPos(clamp({ x: base.x + dx, y: base.y + dy }, base.w, a)); return; }
      let { x, y, w, h } = base;
      if (edge.includes('e')) w = Math.max(MIN_W, base.w + dx);
      if (edge.includes('s')) h = Math.max(MIN_H, base.h + dy);
      if (edge.includes('w')) { w = Math.max(MIN_W, base.w - dx); x = base.x + base.w - w; }
      if (edge.includes('n')) { h = Math.max(MIN_H, base.h - dy); y = Math.max(0, base.y + base.h - h); h = base.y + base.h - y; }
      setPos({ x, y });
      setSize({ w, h });
    };
    const onUp = () => {
      el.releasePointerCapture(e.pointerId);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
  };

  // Двойной щелчок по шапке — развернуть на стол и обратно, как у окна
  const toggleMax = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (!resizable || !target.closest('[data-dialog-drag]') || target.closest(INTERACTIVE) || !boxRef.current) return;
    if (restoreRef.current) {
      const r = restoreRef.current;
      restoreRef.current = null;
      setPos({ x: r.x, y: r.y });
      setSize({ w: r.w, h: r.h });
      return;
    }
    const r = boxRef.current.getBoundingClientRect();
    restoreRef.current = { x: pos?.x ?? 0, y: pos?.y ?? 0, w: r.width, h: r.height };
    const a = area();
    setPos({ x: 8, y: 8 });
    setSize({ w: a.w - 16, h: a.h - 16 });
  };

  // Нажали на заблокированного родителя — диалог мигает: «сначала я»
  const nudge = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setFlash((n) => n + 1);
    boxRef.current?.focus({ preventScroll: true });
  };

  if (!host) return null;
  const hidden = inWindow && !!win && (win.minimized || win.desk !== desk);
  const a = area();
  const style: React.CSSProperties = {
    position: inWindow ? 'absolute' : 'fixed',
    // Целые пиксели: центрирование даёт дробные координаты, а окно на
    // полупикселе размывает текст и дробит ширины содержимого
    left: Math.round(pos?.x ?? 0),
    top: Math.round(pos?.y ?? 0),
    // Прячут и снаружи (`boxProps.style.visibility`): окно обращения уходит из кадра на время снимка
    visibility: boxProps?.style?.visibility,
    // До замера окно невидимо, но не `visibility: hidden`: скрытый узел не берёт фокус,
    // и autoFocus в полях диалога не срабатывал бы
    ...(pos ? {} : { opacity: 0, pointerEvents: 'none' as const }),
    // Только высота: ширину ограничивает класс окна (`max-w-md`), и
    // встроенный maxWidth перебил бы его — окно растянулось бы на весь стол
    maxHeight: a.h - 16,
    ...(size ? { width: Math.round(size.w), height: Math.round(size.h), maxWidth: 'none', maxHeight: 'none' } : {}),
  };

  const dialog = (
    <div
      ref={setBox}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      tabIndex={-1}
      data-window-dialog
      {...boxProps}
      onPointerDown={(e) => { boxProps?.onPointerDown?.(e); startDrag(e, null); }}
      onDoubleClick={(e) => { boxProps?.onDoubleClick?.(e); toggleMax(e); }}
      style={{ ...boxProps?.style, ...style }}
      // Два одинаковых класса по очереди: смена имени анимации перезапускает
      // её на каждое нажатие, не пересоздавая содержимое диалога
      className={`${className} outline-none fx-dialog-in ${flash ? (flash % 2 ? 'fx-dialog-flash-a' : 'fx-dialog-flash-b') : ''}`}
    >
      <DialogParentContext.Provider value={boxEl}>{children}</DialogParentContext.Provider>
      {resizable && EDGES.map(({ edge, cls }) => (
        <span key={edge} aria-hidden onPointerDown={(e) => { e.stopPropagation(); startDrag(e, edge); }} className={`absolute ${cls} z-20`} />
      ))}
    </div>
  );

  return (
    <>
      {/* Заглушка поверх родителя: нажатия не проходят, но и экран не гаснет */}
      {host.guard && !hidden && createPortal(
        <div aria-hidden className="absolute inset-0 z-[70] bg-slate-900/[0.04] dark:bg-black/20 cursor-default"
          onPointerDown={nudge} onClick={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()} />,
        host.guard,
      )}
      {createPortal(
        inWindow
          ? <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: Z.windows + (win?.z ?? 0), display: hidden ? 'none' : undefined }}>
              <div style={{ pointerEvents: 'auto' }}>{dialog}</div>
            </div>
          // Вне окна заглушки на весь экран тоже нет: она закрывала бы панель
          // задач и всё остальное — ровно то, от чего диалоги и уводили
          : <div style={{ position: 'fixed', inset: 0, zIndex: Z.modal, pointerEvents: 'none' }}>
              <div style={{ pointerEvents: 'auto' }}>{dialog}</div>
            </div>,
        host.layer,
      )}
    </>
  );
}

function clamp(p: { x: number; y: number }, w: number, a: Box) {
  return {
    x: Math.min(Math.max(p.x, a.x - w + KEEP), a.x + a.w - KEEP),
    y: Math.min(Math.max(p.y, a.y), a.y + a.h - 40),
  };
}

/**
 * Мастера, которые бывают и отдельным окном, и шагом внутри другого мастера
 * (`embedded`): во втором случае это обычный блок страницы без рамки окна,
 * в первом — дочернее окно. Своё определение на модуль, а не внутри
 * компонента: иначе при каждой отрисовке содержимое пересоздавалось бы.
 */
export function WindowDialogOrEmbedded({ embedded, embeddedClassName, children, ...dialog }: WindowDialogProps & {
  embedded?: boolean;
  /** Классы блока, когда окна нет */
  embeddedClassName: string;
}) {
  if (embedded) return <div className={embeddedClassName}>{children}</div>;
  return <WindowDialog {...dialog}>{children}</WindowDialog>;
}
