import React from 'react';
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

function identityOf(component: EquipmentPanelComponent) {
  const raw = String(component.name || '').trim();
  const split = raw.match(/^(Клапан|Электропривод|Теплообменник|Узел регулирующий|Бак|Вентилятор|Электродвигатель|Выключатель светильника|Сервисный выключатель)\s+(.+?)(?:\s+(№\d+))?$/iu);
  if (split) return { name: `${split[1]}${split[3] ? ` ${split[3]}` : ''}`, model: split[2].trim() };
  const model = paramsOf(component).find(param => /^(кассета 1|теплообменник|вентилятор|клапан|узел обвязки|электродвигатель|электропривод)$/iu.test(String(param.key || '')) && String(param.value || '').trim() && String(param.value).trim() !== '-')?.value;
  const compact = raw.replace(/^Блок воздухоприемный.*$/iu, 'Воздухоприёмный')
    .replace(/^Воздухонагреватель жидкостный.*$/iu, 'Нагреватель')
    .replace(/^Воздухоохладитель.*$/iu, 'Охладитель')
    .replace(/^Фильтр карманный.*$/iu, 'Фильтр')
    .replace(/^Вентилятор.*$/iu, 'Вентилятор');
  return { name: compact, model: String(model || '') };
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

export default function EquipmentUnitOverview({ unit, onSelect, onPickTag, onUnlinkTag }: Props) {
  const components = unit.monoblocks.flatMap(monoblock => monoblock.components || []);
  const byParent = new Map<string, EquipmentPanelComponent[]>();
  for (const component of components) {
    const parent = component.parentElementId || '';
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent)!.push(component);
  }
  for (const children of byParent.values()) children.sort((a, b) => (a.sourceOrder || 0) - (b.sourceOrder || 0));
  const root = components.find(component => component.itemCode === '__unit__');
  const monoblocks = unit.monoblocks.filter(monoblock => monoblock.name !== '__unit__');
  const childrenOf = (component: EquipmentPanelComponent): EquipmentPanelComponent[] => byParent.get(component.id) || [];

  const childRows = (component: EquipmentPanelComponent, depth = 1): React.ReactNode => childrenOf(component).map(child => {
    const identity = identityOf(child);
    return <React.Fragment key={child.id}>
      <button type="button" data-testid={`equipment-unit-child-${child.id}`} onClick={() => onSelect(child.id)} className="flex w-full items-center gap-3 border-t border-slate-100 px-3 py-2 text-left hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/50">
        <span className="min-w-0 flex-1" style={{ paddingLeft: (depth - 1) * 12 }}>
          <span className="block truncate text-sm text-slate-700 dark:text-slate-300">{identity.name}</span>
          {identity.model && <span className="block truncate text-xs text-slate-500 dark:text-slate-400">{identity.model}</span>}
        </span>
        {(child.tags || []).map(tag => <span key={tag.id} className="font-mono text-xs text-slate-500 dark:text-slate-400">{tag.identifier}</span>)}
      </button>
      {childRows(child, depth + 1)}
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
        const sections = (byParent.get('') || []).filter(component => component.itemCode !== '__unit__' && !component.itemCode.endsWith('_общие') && monoblock.components.some(item => item.id === component.id));
        return <section key={monoblock.id} className="min-w-0">
          <h3 className="border-b border-slate-200 px-1 pb-2 text-sm font-semibold text-slate-700 dark:border-slate-800 dark:text-slate-300">{monoblock.name}</h3>
          <div className="grid grid-cols-1 gap-2 pt-2 @[760px]:grid-cols-2">
            {sections.map(component => {
              const identity = identityOf(component);
              return <article key={component.id} className="min-w-0 overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800">
                <button type="button" data-testid={`equipment-unit-block-${component.id}`} onClick={() => onSelect(component.id)} className="w-full px-3 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-800/50">
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate font-mono text-xs text-slate-500 dark:text-slate-400">Блок {component.itemCode}</span>
                  </span>
                  <span className="mt-1 block truncate text-sm font-medium text-slate-800 dark:text-slate-100">{identity.name}</span>
                  {identity.model && <span className="mt-0.5 block truncate text-xs text-slate-500 dark:text-slate-400">{identity.model}</span>}
                </button>
                <TagList component={component} onPickTag={onPickTag} onUnlinkTag={onUnlinkTag} />
                {childRows(component)}
              </article>;
            })}
          </div>
        </section>;
      })}
    </div>
  </div>;
}
