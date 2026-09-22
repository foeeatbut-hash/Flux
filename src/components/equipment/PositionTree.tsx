import React from 'react';
import { AlertTriangle, Boxes, ChevronDown, ChevronRight, Layers, Plus, RefreshCw, Tag as TagIcon, Trash2 } from 'lucide-react';
import { canDelete } from '../../lib/equipmentDelete';
import { compareTags } from '../../../equipment/notes';
import { roleTitle } from '../../../equipment/roles';

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
}

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

export default function PositionTree({
  title, units, loading, conflicts, expanded, selectedUnitId, selectedBlockId,
  onToggle, onPickUnit, onPickBlock, onReload, onDeleteUnit, onDeleteComponent, onAddPosition,
}: Props) {
  return (
    <div className="zone w-56 @[820px]:w-64 @[1060px]:w-80 shrink-0 flex flex-col overflow-hidden">
      <div className="px-3 py-2.5 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
        <span className="text-sm font-bold truncate">{title}</span>
        <div className="flex items-center gap-1.5">
          {conflicts > 0 && (
            <span className="flex items-center gap-1 text-2xs font-bold text-rose-600 dark:text-rose-400">
              <AlertTriangle className="w-3 h-3" />{conflicts}
            </span>
          )}
          <button type="button" onClick={onReload} className="p-1 text-slate-400 hover:text-emerald-600 cursor-pointer" title="Обновить">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {units.length === 0 ? (
          <div className="blank">
            <div className="blank-title">Категория пуста</div>
            <div className="blank-text">Оборудование появится после импорта расчёта или бланка. Кнопка «Импорт из документов» — внизу списка категорий.</div>
          </div>
        ) : units.map((unit) => (
          <div key={unit.id}>
            <div className="flex items-center group">
              <button type="button" onClick={() => onToggle(unit.id)} className="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400 shrink-0 cursor-pointer" title={expanded[unit.id] ? 'Свернуть' : 'Развернуть'}>
                {expanded[unit.id] ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
              </button>
              <button type="button" onClick={() => onPickUnit(unit)}
                className={`flex-1 flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-left cursor-pointer ${selectedUnitId === unit.id && !selectedBlockId ? 'bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900/40' : 'hover:bg-slate-100 dark:hover:bg-slate-800 border border-transparent'}`}>
                <Boxes className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                <span className="text-xs font-bold truncate">{unit.name}</span>
              </button>
              <button type="button" onClick={() => onDeleteUnit(unit)} className="opacity-0 group-hover:opacity-100 p-1 text-slate-400 hover:text-rose-500 cursor-pointer" title="Удалить установку"><Trash2 className="w-3.5 h-3.5" /></button>
            </div>
            {expanded[unit.id] && (unit.monoblocks || []).map((mb) => {
              const isUnitMb = mb.name === '__unit__';
              return (
                <div key={mb.id} className="ml-4">
                  {!isUnitMb && (
                    <button type="button" onClick={() => onToggle(mb.id)} className="w-full flex items-center gap-1.5 px-2 py-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-left cursor-pointer">
                      {expanded[mb.id] ? <ChevronDown className="w-3 h-3 shrink-0" /> : <ChevronRight className="w-3 h-3 shrink-0" />}
                      <Layers className="w-3 h-3 text-slate-400 shrink-0" />
                      <span className="text-xs font-semibold text-slate-500 dark:text-slate-400 truncate">{mb.name}</span>
                    </button>
                  )}
                  {/* Строка позиции и кнопки — СОСЕДИ, а не вложенные друг в
                      друга: кнопка внутри кнопки в этом проекте уже ловилась */}
                  {(isUnitMb || expanded[mb.id]) && layoutPositions(mb.components || []).map(({ c, depth }) => (
                    <div key={c.id} className="group flex items-center gap-0.5">
                      <button type="button" onClick={() => onPickBlock(c)}
                        style={{ paddingLeft: `${28 + depth * 12}px` }}
                        className={`flex-1 min-w-0 flex items-center gap-1.5 pr-2 py-1.5 rounded-lg text-left cursor-pointer ${selectedBlockId === c.id ? 'bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900/40' : 'hover:bg-slate-100 dark:hover:bg-slate-800 border border-transparent'}`}
                        title={c.role && c.role !== 'БЛОК' ? `${roleTitle(c.role)}${firstTag(c) ? ` · ${firstTag(c)}` : ''}` : firstTag(c) || undefined}>
                        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${c.hasConflict ? 'bg-rose-500' : 'bg-slate-300 dark:bg-slate-600'}`} />
                        <span className="text-xs truncate flex-1">{blockLabel(c)}</span>
                        {c.manual && <span className="text-2xs text-slate-400 shrink-0" title="Заведено вручную">рук.</span>}
                        {(c.tags?.length || 0) > 0 && <TagIcon className="w-3 h-3 text-emerald-500 shrink-0" />}
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
                  ))}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
