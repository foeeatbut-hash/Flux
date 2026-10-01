import React, { useMemo } from 'react';
import {
  ArrowRight, Box, Boxes, ChevronRight, Fan, Filter, Flame, Layers, LayoutGrid,
  List, Plus, Recycle, SlidersHorizontal, Snowflake, Square, Tag as TagIcon,
  Volume2, Wind, X, Droplets,
} from 'lucide-react';
import { normalizeSpecs, type SpecParam } from '../../lib/specs';
import { buildUnitSchematic, type UnitSchematicItem, type UnitSchematicNode } from '../../lib/unitSchematic';

export interface UnitSchematicComponent extends UnitSchematicItem {
  name: string;
  specs?: string;
  version: number;
  hasConflict: boolean;
  status: string;
  tags?: { id: string; identifier: string; metadata?: unknown }[];
  role?: string;
  overrides?: string;
  paramConflicts?: string;
  instanceNo?: number | null;
  instanceCount?: number | null;
  sourceOrder?: number | null;
  manual?: boolean;
  sourceKind?: string | null;
  equipClass?: string | null;
  equipKind?: string | null;
}

export interface UnitSchematicUnit {
  id: string;
  name: string;
  fileName?: string;
  monoblocks: { id: string; name: string; components: UnitSchematicComponent[] }[];
}

const SECTION_ORDER: Record<string, number> = {
  'ВОЗДУХОПРИЁМНЫЙ': 10, 'КЛАПАН': 20, 'ФИЛЬТР': 30, 'РЕКУПЕРАТОР': 40,
  'НАГРЕВАТЕЛЬ': 50, 'ОХЛАДИТЕЛЬ': 60, 'УВЛАЖНИТЕЛЬ': 70, 'ВЕНТИЛЯТОР': 80,
  'ШУМОГЛУШИТЕЛЬ': 90, 'КАМЕРА': 100, 'СЕКЦИЯ': 110, 'ЗАВЕСА': 120, 'ПРОЧЕЕ': 900,
};
const SECTION_ICON: Record<string, React.ComponentType<any>> = {
  'ВОЗДУХОПРИЁМНЫЙ': Wind, 'КЛАПАН': SlidersHorizontal, 'ФИЛЬТР': Filter, 'РЕКУПЕРАТОР': Recycle,
  'НАГРЕВАТЕЛЬ': Flame, 'ОХЛАДИТЕЛЬ': Snowflake, 'УВЛАЖНИТЕЛЬ': Droplets, 'ВЕНТИЛЯТОР': Fan,
  'ШУМОГЛУШИТЕЛЬ': Volume2, 'КАМЕРА': Box, 'СЕКЦИЯ': Square, 'ЗАВЕСА': Wind,
};
const TINT: Record<string, string> = {
  'НАГРЕВАТЕЛЬ': 'text-amber-500', 'ОХЛАДИТЕЛЬ': 'text-sky-500', 'ВЕНТИЛЯТОР': 'text-emerald-500',
  'ФИЛЬТР': 'text-sky-500', 'УВЛАЖНИТЕЛЬ': 'text-sky-500', 'РЕКУПЕРАТОР': 'text-emerald-500',
};
const sectionIcon = (type: string) => SECTION_ICON[type] || Square;
const sectionTint = (type: string) => TINT[type] || 'text-slate-500';
const parentTagId = (metadata: unknown) => {
  let value = metadata;
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return ''; } }
  return String((value as { parentId?: unknown } | null)?.parentId || '');
};

function topSpecs(specs: string | undefined, n = 2): SpecParam[] {
  const out: SpecParam[] = [];
  const seen = new Set<string>();
  for (const group of normalizeSpecs(specs).groups) for (const param of group.params || []) {
    const key = String(param?.key ?? '').trim().toLowerCase();
    if (param && String(param.value ?? '').trim() && !seen.has(key)) {
      seen.add(key);
      out.push(param);
      if (out.length >= n) return out;
    }
  }
  return out;
}

interface Props {
  unit: UnitSchematicUnit;
  blockLabel: (component: UnitSchematicComponent) => string;
  onSelectBlock: (id: string) => void;
  onPickTag?: (component: UnitSchematicComponent) => void;
  onUnlinkTag?: (component: UnitSchematicComponent, tagId: string) => void;
}

export default function UnitSchematic({ unit, blockLabel, onSelectBlock, onPickTag, onUnlinkTag }: Props) {
  const components = useMemo(
    () => (unit.monoblocks || []).flatMap((mono) => mono.components || []),
    [unit],
  );
  const tree = useMemo(() => buildUnitSchematic(components, SECTION_ORDER), [components]);
  const tagLabels = useMemo(() => new Map(components.flatMap((component) =>
    (component.tags || []).map((tag) => [tag.id, tag.identifier] as const))), [components]);
  const generalComp = components.find((component) => component.itemCode === '__unit__');
  const monoGenerals = components.filter((component) => component.itemCode.endsWith('_общие'));
  const generalSpecs = generalComp ? normalizeSpecs(generalComp.specs).groups : [];
  // Одинаковые ключи из разных групп уточняются названием группы, иначе цифры выглядят противоречиво.
  const generalParams = useMemo(() => {
    const flat = generalSpecs.flatMap((group) => (group.params || [])
      .filter((param) => String(param.value ?? '').trim())
      .map((param) => ({ ...param, groupTitle: group.title })));
    const counts: Record<string, number> = {};
    for (const param of flat) {
      const key = String(param.key).trim().toLowerCase();
      counts[key] = (counts[key] || 0) + 1;
    }
    return flat.slice(0, 12).map((param) => ({
      ...param,
      key: counts[String(param.key).trim().toLowerCase()] > 1 && param.groupTitle && param.groupTitle !== 'Параметры'
        ? `${param.key} · ${param.groupTitle}` : param.key,
    }));
  }, [generalComp?.specs]);

  const tags = (component: UnitSchematicComponent) => (
    <span className="inline-flex items-center gap-1 flex-wrap">
      {(component.tags || []).map((tag) => (
        <span key={tag.id} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-xs text-slate-600 dark:text-slate-300">
          <TagIcon className="w-3 h-3 text-slate-400" />
          {parentTagId(tag.metadata) && <span className="text-slate-400" title={`Родительский тег: ${tagLabels.get(parentTagId(tag.metadata)) || parentTagId(tag.metadata)}`}>↳ {tagLabels.get(parentTagId(tag.metadata)) || 'тег'}</span>}
          {parentTagId(tag.metadata) && <span className="text-slate-400">→</span>}{tag.identifier}
          {onUnlinkTag && <button type="button" onClick={() => onUnlinkTag(component, tag.id)} className="text-slate-400 hover:text-rose-500 cursor-pointer" title="Отвязать тег"><X className="w-3 h-3" /></button>}
        </span>
      ))}
      {onPickTag && <button type="button" onClick={() => onPickTag(component)} className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-emerald-600 dark:hover:text-emerald-400 cursor-pointer" title="Назначить тег"><Plus className="w-3 h-3" />тег</button>}
    </span>
  );

  const branch = (node: UnitSchematicNode<UnitSchematicComponent>, depth = 0): React.ReactNode => {
    const component = node.item;
    const Icon = sectionIcon(component.equipType);
    return (
      <div key={component.id} className="min-w-0">
        <div className="flex items-center gap-2 min-h-8 px-2 py-1 hover:bg-slate-50 dark:hover:bg-slate-800/50">
          <span className="shrink-0 text-slate-300 dark:text-slate-500" aria-hidden="true">{depth > 0 ? '└' : ''}</span>
          <button type="button" onClick={() => onSelectBlock(component.id)} title={`${blockLabel(component)} — открыть характеристики`} className="flex min-w-0 flex-1 items-center gap-2 text-left cursor-pointer">
            <Icon className={`w-4 h-4 shrink-0 ${sectionTint(component.equipType)}`} />
            <span className="min-w-0 truncate text-xs text-slate-700 dark:text-slate-300">{blockLabel(component)}</span>
            {component.hasConflict && <span className="w-1.5 h-1.5 rounded-full bg-rose-500 shrink-0" title="Есть изменения" />}
          </button>
          {tags(component)}
          {node.children.length > 0 && <span className="text-xs text-slate-400">{node.children.length} внутри</span>}
          <ChevronRight className="w-3.5 h-3.5 text-slate-300 dark:text-slate-500 shrink-0" />
        </div>
        {node.children.length > 0 && (
          <details className="ml-5 border-l border-slate-200 dark:border-slate-800">
            <summary className="px-2 py-1 text-xs text-slate-400 cursor-pointer hover:text-slate-600 dark:hover:text-slate-300">Состав: {node.children.length}</summary>
            <div className="pl-2">{node.children.map((child) => branch(child, depth + 1))}</div>
          </details>
        )}
      </div>
    );
  };

  const rootBranch = (node: UnitSchematicNode<UnitSchematicComponent>, i: number) => {
    const component = node.item;
    const Icon = sectionIcon(component.equipType);
    const preview = topSpecs(component.specs);
    return (
      <React.Fragment key={component.id}>
        {i > 0 && <div className="flex items-center shrink-0 text-slate-300 dark:text-slate-500"><ArrowRight className="w-4 h-4" /></div>}
        <div className="shrink-0 w-36 flex flex-col items-center gap-2">
          <button type="button" onClick={() => onSelectBlock(component.id)} title={`${blockLabel(component)} — открыть характеристики`} className="group w-full flex flex-col items-center text-center gap-1.5 p-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-950/40 hover:border-slate-400 dark:hover:border-slate-600 transition-colors cursor-pointer">
            <Icon className={`w-5 h-5 ${sectionTint(component.equipType)}`} />
            <span className="text-xs font-medium leading-tight line-clamp-2 text-slate-700 dark:text-slate-300">{blockLabel(component)}</span>
            {preview.length > 0 && <span className="w-full text-xs text-slate-400 leading-tight truncate">{preview.map((param) => `${param.value}${param.unit ? ` ${param.unit}` : ''}`).join(' · ')}</span>}
            {component.hasConflict && <span className="text-xs text-rose-500">изменилось</span>}
          </button>
          {tags(component)}
          {node.children.length > 0 && (
            <details className="w-full rounded border border-slate-200 dark:border-slate-800">
              <summary className="px-2 py-1 text-xs text-slate-500 dark:text-slate-400 cursor-pointer">Ветви: {node.children.length}</summary>
              <div className="divide-y divide-slate-100 dark:divide-slate-800">{node.children.map((child) => branch(child, 1))}</div>
            </details>
          )}
        </div>
      </React.Fragment>
    );
  };

  return <>
    <div data-share-route="/equipment" data-share-focus={`unit:${unit.id}`} data-share-label={`Схема установки: ${unit.name}`} className="px-4 py-3 border-b border-slate-100 dark:border-slate-800 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="fx-badge fx-badge-accent">Установка</span>
          {unit.fileName && <span className="text-xs text-slate-400 font-mono truncate max-w-[220px]" title={unit.fileName}>{unit.fileName}</span>}
        </div>
        <h3 className="u-sel text-sm font-semibold mt-1 min-w-0 flex items-center gap-1.5"><Boxes className="w-4 h-4 text-slate-500 shrink-0" /><span className="flex-1 min-w-0 truncate">{unit.name}</span></h3>
        <p className="text-xs text-slate-400 mt-0.5">{tree.physicalCount} {tree.physicalCount === 1 ? 'позиция' : 'позиций'} · основные секции показаны по ходу воздуха</p>
        {generalComp && <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">{tags(generalComp)}</div>}
      </div>
    </div>

    <div className="flex-1 overflow-y-auto p-4 space-y-5">
      {generalParams.length > 0 && <section>
        <div className="fx-group-title mb-1.5">Общие характеристики установки</div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 border-y border-slate-200 dark:border-slate-800 py-2">
          {generalParams.map((param, i) => <div key={i} className="flex items-center gap-2 text-xs py-0.5 min-w-0">
            <span className="u-sel text-slate-500 dark:text-slate-400 flex-1 min-w-0 truncate" title={param.key}>{param.key}</span>
            <span className="u-sel font-medium text-slate-800 dark:text-slate-100 shrink-0 text-right">{param.value}{param.unit ? <span className="text-slate-400 font-normal"> {param.unit}</span> : ''}</span>
          </div>)}
        </div>
        <button type="button" onClick={() => onSelectBlock(generalComp!.id)} className="mt-1.5 text-xs text-emerald-600 dark:text-emerald-400 hover:underline cursor-pointer">Все параметры установки →</button>
      </section>}

      {tree.roots.length > 0 && <section>
        <div className="fx-group-title mb-2 flex items-center gap-1.5"><LayoutGrid className="w-3 h-3" />Схема установки</div>
        <div className="flex items-start gap-2 overflow-x-auto pb-2 -mx-1 px-1">{tree.roots.map(rootBranch)}</div>
      </section>}

      <section>
        <div className="fx-group-title mb-1.5 flex items-center gap-1.5"><List className="w-3 h-3" />Составные части</div>
        {tree.physicalCount === 0 && monoGenerals.length === 0 ? <p className="text-xs text-slate-400">У этой установки нет составных частей.</p> : <div className="divide-y divide-slate-100 dark:divide-slate-800">
          {tree.roots.map((node) => branch(node))}
          {tree.unassigned.length > 0 && <div className="pt-2">
            <div className="fx-group-title mb-1">Не распределено</div>
            <div className="divide-y divide-slate-100 dark:divide-slate-800">{tree.unassigned.map(({ node, reason }) => <div key={node.item.id}>
              <div className="px-2 py-0.5 text-xs text-slate-400">{reason === 'cycle' ? 'Цикл в связях состава'
                : node.item.parentElementId?.startsWith('tag-ambiguous:') ? 'Несколько родительских тегов'
                  : node.item.parentElementId?.startsWith('tag-parent:') ? `Родительский тег не найден: ${node.item.parentElementId.slice('tag-parent:'.length)}`
                    : `Родитель не найден: ${node.item.parentElementId}`}</div>
              {branch(node)}
            </div>)}</div>
          </div>}
          {monoGenerals.map((component) => <div key={component.id} className="flex items-center gap-2 min-h-8 px-2 py-1">
            <Layers className="w-4 h-4 shrink-0 text-slate-400" />
            <button type="button" onClick={() => onSelectBlock(component.id)} className="min-w-0 flex-1 truncate text-left text-xs text-slate-700 dark:text-slate-300 cursor-pointer">{blockLabel(component)}</button>
            {tags(component)}
          </div>)}
        </div>}
      </section>
    </div>
  </>;
}
