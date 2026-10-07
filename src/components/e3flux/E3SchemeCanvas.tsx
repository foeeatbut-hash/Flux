/**
 * Холст листа (docs/e3-integration.md, раздел 7): лист в миллиметрах, занятое
 * серым, блоки — прямоугольники с тегом и решением. Блок тянется мышью с
 * привязкой к сетке; рамку установки можно тянуть целиком. Пока блок не
 * показан настоящим (демонстрация — этап F), его габарит условный.
 */
import React, { useRef, useState } from 'react';
import type { E3Rect, E3SheetInfo } from '../../../e3/bridgeTypes';
import { snap } from '../../../e3/layout';
import { NODE_STATES } from '../../../e3/nodeState';
import type { SchemeNode, SchemeUnit } from './useSchemeData';
import type { Placed } from './useSchemeState';

interface Drag { ids: string[]; startX: number; startY: number; dx: number; dy: number; group: boolean }

export default function E3SchemeCanvas({ sheet, occupied, placed, units, selected, problems, scale, onSelect, onMove }: {
  sheet: E3SheetInfo; occupied: E3Rect[]; placed: Record<string, Placed>; units: SchemeUnit[]; selected: string; problems: Set<string>;
  /** Пикселей на миллиметр */
  scale: number; onSelect: (id: string) => void; onMove: (ids: string[], dx: number, dy: number, group: boolean) => void;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const px = (n: number) => n / scale;
  const at = (e: React.PointerEvent): { x: number; y: number } => {
    const m = svg.current!.getScreenCTM()!.inverse();
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m);
    return { x: p.x, y: p.y };
  };
  const start = (e: React.PointerEvent, ids: string[], group: boolean) => {
    if (e.button !== 0) return;
    const p = at(e);
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    setDrag({ ids, startX: p.x, startY: p.y, dx: 0, dy: 0, group });
  };
  const move = (e: React.PointerEvent) => {
    if (!drag) return;
    const p = at(e);
    setDrag({ ...drag, dx: snap(p.x - drag.startX, sheet.grid), dy: snap(p.y - drag.startY, sheet.grid) });
  };
  const end = () => {
    if (drag && (drag.dx || drag.dy)) onMove(drag.ids, drag.dx, drag.dy, drag.group);
    setDrag(null);
  };
  const rectOf = (id: string): E3Rect | null => {
    const p = placed[id];
    if (!p) return null;
    const moved = drag && drag.ids.includes(id);
    return moved ? { ...p.rect, x: p.rect.x + drag!.dx, y: p.rect.y + drag!.dy } : p.rect;
  };
  const font = px(11);
  const nodeById = new Map<string, SchemeNode>(units.flatMap((u) => u.nodes.map((n) => [n.id, n] as const)));

  return (
    <svg ref={svg} role="img" aria-label={`Лист ${sheet.format}`} width={sheet.size.w * scale} height={sheet.size.h * scale} viewBox={`0 0 ${sheet.size.w} ${sheet.size.h}`}
      className="select-none rounded border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900" onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
      <rect x={sheet.work.x} y={sheet.work.y} width={sheet.work.w} height={sheet.work.h} fill="none" stroke="currentColor" strokeWidth={px(1)} className="text-slate-400 dark:text-slate-500" />
      {occupied.map((o, i) => <rect key={i} x={o.x} y={o.y} width={o.w} height={o.h} className="fill-slate-200 dark:fill-slate-700" opacity={0.7}><title>Занято: сюда блок не ставится</title></rect>)}
      {units.map((u) => {
        const ids = [...u.nodes.map((n) => n.id), `${u.id}:start`, `${u.id}:end`].filter((id) => placed[id]);
        const rs = ids.map((id) => rectOf(id)!);
        if (!rs.length) return null;
        const x = Math.min(...rs.map((r) => r.x)) - 3; const y = Math.min(...rs.map((r) => r.y)) - px(22);
        const w = Math.max(...rs.map((r) => r.x + r.w)) + 3 - x; const h = Math.max(...rs.map((r) => r.y + r.h)) + 3 - y;
        return (
          <g key={u.id}>
            <rect x={x} y={y} width={w} height={h} fill="none" stroke="currentColor" strokeDasharray={`${px(4)} ${px(3)}`} strokeWidth={px(1)} className="text-slate-400 dark:text-slate-500" />
            <rect x={x} y={y} width={w} height={px(18)} className="cursor-move fill-slate-100 dark:fill-slate-800" onPointerDown={(e) => start(e, ids, true)}><title>Потяните, чтобы двигать установку целиком</title></rect>
            <text x={x + px(6)} y={y + px(13)} fontSize={font} className="pointer-events-none fill-slate-600 dark:fill-slate-300">{u.name}</text>
          </g>
        );
      })}
      {units.flatMap((u) => [`${u.id}:start`, `${u.id}:end`].map((id) => ({ id, u }))).map(({ id, u }) => {
        const r = rectOf(id); if (!r) return null;
        return <g key={id}><rect x={r.x} y={r.y} width={r.w} height={r.h} className="fill-slate-50 stroke-slate-300 dark:fill-slate-800/60 dark:stroke-slate-600" strokeWidth={px(1)} />
          <text x={r.x + r.w / 2} y={r.y + r.h / 2} fontSize={px(10)} textAnchor="middle" className="pointer-events-none fill-slate-500 dark:fill-slate-400">{id.endsWith('start') ? 'Начало' : 'Конец'}</text><title>{u.name}</title></g>;
      })}
      {[...nodeById.values()].map((n) => {
        const r = rectOf(n.id); if (!r) return null;
        const bad = problems.has(n.id); const on = selected === n.id;
        return (
          <g key={n.id} className="cursor-move" onPointerDown={(e) => { onSelect(n.id); start(e, [n.id], false); }}>
            <rect x={r.x} y={r.y} width={r.w} height={r.h} strokeWidth={px(on ? 2 : 1)}
              className={`${bad ? 'stroke-rose-500 fill-rose-50 dark:fill-rose-950/40' : on ? 'stroke-emerald-600 fill-emerald-50 dark:fill-emerald-950/40' : 'stroke-slate-500 fill-white dark:stroke-slate-400 dark:fill-slate-900'}`} />
            <text x={r.x + px(5)} y={r.y + px(15)} fontSize={font} className="pointer-events-none fill-slate-900 dark:fill-slate-100">{NODE_STATES[n.state].mark} {n.label || '—'}</text>
            <text x={r.x + px(5)} y={r.y + px(29)} fontSize={font} className="pointer-events-none fill-slate-500 dark:fill-slate-400">{n.selection.solution?.id || '—'}</text>
            <title>{`${n.label || n.name} · ${n.selection.solution ? `${n.selection.solution.id} ${n.selection.solution.name}` : NODE_STATES[n.state].title}${bad ? ' · не помещается: за рабочим полем или на занятом месте' : ''}`}</title>
          </g>
        );
      })}
    </svg>
  );
}
