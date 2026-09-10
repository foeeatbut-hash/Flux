/**
 * Разметка снимка.
 *
 * Рисование здесь — над картинкой, в долях её размера: увеличение 25…400 %
 * меняет только то, как человек видит снимок, но не то, что уедет на сервер.
 * Поэтому стрелка, поставленная при 400 %, попадает туда же, куда её ставили.
 *
 * Отмена работает только внутри редактора и только по нажатию в нём. Ctrl+Z,
 * перехваченный на всё окно, отменял бы человеку не фигуру, а текст обращения,
 * который он писал до этого, — и вернуть его было бы нечем.
 *
 * «Скрыть данные» — не размытие и не маркер: под маской пикселей не остаётся
 * вовсе, потому что итоговая картинка рисуется заново (см. `flatten.ts`).
 * Отсюда и предупреждение: после подтверждения раскрыть закрытое нельзя.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Crop as CropIcon, MoveUpRight, Square, Circle, Minus, Pencil, Type, Hash, EyeOff,
  Undo2, Redo2, ZoomIn, ZoomOut, Maximize, Check, X,
} from 'lucide-react';
import { LIMITS } from '../../../feedback/contracts';
import {
  History, WHOLE, clampZoom, fitZoom, hasMask, nextMark, rectOf, reframe,
  type Crop, type Shape, type ShapeKind,
} from '../../feedback/shapes';
import { flattenImage } from '../../feedback/imageClient';
import { newRequestId } from '../../../feedback/contracts';

type Tool = ShapeKind | 'crop';

const TOOLS: Array<{ id: Tool; icon: any; name: string }> = [
  { id: 'crop', icon: CropIcon, name: 'Обрезать' },
  { id: 'arrow', icon: MoveUpRight, name: 'Стрелка' },
  { id: 'rect', icon: Square, name: 'Прямоугольник' },
  { id: 'ellipse', icon: Circle, name: 'Овал' },
  { id: 'line', icon: Minus, name: 'Линия' },
  { id: 'pencil', icon: Pencil, name: 'Карандаш' },
  { id: 'text', icon: Type, name: 'Надпись' },
  { id: 'mark', icon: Hash, name: 'Метка 1, 2, 3' },
  { id: 'mask', icon: EyeOff, name: 'Скрыть данные' },
];

const COLORS = ['#dc2626', '#ea580c', '#16a34a', '#2563eb', '#0f172a'];

interface Props {
  source: Blob;
  onDone: (flat: Blob, thumb: Blob | null, name: string) => void;
  onCancel: () => void;
}

/** Фигура в разметке предпросмотра: те же доли, только в процентах SVG. */
function Drawn({ shape }: { shape: Shape }) {
  const x1 = shape.x * 100, y1 = shape.y * 100, x2 = shape.x2 * 100, y2 = shape.y2 * 100;
  const left = Math.min(x1, x2), top = Math.min(y1, y2);
  const w = Math.abs(x2 - x1), h = Math.abs(y2 - y1);
  const stroke = { stroke: shape.color, strokeWidth: 0.4, fill: 'none', vectorEffect: 'non-scaling-stroke' as const };

  if (shape.kind === 'mask') return <rect x={left} y={top} width={w} height={h} fill="#0f172a" />;
  if (shape.kind === 'rect') return <rect x={left} y={top} width={w} height={h} {...stroke} />;
  if (shape.kind === 'ellipse') {
    return <ellipse cx={left + w / 2} cy={top + h / 2} rx={w / 2} ry={h / 2} {...stroke} />;
  }
  if (shape.kind === 'pencil') {
    const points = (shape.points || []).map((p) => `${p.x * 100},${p.y * 100}`).join(' ');
    return <polyline points={points} {...stroke} />;
  }
  if (shape.kind === 'text') {
    return <text x={x1} y={y1 + 2.5} fill={shape.color} fontSize={2.6} fontWeight={600}>{shape.text}</text>;
  }
  if (shape.kind === 'mark') {
    return (
      <g>
        <circle cx={x1} cy={y1} r={2.2} fill={shape.color} />
        <text x={x1} y={y1 + 0.8} fill="#fff" fontSize={2.4} fontWeight={700} textAnchor="middle">{shape.number}</text>
      </g>
    );
  }
  return (
    <g>
      <line x1={x1} y1={y1} x2={x2} y2={y2} {...stroke} />
      {shape.kind === 'arrow' && (() => {
        const angle = Math.atan2(y2 - y1, x2 - x1);
        const head = 2.4;
        const wing = (sign: number) => ({
          x: x2 - head * Math.cos(angle + sign * 0.45), y: y2 - head * Math.sin(angle + sign * 0.45),
        });
        const a = wing(1), b = wing(-1);
        return <><line x1={x2} y1={y2} x2={a.x} y2={a.y} {...stroke} /><line x1={x2} y1={y2} x2={b.x} y2={b.y} {...stroke} /></>;
      })()}
    </g>
  );
}

export default function ScreenshotEditor({ source, onDone, onCancel }: Props) {
  const [url, setUrl] = useState('');
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [tool, setTool] = useState<Tool>('arrow');
  const [color, setColor] = useState(COLORS[0]);
  const [zoom, setZoom] = useState(1);
  const [busy, setBusy] = useState(false);
  const [complaint, setComplaint] = useState('');
  const [crop, setCrop] = useState<Crop>(WHOLE);
  const [drag, setDrag] = useState<{ from: { x: number; y: number }; to: { x: number; y: number }; path: Array<{ x: number; y: number }> } | null>(null);

  const history = useRef(new History<Shape[]>([]));
  const [shapes, setShapes] = useState<Shape[]>([]);
  const surface = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const made = URL.createObjectURL(source);
    setUrl(made);
    return () => URL.revokeObjectURL(made);
  }, [source]);

  const apply = (next: Shape[]) => { history.current.push(next); setShapes(next); };
  const undo = () => setShapes(history.current.undo());
  const redo = () => setShapes(history.current.redo());

  /** Точка нажатия — в долях видимой (уже обрезанной) картинки. */
  const pointOf = (event: React.PointerEvent): { x: number; y: number } => {
    const box = surface.current?.getBoundingClientRect();
    if (!box || !box.width || !box.height) return { x: 0, y: 0 };
    return {
      x: Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)),
      y: Math.max(0, Math.min(1, (event.clientY - box.top) / box.height)),
    };
  };

  const down = (event: React.PointerEvent) => {
    if (busy) return;
    (event.target as Element).setPointerCapture?.(event.pointerId);
    const point = pointOf(event);
    if (tool === 'mark') {
      apply([...shapes, {
        id: newRequestId(), kind: 'mark', x: point.x, y: point.y, x2: point.x, y2: point.y,
        number: nextMark(shapes), color,
      }]);
      return;
    }
    setDrag({ from: point, to: point, path: [point] });
  };

  const move = (event: React.PointerEvent) => {
    if (!drag) return;
    const point = pointOf(event);
    setDrag({ from: drag.from, to: point, path: tool === 'pencil' ? [...drag.path, point] : drag.path });
  };

  const up = () => {
    if (!drag) return;
    const { from, to, path } = drag;
    setDrag(null);
    const box = rectOf(from.x, from.y, to.x, to.y);
    // Случайное касание не должно оставлять точку: у линии и стрелки нулевая
    // длина, у фигур — нулевая площадь
    const tiny = box.width < 0.005 && box.height < 0.005;

    if (tool === 'crop') {
      if (tiny) return;
      const cut: Crop = { x: box.x, y: box.y, w: box.width, h: box.height };
      // Обрезка меняет систему координат: разметка пересчитывается один раз,
      // здесь, а не при каждой отрисовке
      apply(reframe(shapes, cut));
      setCrop((prev) => ({
        x: prev.x + cut.x * prev.w, y: prev.y + cut.y * prev.h,
        w: prev.w * cut.w, h: prev.h * cut.h,
      }));
      setTool('arrow');
      return;
    }
    if (tool === 'text') {
      const said = window.prompt('Что написать на снимке?') || '';
      if (!said.trim()) return;
      apply([...shapes, { id: newRequestId(), kind: 'text', x: from.x, y: from.y, x2: to.x, y2: to.y, text: said.trim(), color }]);
      return;
    }
    if (tiny && tool !== 'pencil') return;
    apply([...shapes, {
      id: newRequestId(), kind: tool as ShapeKind,
      x: from.x, y: from.y, x2: to.x, y2: to.y,
      ...(tool === 'pencil' ? { points: path } : {}),
      color,
    }]);
  };

  const done = async () => {
    setBusy(true);
    setComplaint('');
    try {
      const flat = await flattenImage(source, { crop, shapes, maxPixels: LIMITS.imagePixels });
      if (flat.blob.size > LIMITS.imageBytes) {
        setComplaint(`Снимок больше ${Math.round(LIMITS.imageBytes / 1024 / 1024)} МБ — обрежьте лишнее`);
        return;
      }
      onDone(flat.blob, flat.thumb, `снимок-${new Date().toLocaleDateString('ru-RU')}.png`);
    } catch (error: any) {
      setComplaint(error?.message || 'Не удалось собрать картинку');
    } finally { setBusy(false); }
  };

  const preview = useMemo(() => {
    if (!drag || tool === 'mark') return null;
    const box = rectOf(drag.from.x, drag.from.y, drag.to.x, drag.to.y);
    if (tool === 'crop') {
      return (
        <rect x={box.x * 100} y={box.y * 100} width={box.width * 100} height={box.height * 100}
          fill="rgba(16,185,129,0.15)" stroke="#10b981" strokeWidth={0.3} vectorEffect="non-scaling-stroke" />
      );
    }
    return <Drawn shape={{
      id: 'draft', kind: tool as ShapeKind, x: drag.from.x, y: drag.from.y, x2: drag.to.x, y2: drag.to.y,
      ...(tool === 'pencil' ? { points: drag.path } : {}), number: nextMark(shapes), color,
    }} />;
  }, [drag, tool, color, shapes]);

  // Видимая часть: обрезка показывается сдвигом самой картинки, а не отдельной
  // копией — иначе на большом снимке в памяти жили бы две
  const shown = {
    width: size.width * crop.w * zoom,
    height: size.height * crop.h * zoom,
  };

  /** Вписать снимок целиком в отведённое место. */
  const fit = () => {
    const box = viewport.current?.getBoundingClientRect();
    if (!box || !size.width) { setZoom(1); return; }
    setZoom(fitZoom(
      { width: size.width * crop.w, height: size.height * crop.h },
      { width: box.width - 32, height: box.height - 32 },
    ));
  };

  // Как только стал известен размер картинки — показываем её целиком: снимок
  // окна почти всегда больше места, отведённого редактору
  useEffect(() => { if (size.width) fit(); }, [size.width, size.height, crop.w, crop.h]);

  /**
   * Ctrl+Z только здесь.
   *
   * Обработчик висит на самом редакторе, а не на окне: перехваченная на всё
   * окно отмена вернула бы не фигуру, а стёрла бы человеку текст обращения,
   * который он писал до снимка, — и вернуть его было бы нечем.
   */
  const keys = (event: React.KeyboardEvent) => {
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z') return;
    event.preventDefault();
    if (event.shiftKey) redo(); else undo();
  };

  return (
    <div className="flex flex-col h-full min-h-0 outline-none" tabIndex={0} onKeyDown={keys}>
      <div className="flex flex-wrap items-center gap-1 px-2 py-2 border-b border-slate-200 dark:border-dark-border">
        {TOOLS.map((one) => (
          <button key={one.id} type="button" title={one.name} onClick={() => setTool(one.id)}
            className={`w-8 h-8 rounded-lg flex items-center justify-center cursor-pointer
              ${tool === one.id ? 'bg-emerald-600 text-white' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-850'}`}>
            <one.icon className="w-4 h-4" />
          </button>
        ))}
        <span className="w-px h-5 bg-slate-200 dark:bg-slate-800 mx-1" />
        {COLORS.map((one) => (
          <button key={one} type="button" title="Цвет" onClick={() => setColor(one)}
            className={`w-5 h-5 rounded-full cursor-pointer border-2 ${color === one ? 'border-slate-400' : 'border-transparent'}`}
            style={{ background: one }} />
        ))}
        <span className="flex-1" />
        <button type="button" title="Отменить" onClick={undo} disabled={!history.current.canUndo}
          className="w-8 h-8 rounded-lg flex items-center justify-center cursor-pointer text-slate-600 dark:text-slate-300
                     hover:bg-slate-100 dark:hover:bg-slate-850 disabled:opacity-40">
          <Undo2 className="w-4 h-4" />
        </button>
        <button type="button" title="Вернуть" onClick={redo} disabled={!history.current.canRedo}
          className="w-8 h-8 rounded-lg flex items-center justify-center cursor-pointer text-slate-600 dark:text-slate-300
                     hover:bg-slate-100 dark:hover:bg-slate-850 disabled:opacity-40">
          <Redo2 className="w-4 h-4" />
        </button>
        <button type="button" title="Мельче" onClick={() => setZoom((z) => clampZoom(z / 1.25))}
          className="w-8 h-8 rounded-lg flex items-center justify-center cursor-pointer text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-850">
          <ZoomOut className="w-4 h-4" />
        </button>
        <button type="button" title="Вписать" onClick={fit}
          className="w-8 h-8 rounded-lg flex items-center justify-center cursor-pointer text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-850">
          <Maximize className="w-4 h-4" />
        </button>
        <button type="button" title="Крупнее" onClick={() => setZoom((z) => clampZoom(z * 1.25))}
          className="w-8 h-8 rounded-lg flex items-center justify-center cursor-pointer text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-850">
          <ZoomIn className="w-4 h-4" />
        </button>
      </div>

      <div ref={viewport} className="flex-1 min-h-0 overflow-auto scrollbar-thin bg-slate-100 dark:bg-slate-950 p-4">
        <div ref={surface} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
          className="relative mx-auto touch-none select-none"
          style={{ width: shown.width || '100%', height: shown.height || undefined, cursor: 'crosshair' }}>
          {url && (
            <div className="absolute inset-0 overflow-hidden">
              <img src={url} alt="Снимок" draggable={false}
                onLoad={(e) => setSize({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
                style={{
                  position: 'absolute',
                  width: size.width * zoom, height: size.height * zoom,
                  left: -size.width * crop.x * zoom, top: -size.height * crop.y * zoom,
                  maxWidth: 'none',
                }} />
            </div>
          )}
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 w-full h-full">
            {shapes.map((shape) => <Drawn key={shape.id} shape={shape} />)}
            {preview}
          </svg>
        </div>
      </div>

      <div className="flex items-center gap-2 px-3 py-2.5 border-t border-slate-200 dark:border-dark-border">
        <span className="min-w-0 flex-1 text-xs text-slate-500 dark:text-slate-400">
          {complaint || (hasMask(shapes)
            ? 'Закрытое маской из снимка удаляется насовсем: раскрыть его потом нельзя'
            : 'На сервер уйдёт новая картинка — без исходника и без того, что осталось за обрезкой')}
        </span>
        <button type="button" onClick={onCancel} disabled={busy}
          className="px-3 py-2 rounded-lg flex items-center gap-1.5 text-xs font-semibold cursor-pointer
                     text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-850 disabled:opacity-50">
          <X className="w-3.5 h-3.5" /> Отмена
        </button>
        <button type="button" onClick={done} disabled={busy}
          className="px-4 py-2 rounded-lg flex items-center gap-1.5 text-xs font-semibold cursor-pointer
                     bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">
          <Check className="w-3.5 h-3.5" /> {busy ? 'Собираем…' : 'Приложить'}
        </button>
      </div>
    </div>
  );
}
