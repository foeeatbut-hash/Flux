import React, { useMemo, useState } from 'react';
import { ICON_SIZE } from '../../lib/metrics';
import { EquipmentAppIcon } from '../icons/AppIcons';
import EquipmentUnitOverview, { type EquipmentPanelComponent, type EquipmentPanelUnit } from './EquipmentUnitOverview';

interface Props {
  unit: EquipmentPanelUnit | null;
  selectedComponent?: EquipmentPanelComponent | null;
  onSelectComponent: (id: string) => void;
  onBackToUnit: () => void;
  onPickTag: (component: EquipmentPanelComponent) => void;
  onUnlinkTag: (component: EquipmentPanelComponent, tagId: string) => void;
  overviewHeader?: React.ReactNode;
  renderSelectedContent: (component: EquipmentPanelComponent, search: string, setSearch: (value: string) => void) => React.ReactNode;
}

function identity(component: EquipmentPanelComponent) {
  const name = String(component.name || '').trim();
  const match = name.match(/^(Клапан|Электропривод|Теплообменник|Узел регулирующий|Бак|Вентилятор|Электродвигатель)\s+(.+?)(?:\s+(№\d+))?$/iu);
  return match ? `${match[1]}${match[3] ? ` ${match[3]}` : ''} ${match[2]}` : name;
}

export default function EquipmentDetailPanel({ unit, selectedComponent, onSelectComponent, onBackToUnit, onPickTag, onUnlinkTag, overviewHeader, renderSelectedContent }: Props) {
  const [search, setSearch] = useState('');
  const components = useMemo(() => unit?.monoblocks.flatMap(monoblock => monoblock.components || []) || [], [unit]);
  const byId = useMemo(() => new Map(components.map(component => [component.id, component])), [components]);
  const rootOf = (component: EquipmentPanelComponent) => {
    let root = component;
    const seen = new Set([component.id]);
    while (root.parentElementId && byId.has(root.parentElementId) && !seen.has(root.parentElementId)) {
      seen.add(root.parentElementId);
      root = byId.get(root.parentElementId)!;
    }
    return root;
  };
  const childrenOf = (parentId: string) => components.filter(component => component.parentElementId === parentId)
    .sort((a, b) => (a.sourceOrder || 0) - (b.sourceOrder || 0));
  const selectedRoot = selectedComponent ? rootOf(selectedComponent) : null;
  const visibleSections = (monoblockId: string) => components.filter(component => {
    const monoblock = unit?.monoblocks.find(item => item.id === monoblockId);
    return !!monoblock?.components.some(item => item.id === component.id)
      && !component.parentElementId && component.itemCode !== '__unit__' && !component.itemCode.endsWith('_общие');
  });
  const descendants = (parentId: string, seen = new Set<string>()): EquipmentPanelComponent[] => {
    const found: EquipmentPanelComponent[] = [];
    for (const child of childrenOf(parentId)) {
      if (seen.has(child.id)) continue;
      seen.add(child.id); found.push(child, ...descendants(child.id, seen));
    }
    return found;
  };
  const selectedChildren = selectedRoot ? descendants(selectedRoot.id) : [];
  const rootPosition = components.find(component => component.itemCode === '__unit__');

  if (!unit) return <div className="blank"><div className="blank-title">Ничего не выбрано</div><div className="blank-text">Выберите установку в дереве слева — здесь появятся её схема и характеристики.</div></div>;
  if (!selectedComponent) return <>
    {overviewHeader}
    <EquipmentUnitOverview unit={unit} onSelect={onSelectComponent} onPickTag={onPickTag} onUnlinkTag={onUnlinkTag} />
  </>;

  return <div className="flex min-h-0 flex-1 flex-col" data-testid={`equipment-selected-${selectedComponent.id}`} data-equipment-id={selectedComponent.id}>
    <div data-testid="equipment-compact-navigation" className="sticky top-0 z-10 shrink-0 space-y-1 border-b border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-950">
      <div className="flex flex-wrap items-center gap-1.5">
        <button type="button" onClick={onBackToUnit} className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"><EquipmentAppIcon size={ICON_SIZE.row} />Установка</button>
        {rootPosition && <button type="button" onClick={() => onSelectComponent(rootPosition.id)} aria-current={selectedComponent.id === rootPosition.id ? 'true' : undefined} className="rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50 aria-[current=true]:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800 dark:aria-[current=true]:bg-slate-800">Параметры установки</button>}
        {unit.monoblocks.filter(monoblock => monoblock.name !== '__unit__').map(monoblock => <div key={monoblock.id} className="flex flex-wrap items-center gap-1 rounded-md border border-slate-200 p-1 dark:border-slate-700">
          <span className="px-1 text-xs text-slate-500 dark:text-slate-400">{monoblock.name.replace(/^Моноблок\s+/iu, 'МБ ')}</span>
          {visibleSections(monoblock.id).map(section => <button key={section.id} type="button" data-equipment-id={section.id} onClick={() => onSelectComponent(section.id)} aria-current={selectedRoot?.id === section.id ? 'true' : undefined} className="max-w-44 truncate rounded px-2 py-1 text-xs text-slate-600 hover:bg-slate-50 aria-[current=true]:bg-slate-100 aria-[current=true]:font-medium dark:text-slate-300 dark:hover:bg-slate-800 dark:aria-[current=true]:bg-slate-800">{section.itemCode} · {identity(section)}</button>)}
        </div>)}
      </div>
      {selectedChildren.length > 0 && <div data-testid="equipment-child-navigation" className="flex flex-wrap items-center gap-1 border-t border-slate-100 pt-1.5 dark:border-slate-800">
        <span className="mr-1 text-xs text-slate-500 dark:text-slate-400">Состав {selectedRoot?.itemCode}:</span>
        <button type="button" data-equipment-id={selectedRoot?.id} onClick={() => onSelectComponent(selectedRoot!.id)} aria-current={selectedComponent.id === selectedRoot?.id ? 'true' : undefined} className="rounded px-2 py-1 text-xs text-slate-600 hover:bg-slate-50 aria-[current=true]:bg-slate-100 aria-[current=true]:font-medium dark:text-slate-300 dark:hover:bg-slate-800 dark:aria-[current=true]:bg-slate-800">{identity(selectedRoot!)}</button>
        {selectedChildren.map(child => <button key={child.id} type="button" data-testid={`equipment-compact-child-${child.id}`} data-equipment-id={child.id} onClick={() => onSelectComponent(child.id)} aria-current={selectedComponent.id === child.id ? 'true' : undefined} className="max-w-48 truncate rounded px-2 py-1 text-xs text-slate-600 hover:bg-slate-50 aria-[current=true]:bg-slate-100 aria-[current=true]:font-medium dark:text-slate-300 dark:hover:bg-slate-800 dark:aria-[current=true]:bg-slate-800">{identity(child)}{child.tags?.[0]?.identifier ? ` · ${child.tags[0].identifier}` : ''}</button>)}
      </div>}
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto">
      {renderSelectedContent(selectedComponent, search, setSearch)}
    </div>
  </div>;
}
