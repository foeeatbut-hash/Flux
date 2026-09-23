import React from 'react';
import {
  AlertTriangle, Boxes, ChevronDown, ChevronRight, Eye, Layers, List, Plus, RefreshCw, Trash2,
} from 'lucide-react';
import { canDelete } from '../../lib/equipmentDelete';
import { compareTags } from '../../../equipment/notes';
import { roleTitle } from '../../../equipment/roles';
import { classById, classOrder, classTitle, type Classified } from '../../../equipment/classes';

/**
 * Дерево оборудования: установка → моноблок → блок → оборудование внутри блока.
 *
 * Уехало из `screens/Equipment.tsx` целиком, и не ради размера: здесь появились
 * две вещи, каждая со своим правилом.
 *
 * **Состав.** Двигатель стоит внутри вентилятора, привод — внутри клапана. Это
 * видно отступом, а не порядком строк: список, где двигатель просто идёт следом
 * за вентилятором, читается как «два соседних изделия», и на объекте по такой
 * картинке ищут не то.
 *
 * **Порядок.** Позиции идут ПО АЛФАВИТУ ТЕГА — так распорядился владелец
 * проекта, и так их ищут: инженер помнит тег, а не место блока в расчёте.
 * Сортировка естественная: `001A` перед `002A`, а `B01-9` перед `B01-10`.
 * Позиции без тега идут после тегированных, в порядке файла — выдумывать им
 * место в алфавите не из чего.
 *
 * Схему состава это НЕ трогает: там порядок физический, по расчёту, и алфавит
 * в ней был бы враньём про то, как установка собрана.
 *
 * **По типу.** Второй вид того же дерева: позиции всех установок категории,
 * собранные по типу оборудования (все приводы, все вентиляторы), внутри — по
 * тегу. Тег стоит в каждой строке обоих видов: инженер ищет глазами именно его.
 *
 * Правая кнопка по строке — меню: добавить внутрь, привязать тег, удалить.
 */

export interface TreeComponent {
  id: string; itemCode: string; name: string; equipType: string;
  hasConflict?: boolean;
  tags?: { id: string; identifier: string }[];
  role?: string;
  parentElementId?: string | null;
  instanceNo?: number | null;
  manual?: boolean;
  sourceOrder?: number | null;
  sourceKind?: string | null;
}
export interface TreeMonoblock { id: string; name: string; components: TreeComponent[] }
export interface TreeUnit { id: string; name: string; category: string; monoblocks: TreeMonoblock[] }

interface Props {
  title: string;
  units: TreeUnit[];
  loading: boolean;
  conflicts: number;
  expanded: Record<string, boolean>;
  selectedUnitId: string | null;
  selectedBlockId: string | null;
  onToggle: (id: string) => void;
  onPickUnit: (unit: TreeUnit) => void;
  onPickBlock: (c: TreeComponent) => void;
  onReload: () => void;
  onDeleteUnit: (unit: TreeUnit) => void;
  onDeleteComponent: (c: TreeComponent) => void;
  onAddPosition: (parent: TreeComponent) => void;
  /** Типы позиций — для вида «по типу» и подсказки в строке */
  types?: Map<string, Classified>;
  mode?: TreeMode;
  onMode?: (mode: TreeMode) => void;
  onOpenList?: () => void;
  onOpenView?: () => void;
  onPickTag?: (c: TreeComponent) => void;
  /** Завести позицию верхнего уровня в моноблоке */
  onAddToMonoblock?: (mb: TreeMonoblock, unit: TreeUnit) => void;
}

export type TreeMode = 'composition' | 'type';

/** Служебные строки — параметры установки и общие параметры моноблока */
export const blockLabel = (c: TreeComponent): string =>
  c.itemCode === '__unit__' ? 'Параметры установки'
    : c.itemCode.endsWith('_общие') ? 'Общие параметры моноблока'
      : c.name;

const firstTag = (c: TreeComponent) => (c.tags || [])[0]?.identifier || '';

/**
 * Позиции моноблока деревом: сначала владельцы, потом их содержимое.
 *
 * Внутри каждого уровня — алфавит тега; безтеговые в конце, в порядке файла.
 * Позиция, чей владелец потерялся (такое бывает после удаления), не пропадает
 * из списка: она показывается на верхнем уровне, иначе исчезла бы молча.
 */
export function layoutPositions(components: TreeComponent[]): { c: TreeComponent; depth: number }[] {
  const live = new Set(components.map((c) => c.id));
  const byParent = new Map<string, TreeComponent[]>();
  for (const c of components) {
    const key = c.parentElementId && live.has(c.parentElementId) ? c.parentElementId : '';
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(c);
  }

  const order = (list: TreeComponent[]) => [...list].sort((a, b) => {
    const at = firstTag(a);
    const bt = firstTag(b);
    if (at && bt) return compareTags(at, bt);
    if (at) return -1;
    if (bt) return 1;
    return (a.sourceOrder || 0) - (b.sourceOrder || 0);
  });

  const out: { c: TreeComponent; depth: number }[] = [];
  const walk = (key: string, depth: number, seen: Set<string>) => {
    for (const c of order(byParent.get(key) || [])) {
      if (seen.has(c.id)) continue;   // кольцо в данных не должно вешать окно
      seen.add(c.id);
      out.push({ c, depth });
      walk(c.id, depth + 1, seen);
    }
  };
  walk('', 0, new Set());
  return out;
}

/** Позиции категории по типу: группы в порядке справочника, внутри — по тегу */
export function byType(units: TreeUnit[], types: Map<string, Classified>) {
  const groups = new Map<string, { c: TreeComponent; unit: TreeUnit }[]>();
  for (const unit of units) for (const mb of unit.monoblocks || []) for (const c of mb.components || []) {
    const cls = types.get(c.id)?.cls || 'ПРОЧЕЕ';
    if (!groups.has(cls)) groups.set(cls, []);
    groups.get(cls)!.push({ c, unit });
  }
  const order = (a: TreeComponent, b: TreeComponent) => {
    const at = firstTag(a); const bt = firstTag(b);
    if (at && bt) return compareTags(at, bt);
    if (at) return -1;
    if (bt) return 1;
    return (a.sourceOrder || 0) - (b.sourceOrder || 0);
  };
  return [...groups.entries()].sort((a, b) => classOrder(a[0]) - classOrder(b[0]))
    .map(([cls, rows]) => ({ cls, rows: rows.sort((x, y) => order(x.c, y.c)) }));
}

export default function PositionTree({
  title, units, loading, conflicts, expanded, selectedUnitId, selectedBlockId,
  onToggle, onPickUnit, onPickBlock, onReload, onDeleteUnit, onDeleteComponent, onAddPosition,
  types, mode = 'composition', onMode, onOpenList, onOpenView, onPickTag, onAddToMonoblock,
}: Props) {
  // Меню правой кнопки: у курсора, закрывается щелчком мимо и Esc
  const [menu, setMenu] = React.useState<{ x: number; y: number; c: TreeComponent } | null>(null);
  React.useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', onKey); };
  }, [menu]);
  const openMenu = (e: React.MouseEvent, c: TreeComponent) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, c }); };

  // Ширина дерева — у человека: названия вроде «Электродвигатель 160М6-УХЛ2-400»
  // длинные, и кому-то нужно шире. Тянется за правый край, двойной щелчок —
  // обратно по умолчанию. Помнится в браузере: это привычка, а не свойство проекта
  const rootRef = React.useRef<HTMLDivElement>(null);
  const [width, setWidth] = React.useState<number | null>(() => {
    try { const v = Number(localStorage.getItem('flux_equip_tree_w')); return v >= 200 ? v : null; } catch (_) { return null; }
  });
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = rootRef.current?.offsetWidth || 280;
    let last = w0;
    const move = (ev: MouseEvent) => { last = Math.max(200, Math.min(720, w0 + ev.clientX - x0)); setWidth(last); };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      try { localStorage.setItem('flux_equip_tree_w', String(last)); } catch (_) { /* приватный режим */ }
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  const resetWidth = () => { setWidth(null); try { localStorage.removeItem('flux_equip_tree_w'); } catch (_) { /* приватный режим */ } };

  // Строка позиции одна на оба вида: тег виден всегда, а не только значком
  const row = (c: TreeComponent, pad: number, sub?: string, label?: string) => (
    <div key={c.id} className="group flex items-center gap-0.5" onContextMenu={(e) => openMenu(e, c)}>
      <button type="button" onClick={() => onPickBlock(c)}
        style={{ paddingLeft: `${pad}px` }}
        className={`flex-1 min-w-0 flex items-center gap-1.5 pr-2 py-1.5 rounded-lg text-left cursor-pointer ${selectedBlockId === c.id ? 'bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900/40' : 'hover:bg-slate-100 dark:hover:bg-slate-800 border border-transparent'}`}
        title={[types?.get(c.id) ? classTitle(types.get(c.id)!.cls) : c.role && c.role !== 'БЛОК' ? roleTitle(c.role) : '', types?.get(c.id)?.kind || '', firstTag(c)].filter(Boolean).join(' · ') || undefined}>
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${c.hasConflict ? 'bg-rose-500' : 'bg-slate-300 dark:bg-slate-600'}`} />
        {/* Тег — второй строкой под названием: в одной строке с ним он
            съедал название до «Клапан ПРОБ…», а в узкой колонке дерева
            нужны оба */}
        <span className="min-w-0 flex-1 flex flex-col">
          {/* Две строки, а не многоточие: марка — это и есть то, что отличает позиции */}
          <span className="text-xs break-words line-clamp-2" title={label || blockLabel(c)}>{label || blockLabel(c)}</span>
          {(firstTag(c) || sub) && (
            <span className="text-2xs truncate">
              {firstTag(c) && <span className="font-mono text-emerald-700 dark:text-emerald-400 u-sel">{firstTag(c)}</span>}
              {firstTag(c) && sub ? <span className="text-slate-400"> · </span> : null}
              {sub && <span className="text-slate-400">{sub}</span>}
            </span>
          )}
        </span>
        {c.manual && <span className="text-2xs text-slate-400 shrink-0" title="Заведено вручную">рук.</span>}
        {c.sourceKind === 'note' && <span className="text-2xs text-amber-600 dark:text-amber-400 shrink-0" title="Заведено по примечанию выгрузки">прим.</span>}
      </button>
      {canDelete(c as any) && (
        <>
          <button type="button" onClick={() => onAddPosition(c)}
            title={`Добавить позицию внутрь «${blockLabel(c)}»`} aria-label={`Добавить позицию внутрь ${blockLabel(c)}`}
            className="shrink-0 p-1 rounded-lg text-slate-400 opacity-0 group-hover:opacity-100
                       focus-visible:opacity-100 hover:text-emerald-600 cursor-pointer">
            <Plus className="w-3 h-3" />
          </button>
          <button type="button" onClick={() => onDeleteComponent(c)}
            title={`Удалить «${blockLabel(c)}»`} aria-label={`Удалить ${blockLabel(c)}`}
            className="shrink-0 p-1 rounded-lg text-slate-400 opacity-0 group-hover:opacity-100
                       focus-visible:opacity-100 hover:text-rose-500 cursor-pointer">
            <Trash2 className="w-3 h-3" />
          </button>
        </>
      )}
    </div>
  );

  const seg = (on: boolean) => `px-1.5 py-0.5 text-2xs font-bold rounded cursor-pointer ${on ? 'bg-emerald-600 text-white' : 'text-slate-500 hover:text-emerald-600'}`;

  return (
    <div ref={rootRef} style={width ? { width } : undefined}
      className={`zone relative ${width ? '' : 'w-60 @[820px]:w-72 @[1060px]:w-96'} shrink-0 flex flex-col overflow-hidden`}>
      <div onMouseDown={startResize} onDoubleClick={resetWidth} role="separator" aria-orientation="vertical"
        title="Потяните, чтобы изменить ширину; двойной щелчок — по умолчанию"
        className="absolute top-0 right-0 bottom-0 w-1.5 z-10 cursor-col-resize hover:bg-emerald-400/40" />
      <div className="px-3 py-2.5 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between gap-2">
        <span className="text-sm font-bold min-w-0 break-words line-clamp-2" title={title}>{title}</span>
        <div className="flex items-center gap-1.5">
          {conflicts > 0 && (
            <span className="flex items-center gap-1 text-2xs font-bold text-rose-600 dark:text-rose-400">
              <AlertTriangle className="w-3 h-3" />{conflicts}
            </span>
          )}
          {onOpenView && (
            <button type="button" onClick={onOpenView} className="p-1 text-slate-400 hover:text-emerald-600 cursor-pointer" title="Вид категории: какие параметры показывать у каждого типа">
              <Eye className="w-3.5 h-3.5" />
            </button>
          )}
          {onOpenList && (
            <button type="button" onClick={onOpenList} className="p-1 text-slate-400 hover:text-emerald-600 cursor-pointer" title="Позиции списком: по типу, с тегами">
              <List className="w-3.5 h-3.5" />
            </button>
          )}
          <button type="button" onClick={onReload} className="p-1 text-slate-400 hover:text-emerald-600 cursor-pointer" title="Обновить">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>
      {onMode && (
        <div className="px-3 py-1.5 border-b border-slate-100 dark:border-slate-800 flex items-center gap-1" role="group" aria-label="Вид дерева">
          <button type="button" className={seg(mode === 'composition')} onClick={() => onMode('composition')}>по составу</button>
          <button type="button" className={seg(mode === 'type')} onClick={() => onMode('type')}>по типу</button>
        </div>
      )}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {units.length === 0 ? (
          <div className="blank">
            <div className="blank-title">Категория пуста</div>
            <div className="blank-text">Оборудование появится после импорта расчёта или бланка. Кнопка «Импорт из документов» — внизу списка категорий.</div>
          </div>
        ) : mode === 'type' && types ? byType(units, types).map((g) => (
          <div key={g.cls} className="pb-1">
            <div className="px-2 pt-2 pb-1 text-2xs font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
              {classById(g.cls).plural} <span className="text-slate-400 font-semibold tabular-nums">· {g.rows.length}</span>
            </div>
            {/* Установку в этом виде называет её имя: «Параметры установки» у
                каждой из них читались бы одинаково */}
            {g.rows.map(({ c, unit }) => (c.itemCode === '__unit__'
              ? row(c, 12, types.get(c.id)?.kind, unit.name)
              : row(c, 12, [types.get(c.id)?.kind, units.length > 1 ? unit.name : ''].filter(Boolean).join(' · '))))}
          </div>
        )) : units.map((unit) => (
          <div key={unit.id}>
            <div className="flex items-center group">
              <button type="button" onClick={() => onToggle(unit.id)} className="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400 shrink-0 cursor-pointer" title={expanded[unit.id] ? 'Свернуть' : 'Развернуть'}>
                {expanded[unit.id] ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
              </button>
              <button type="button" onClick={() => onPickUnit(unit)}
                className={`flex-1 flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-left cursor-pointer ${selectedUnitId === unit.id && !selectedBlockId ? 'bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900/40' : 'hover:bg-slate-100 dark:hover:bg-slate-800 border border-transparent'}`}>
                <Boxes className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                <span className="text-xs font-bold truncate" title={unit.name}>{unit.name}</span>
              </button>
              <button type="button" onClick={() => onDeleteUnit(unit)} className="opacity-0 group-hover:opacity-100 p-1 text-slate-400 hover:text-rose-500 cursor-pointer" title="Удалить установку"><Trash2 className="w-3.5 h-3.5" /></button>
            </div>
            {expanded[unit.id] && (unit.monoblocks || []).map((mb) => {
              const isUnitMb = mb.name === '__unit__';
              return (
                <div key={mb.id} className="ml-4">
                  {!isUnitMb && (
                    <div className="group flex items-center">
                      <button type="button" onClick={() => onToggle(mb.id)} className="flex-1 min-w-0 flex items-center gap-1.5 px-2 py-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-left cursor-pointer">
                        {expanded[mb.id] ? <ChevronDown className="w-3 h-3 shrink-0" /> : <ChevronRight className="w-3 h-3 shrink-0" />}
                        <Layers className="w-3 h-3 text-slate-400 shrink-0" />
                        <span className="text-xs font-semibold text-slate-500 dark:text-slate-400 truncate">{mb.name}</span>
                      </button>
                      {onAddToMonoblock && (
                        <button type="button" onClick={() => onAddToMonoblock(mb, unit)}
                          title={`Добавить позицию в «${mb.name}»`} aria-label={`Добавить позицию в ${mb.name}`}
                          className="shrink-0 p-1 rounded-lg text-slate-400 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-emerald-600 cursor-pointer">
                          <Plus className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  )}
                  {/* Строка позиции и кнопки — СОСЕДИ, а не вложенные друг в
                      друга: кнопка внутри кнопки в этом проекте уже ловилась */}
                  {(isUnitMb || expanded[mb.id]) && layoutPositions(mb.components || []).map(({ c, depth }) => row(c, 28 + depth * 12))}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {menu && (
        <div role="menu" onMouseDown={(e) => e.stopPropagation()}
          style={{ left: menu.x, top: menu.y }}
          className="fixed z-50 min-w-[200px] py-1 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-xl text-xs">
          <div className="px-3 py-1 text-2xs text-slate-400 truncate max-w-[260px]">{blockLabel(menu.c)}{firstTag(menu.c) ? ` · ${firstTag(menu.c)}` : ''}</div>
          <button type="button" role="menuitem" onClick={() => { onPickBlock(menu.c); setMenu(null); }}
            className="w-full text-left px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer">Открыть карточку</button>
          {canDelete(menu.c as any) && (
            <button type="button" role="menuitem" onClick={() => { onAddPosition(menu.c); setMenu(null); }}
              className="w-full text-left px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer">Добавить позицию внутрь…</button>
          )}
          {onPickTag && (
            <button type="button" role="menuitem" onClick={() => { onPickTag(menu.c); setMenu(null); }}
              className="w-full text-left px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer">Привязать тег…</button>
          )}
          {canDelete(menu.c as any) && (
            <button type="button" role="menuitem" onClick={() => { onDeleteComponent(menu.c); setMenu(null); }}
              className="w-full text-left px-3 py-1.5 text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/30 cursor-pointer">Удалить…</button>
          )}
        </div>
      )}
    </div>
  );
}
