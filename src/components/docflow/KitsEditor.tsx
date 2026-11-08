import React from 'react';
import { Btn, Input, Select } from '../ui';
import { catalogService } from '../../services/catalogService';
import type { EquipmentClass } from '../../../catalog/model';
import { kitErrors, type DocflowKit, type DocflowKitItem } from '../../../shared/docflow/kits';
import type { DocflowConfig } from '../../../shared/docflow/config';

const emptyItem = (): DocflowKitItem => ({ docType: '', stage: '', unit: 'tag', necessity: 'required', responsibleRole: '', milestone: '', workdays: 0, condition: null });
const options = (current: string, values: Array<{ value: string; label: string }>) => current && !values.some(v => v.value === current) ? [{ value: current, label: `Недоступно: ${current}` }, ...values] : values;

/** Комплекты принадлежат проекту; изменение состава не создаёт строки реестра. */
export default function KitsEditor({ config, disabled, onChange }: { config: DocflowConfig; disabled: boolean; onChange: (kits: DocflowKit[]) => void }) {
  const [classes, setClasses] = React.useState<EquipmentClass[]>([]);
  const [roles, setRoles] = React.useState<Array<{ code: string; name: string }>>([]);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [error, setError] = React.useState('');
  React.useEffect(() => {
    let alive = true;
    void Promise.all([catalogService.catalog(), fetch('/api/roles').then(async r => { if (!r.ok) throw new Error(); return r.json(); })])
      .then(([catalog, data]) => { if (alive) { setClasses(catalog.classes || []); setRoles(data.roles || []); } })
      .catch(() => { if (alive) setError('Не удалось загрузить классы или должности. Повторно откройте раздел.'); });
    return () => { alive = false; };
  }, []);
  const kit = config.kits.find(k => k.classId === selected);
  const update = (items: DocflowKitItem[]) => { if (selected !== null) onChange(kit ? config.kits.map(k => k.classId === selected ? { ...k, items } : k) : [...config.kits, { classId: selected, items }]); };
  const edit = (index: number, patch: Partial<DocflowKitItem>) => update(kit!.items.map((item, i) => i === index ? { ...item, ...patch } : item));
  const errors = kitErrors(config.kits);
  const types = config.vdrTypes.map(t => ({ value: t.code, label: `${t.code} — ${t.titleRu}` }));
  const milestones = config.deadlines.milestones.map(m => ({ value: m.code, label: m.label || m.code }));
  return <section aria-label="Комплекты документов" className="space-y-3">
    <p className="fx-note">Комплекты действуют только в этом проекте. Строки реестра создаются отдельным действием.</p>
    {error && <p role="alert" className="text-rose-700 dark:text-rose-400 text-xs">{error}</p>}
    <div className="flex flex-wrap gap-4">
      <div className="w-48 shrink-0" aria-label="Классы каталога">
        {classes.map(c => <button type="button" key={c.id} className="fx-li w-full text-left" aria-current={selected === c.id ? 'true' : undefined} onClick={() => setSelected(c.id)}>{c.title?.ru || c.code}{config.kits.some(k => k.classId === c.id) ? ' ·' : ''}</button>)}
        {config.kits.filter(k => !classes.some(c => c.id === k.classId)).map(k => <button type="button" key={k.classId} className="fx-li w-full text-left" aria-current={selected === k.classId ? 'true' : undefined} onClick={() => setSelected(k.classId)}>Недоступный класс: {k.classId || '—'}</button>)}
      </div>
      <div className="min-w-0 flex-1 space-y-3">
        {selected === null ? <p className="fx-note">Выберите класс каталога.</p> : <>
          <h3 className="fx-label">{classes.find(c => c.id === selected)?.title?.ru || selected}</h3>
          {(kit?.items || []).map((item, i) => <div key={i} className="border-b border-slate-200 dark:border-slate-700 pb-3 space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <label className="fx-field"><span className="fx-label">Тип документа</span><Select aria-label={`Тип документа ${i + 1}`} value={item.docType} disabled={disabled} onChange={docType => edit(i, { docType })} options={options(item.docType, [{ value: '', label: 'Выберите тип' }, ...types])} /></label>
              <label className="fx-field"><span className="fx-label">Стадия</span><Select aria-label={`Стадия ${i + 1}`} value={item.stage} disabled={disabled} onChange={stage => edit(i, { stage: stage as DocflowKitItem['stage'] })} options={[{ value: '', label: 'Обе' }, { value: 'П', label: 'П' }, { value: 'Р', label: 'Р' }]} /></label>
              <label className="fx-field"><span className="fx-label">Единица</span><Select aria-label={`Единица ${i + 1}`} value={item.unit} disabled={disabled} onChange={unit => edit(i, { unit: unit as DocflowKitItem['unit'] })} options={[{ value: 'tag', label: 'На тег' }, { value: 'group', label: 'На установку' }, { value: 'project', label: 'На проект' }]} /></label>
              <label className="fx-field"><span className="fx-label">Обязательность</span><Select aria-label={`Обязательность ${i + 1}`} value={item.necessity} disabled={disabled} onChange={necessity => edit(i, { necessity: necessity as DocflowKitItem['necessity'] })} options={[{ value: 'required', label: 'Обязательный' }, { value: 'customer', label: 'По требованию заказчика' }, { value: 'optional', label: 'Необязательный' }]} /></label>
              <label className="fx-field"><span className="fx-label">Ответственная должность</span><Select aria-label={`Должность ${i + 1}`} value={item.responsibleRole} disabled={disabled} onChange={responsibleRole => edit(i, { responsibleRole })} options={options(item.responsibleRole, [{ value: '', label: 'Не задана' }, ...roles.map(r => ({ value: r.code, label: r.name }))])} /></label>
              <label className="fx-field"><span className="fx-label">Веха</span><Select aria-label={`Веха ${i + 1}`} value={item.milestone} disabled={disabled} onChange={milestone => edit(i, { milestone })} options={options(item.milestone, [{ value: '', label: 'Не задана' }, ...milestones])} /></label>
              <label className="fx-field"><span className="fx-label">Рабочих дней</span><Input aria-label={`Рабочих дней ${i + 1}`} type="number" min={0} max={3650} value={Number.isNaN(item.workdays) ? '' : item.workdays} disabled={disabled} onChange={e => edit(i, { workdays: e.target.value === '' ? NaN : Number(e.target.value) })} /></label>
            </div>
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={item.condition !== null} disabled={disabled} onChange={e => edit(i, { condition: e.target.checked ? { parameter: '', operator: 'exists', value: '' } : null })} /> Условие по параметру</label>
            {item.condition && <div className="grid grid-cols-2 gap-2">
              <label className="fx-field"><span className="fx-label">Параметр</span><Input aria-label={`Параметр ${i + 1}`} placeholder="Группа||Параметр" value={item.condition.parameter} disabled={disabled} onChange={e => edit(i, { condition: { ...item.condition!, parameter: e.target.value } })} /><span className="fx-hint">Группа||Параметр</span></label>
              <label className="fx-field"><span className="fx-label">Условие</span><Select aria-label={`Условие ${i + 1}`} value={item.condition.operator} disabled={disabled} onChange={operator => edit(i, { condition: { ...item.condition!, operator: operator as NonNullable<DocflowKitItem['condition']>['operator'] } })} options={[{ value: 'exists', label: 'Задан' }, { value: 'equals', label: 'Равно' }, { value: 'notEquals', label: 'Не равно' }]} /></label>
              {item.condition.operator !== 'exists' && <label className="fx-field"><span className="fx-label">Значение</span><Input aria-label={`Значение ${i + 1}`} value={item.condition.value} disabled={disabled} onChange={e => edit(i, { condition: { ...item.condition!, value: e.target.value } })} /></label>}
            </div>}
            {!disabled && <Btn tone="ghost" aria-label={`Удалить документ ${i + 1}`} onClick={() => update(kit!.items.filter((_, j) => j !== i))}>Удалить</Btn>}
          </div>)}
          {!disabled && <Btn disabled={(kit?.items.length || 0) >= 100} onClick={() => update([...(kit?.items || []), emptyItem()])}>Добавить документ</Btn>}
          {!disabled && kit && <Btn tone="ghost" onClick={() => onChange(config.kits.filter(k => k.classId !== selected))}>Удалить комплект</Btn>}
        </>}
      </div>
    </div>
    {errors.length > 0 && <div role="alert" className="text-xs text-rose-700 dark:text-rose-400">{errors.map((message, i) => <p key={i}>{message}</p>)}</div>}
  </section>;
}
