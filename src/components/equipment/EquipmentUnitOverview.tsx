import React from 'react';
import { buildEquipmentOverview, type EquipmentOverviewNode } from '../../lib/equipmentUnitOverview';
import { equipmentIdentityOf } from '../../lib/equipmentIdentity';
import { ICON_SIZE } from '../../lib/metrics';
import { EquipmentAppIcon } from '../icons/AppIcons';

export interface EquipmentPanelComponent {
  id: string;
  itemCode: string;
  name: string;
  equipType?: string;
  specs?: string;
  parentElementId?: string | null;
  sourceOrder?: number | null;
  tags?: { id: string; identifier: string; metadata?: unknown }[];
}

export interface EquipmentPanelUnit {
  id: string;
  name: string;
  category?: string;
  fileName?: string;
  monoblocks: { id: string; name: string; components: EquipmentPanelComponent[] }[];
}

interface Props {
  unit: EquipmentPanelUnit;
  onSelect: (componentId: string) => void;
  onPickTag: (component: EquipmentPanelComponent) => void;
  onUnlinkTag: (component: EquipmentPanelComponent, tagId: string) => void;
}

function paramsOf(component: EquipmentPanelComponent): any[] {
  try {
    const raw = typeof component.specs === 'string' ? JSON.parse(component.specs) : component.specs;
    return (Array.isArray(raw?.groups) ? raw.groups : []).flatMap((group: any) => group.params || []);
  } catch { return []; }
}


function TagList({ component, onPickTag, onUnlinkTag }: Pick<Props, 'onPickTag' | 'onUnlinkTag'> & { component: EquipmentPanelComponent }) {
  return <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2">
    {(component.tags || []).map(tag => <span key={tag.id} className="inline-flex items-center gap-1 text-xs text-slate-600 dark:text-slate-300">
      {tag.identifier}
      <button type="button" onClick={() => onUnlinkTag(component, tag.id)} className="text-slate-400 hover:text-rose-500" aria-label={`Отвязать тег ${tag.identifier}`}>×</button>
    </span>)}
    <button type="button" onClick={() => onPickTag(component)} className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200">+ тег</button>
  </div>;
}

const reasonLabels = { 'missing-parent': 'Родитель не найден', cycle: 'Цикл в составе', 'tag-parent': 'Родительский тег не найден', 'tag-ambiguous': 'Неоднозначная связь по тегам' } as const;

export default function EquipmentUnitOverview({ unit, onSelect, onPickTag, onUnlinkTag }: Props) {
  const components = unit.monoblocks.flatMap(monoblock => monoblock.components || []);
  const tree = buildEquipmentOverview([...components].sort((a, b) => (a.sourceOrder || 0) - (b.sourceOrder || 0)), {});
  const root = components.find(component => component.itemCode === '__unit__');
  const monoblocks = unit.monoblocks.filter(monoblock => monoblock.name !== '__unit__');

  const childRows = (node: EquipmentOverviewNode<EquipmentPanelComponent>, depth = 1): React.ReactNode => node.children.map(childNode => {
    const child = childNode.item;
    const identity = equipmentIdentityOf(child);
    return <React.Fragment key={child.id}>
      <button type="button" data-testid={`equipment-unit-child-${child.id}`} onClick={() => onSelect(child.id)} className="flex w-full items-center gap-3 border-t border-slate-100 px-3 py-2 text-left hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/50">
        <span className="min-w-0 flex-1" style={{ paddingLeft: (depth - 1) * 12 }}>
          <span className="block truncate text-sm text-slate-700 dark:text-slate-300">{identity.name}</span>
          {identity.model && <span className="block truncate text-xs text-slate-500 dark:text-slate-400">{identity.model}</span>}
        </span>
        {(child.tags || []).map(tag => <span key={tag.id} className="font-mono text-xs text-slate-500 dark:text-slate-400">{tag.identifier}</span>)}
      </button>
      {childRows(childNode, depth + 1)}
    </React.Fragment>;
  });

  return <div data-testid="equipment-unit-overview" data-equipment-id={unit.id} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
    <header className="flex items-start justify-between gap-3 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400"><EquipmentAppIcon size={ICON_SIZE.row} />Установка</div>
        <h2 className="mt-1 truncate text-base font-semibold text-slate-800 dark:text-slate-100">{unit.name}</h2>
        {unit.fileName && <div className="mt-1 truncate text-xs text-slate-500 dark:text-slate-400">{unit.fileName}</div>}
      </div>
      {root && <div className="flex shrink-0 flex-col items-end gap-1">
        <button type="button" onClick={() => onSelect(root.id)} className="text-sm text-slate-600 hover:text-emerald-700 dark:text-slate-300 dark:hover:text-emerald-300">Параметры установки</button>
        <TagList component={root} onPickTag={onPickTag} onUnlinkTag={onUnlinkTag} />
      </div>}
    </header>
    <div className="space-y-3 p-3">
      {monoblocks.map(monoblock => {
        const members = new Set(monoblock.components.map(item => item.id));
        const sections = tree.roots.filter(node => members.has(node.item.id));
        const generalItems = tree.generalItems.filter(item => members.has(item.id));
        return <section key={monoblock.id} className="min-w-0">
          <h3 className="border-b border-slate-200 px-1 pb-2 text-sm font-semibold text-slate-700 dark:border-slate-800 dark:text-slate-300">{monoblock.name}</h3>
          {generalItems.length > 0 && <div data-testid={`equipment-mono-general-${monoblock.id}`} className="mt-2 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
            <h4 className="text-sm font-medium text-slate-800 dark:text-slate-100">Общие характеристики моноблока</h4>
            {generalItems.map(item => <div key={item.id} className="mt-2">
              <div className="mb-1 text-xs text-slate-500 dark:text-slate-400">{item.name}</div>
              <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm @[760px]:grid-cols-2">
                {paramsOf(item).map((param: any, index: number) => <div key={`${item.id}:${index}`} className="min-w-0">
                  <dt className="truncate text-xs text-slate-500 dark:text-slate-400">{String(param.key || '')}</dt>
                  <dd className="break-words text-slate-700 dark:text-slate-300">{String(param.value ?? '')}{param.unit ? ` ${param.unit}` : ''}</dd>
                </div>)}
              </dl>
            </div>)}
          </div>}
          <div className="grid grid-cols-1 gap-2 pt-2 @[760px]:grid-cols-2">
            {sections.map(node => {
              const component = node.item;
              const identity = equipmentIdentityOf(component);
              return <article key={component.id} className="min-w-0 overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800">
                <button type="button" data-testid={`equipment-unit-block-${component.id}`} onClick={() => onSelect(component.id)} className="w-full px-3 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-800/50">
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate font-mono text-xs text-slate-500 dark:text-slate-400">Блок {component.itemCode}</span>
                  </span>
                  <span className="mt-1 block truncate text-sm font-medium text-slate-800 dark:text-slate-100">{identity.name}</span>
                  {identity.model && <span className="mt-0.5 block truncate text-xs text-slate-500 dark:text-slate-400">{identity.model}</span>}
                </button>
                <TagList component={component} onPickTag={onPickTag} onUnlinkTag={onUnlinkTag} />
                {childRows(node)}
              </article>;
            })}
          </div>
        </section>;
      })}
      {tree.unassigned.length > 0 && <section data-testid="equipment-unassigned" className="rounded-lg border border-amber-300 bg-amber-50/50 p-3 dark:border-amber-900 dark:bg-amber-950/20">
        <h3 className="text-sm font-semibold text-amber-900 dark:text-amber-200">Не распределено</h3>
        <div className="mt-2 space-y-2">
          {tree.unassigned.map(({ node, reason }) => <article key={node.item.id} className="rounded-md border border-amber-200 dark:border-amber-900">
            <div className="flex items-center justify-between gap-2 px-3 py-2">
              <button type="button" onClick={() => onSelect(node.item.id)} className="min-w-0 truncate text-left text-sm font-medium text-slate-800 dark:text-slate-100">{node.item.itemCode} · {equipmentIdentityOf(node.item).name}</button>
              <span className="shrink-0 text-xs text-amber-800 dark:text-amber-200">{reasonLabels[reason]}</span>
            </div>
            {childRows(node)}
          </article>)}
        </div>
      </section>}
    </div>
  </div>;
}
