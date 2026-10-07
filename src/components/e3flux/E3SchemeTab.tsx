/**
 * Вкладка «Схема» (docs/e3-integration.md, раздел 6): слева что выгружать,
 * в середине холст листа, справа свойства выбранного. Шапка (6.1) показывает
 * связь с E3: в браузере и без моста выгрузка и демонстрация закрыты с
 * объяснением, а подбор и раскладка работают. Положение блоков хранится за
 * проектом в браузере (см. useSchemeState).
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { LayoutGrid } from 'lucide-react';
import { LINK_TEXT, type E3LinkState } from '../../../e3/bridgeTypes';
import { checkPlacements, layoutUnits, type LayoutUnit } from '../../../e3/layout';
import { SHEET_SIZES, defaultOccupied, sheetFor } from '../../../e3/sheetFormats';
import { Btn, Empty, Select, Seg, Status, Toolbar } from '../ui';
import E3SchemeCanvas from './E3SchemeCanvas';
import E3SchemeCard from './E3SchemeCard';
import E3SchemeList, { profileLine } from './E3SchemeList';
import { useSchemeData } from './useSchemeData';
import { useSchemeState, type Placed } from './useSchemeState';

const muted = 'text-slate-500 dark:text-slate-400';
const linkState = (): E3LinkState => (typeof window !== 'undefined' && (window as any).electron ? 'no-bridge' : 'browser');

export default function E3SchemeTab({ projectId, onOpenProfile }: { projectId: string; onOpenProfile: () => void }) {
  const data = useSchemeData(projectId);
  const { saved, update } = useSchemeState(projectId);
  const [selected, setSelected] = useState('');
  const [zoom, setZoom] = useState<'fit' | 'big'>('fit');
  const link = linkState();
  // «Вписать»: масштаб по ширине области холста, а не фиксированный — окно программы двигают и растягивают
  const box = useRef<HTMLDivElement>(null);
  const [boxW, setBoxW] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setBoxW(el.clientWidth));
    ro.observe(el); setBoxW(el.clientWidth);
    return () => ro.disconnect();
  }, [data.loading]);
  const sheet = useMemo(() => sheetFor(saved?.format || ''), [saved?.format]);
  const occupied = useMemo(() => defaultOccupied(sheet), [sheet]);
  const off = saved?.off || {};
  const units = useMemo(() => data.units, [data.units]);
  const nodes = useMemo(() => units.flatMap((u) => u.nodes), [units]);
  const placed = saved?.placed || {};

  /** Раскладка по ходу воздуха: отмеченные узлы; поставленное руками остаётся на месте */
  const arrange = React.useCallback((keep: Record<string, Placed>, format: string) => {
    const sh = sheetFor(format);
    const input: LayoutUnit[] = units.map((u) => ({
      id: u.id, name: u.name,
      nodes: u.nodes.filter((n) => !off[n.id]).map((n) => ({ id: n.id, cls: n.cls, name: n.name, order: n.order, twoLevel: n.twoLevel, hasLeft: n.hasLeft, ...(keep[n.id]?.manual ? { manual: keep[n.id].rect } : {}) })),
    })).filter((u) => u.nodes.length);
    const res = layoutUnits(input, { sheet: sh, occupied: defaultOccupied(sh) });
    const next: Record<string, Placed> = {};
    for (const u of res.units) for (const p of u.placements) next[p.id] = { rect: p.rect, manual: !!p.manual };
    return next;
  }, [units, off]);

  // Первое открытие проекта: сразу раскладываем, чтобы холст не был пустым
  React.useEffect(() => {
    if (!data.loading && nodes.length && !Object.keys(placed).length) update((s) => ({ ...s, placed: arrange({}, s.format) }));
  }, [data.loading, nodes.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Снятые с выгрузки узлы на холсте не показываются и проблемой не считаются
  const problems = useMemo(() => new Set(checkPlacements(Object.entries(placed).filter(([id]) => !off[id]).map(([id, p]) => ({ id, rect: p.rect })), sheet, occupied)), [placed, sheet, occupied, off]);
  const shown = units.map((u) => ({ ...u, nodes: u.nodes.filter((n) => !off[n.id]) }));
  const node = nodes.find((n) => n.id === selected) || null;

  const move = (ids: string[], dx: number, dy: number, group: boolean) => update((s) => {
    const p = { ...s.placed };
    for (const id of ids) if (p[id]) p[id] = { rect: { ...p[id].rect, x: p[id].rect.x + dx, y: p[id].rect.y + dy }, manual: group ? p[id].manual : true };
    return { ...s, placed: p };
  });

  if (data.error) return <div className="p-4"><Empty title="Схема недоступна" text={data.error} /></div>;
  if (data.loading) return <div role="status" className={`p-4 text-sm ${muted}`}>Подготовка данных проекта…</div>;
  if (!data.book!.solutions.some((s) => !s.removed)) return <div className="p-4"><Empty title="Каталог типовых решений пуст" text="Сначала загрузите «Классификатор типовых решений» из Excel на вкладке «Типовые решения»." /></div>;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar>
        <Status tone="slate" title="Связь с E3.series">{LINK_TEXT[link]}</Status>
        <div className="ml-auto flex items-center gap-2">
          <Btn tone="ghost" disabled title="Нужна настольная версия Flux на компьютере с E3.series">Демонстрация</Btn>
          <Btn tone="primary" disabled title="Нужна настольная версия Flux на компьютере с E3.series">Выгрузить в E3.series</Btn>
        </div>
      </Toolbar>
      <div className="flex min-h-0 flex-1">
        <E3SchemeList units={units} skipped={data.skipped} off={off} selected={selected} onSelect={setSelected} onOpenProfile={onOpenProfile}
          profile={data.book ? profileLine(data.book, data.profile) : ''}
          onToggle={(ids, on) => update((s) => { const o = { ...s.off }; for (const id of ids) { if (on) delete o[id]; else o[id] = true; } return { ...s, off: o }; })} />
        <div className="flex min-w-0 flex-1 flex-col border-l border-slate-200 dark:border-slate-800">
          <Toolbar>
            <Btn tone="ghost" onClick={() => update((s) => ({ ...s, placed: arrange(s.placed, s.format) }))} title="Расставить по ходу воздуха; блоки, поставленные руками, не двигаются"><LayoutGrid className="w-3.5 h-3.5" /> Разложить</Btn>
            <Select value={sheet.format} onChange={(v) => update((s) => ({ ...s, format: v, placed: arrange(s.placed, v) }))} aria-label="Формат листа" className="w-auto" options={Object.keys(SHEET_SIZES).map((f) => ({ value: f, label: `Лист ${f}` }))} />
            <Seg label="Масштаб" value={zoom} onChange={setZoom} options={[{ value: 'fit', label: 'вписать' }, { value: 'big', label: 'крупно' }]} />
            <span className={`ml-auto text-xs ${problems.size ? 'text-rose-600 dark:text-rose-400' : muted}`}>{problems.size ? `Не помещается: ${problems.size} — сдвиньте блоки или смените формат` : 'Всё помещается'}</span>
          </Toolbar>
          <div ref={box} className="min-h-0 flex-1 overflow-auto p-3">
            {!nodes.length ? <Empty title="Узлов нет" text="В проекте нет оборудования, для которого есть типовые решения." /> : (
              <E3SchemeCanvas sheet={sheet} occupied={occupied} placed={placed} units={shown} selected={selected} problems={problems} scale={zoom === 'big' ? 3 : Math.max(0.5, (boxW - 26) / sheet.size.w || 1.3)} onSelect={setSelected} onMove={move} />
            )}
          </div>
        </div>
        <E3SchemeCard node={node} features={data.book!.features} attrs={data.attrs!} problem={!!node && problems.has(node.id)} />
      </div>
    </div>
  );
}
