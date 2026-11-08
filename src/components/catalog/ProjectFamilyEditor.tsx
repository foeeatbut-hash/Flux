import React, { useState } from 'react';
import { textOf, type Catalog, type Family, type ParamDef, type SpecDefault } from '../../../catalog/model';

export function ProjectFamilyEditor({ catalog, initial, onCancel, onSave }: { catalog: Catalog; initial: Family; onCancel: () => void; onSave: (value: Family) => void }) {
  const [family, setFamily] = useState<Family>(() => structuredClone(initial));
  const field = (label: string, value: string, update: (value: string) => void) => <label className="fx-field"><span className="fx-label">{label}</span><input className="fx-input" value={value} onChange={event => update(event.target.value)} /></label>;
  const setParam = (index: number, value: ParamDef) => setFamily({ ...family, params: family.params.map((item, i) => i === index ? value : item) });
  const setSpec = (index: number, value: SpecDefault) => setFamily({ ...family, specs: family.specs.map((item, i) => i === index ? value : item) });
  return <div className="flex h-full min-h-0 flex-col" style={{ '--flux-control-h': '32px' } as React.CSSProperties}><div className="fx-head"><span className="fx-head-title">{initial.code ? 'Изменить позицию' : 'Своя позиция'}</span></div>
    <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
      <div className="grid grid-cols-2 gap-3">
        {field('Код', family.code, code => setFamily({ ...family, code }))}
        {field('Название', textOf(family.title), value => setFamily({ ...family, title: { ...family.title, ru: value } }))}
        {field('Наименование типа', textOf(family.typeLabel), value => setFamily({ ...family, typeLabel: { ...family.typeLabel, ru: value } }))}
        <label className="fx-field"><span className="fx-label">Класс оборудования</span><select className="fx-input" value={family.classId} onChange={event => setFamily({ ...family, classId: event.target.value, typeLabel: textOf(family.typeLabel) ? family.typeLabel : catalog.classes.find(item => item.id === event.target.value)?.itemName || family.typeLabel })}><option value="">Выберите класс</option>{catalog.classes.map(item => <option key={item.id} value={item.id}>{textOf(item.title)}</option>)}</select></label>
        <label className="fx-field"><span className="fx-label">Изготовитель</span><select className="fx-input" value={family.manufacturerId} onChange={event => setFamily({ ...family, manufacturerId: event.target.value })}><option value="">Выберите изготовителя</option>{catalog.manufacturers.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      </div>
      <div><div className="flex items-center justify-between"><h3 className="fx-group-title">Параметры</h3><button className="fx-btn fx-btn-sm" onClick={() => setFamily({ ...family, params: [...family.params, { key: '', label: { ru: '' }, kind: 'text' }] })}>Добавить параметр</button></div>
        {family.params.map((param, i) => <div key={i} className="grid grid-cols-[1fr_1fr_110px_80px_auto] items-end gap-2 py-2">
          {field('Ключ', param.key, key => setParam(i, { ...param, key }))}{field('Название', textOf(param.label), value => setParam(i, { ...param, label: { ...param.label, ru: value } }))}
          <label className="fx-field"><span className="fx-label">Тип</span><select aria-label="Тип" className="fx-input" value={param.kind} onChange={event => setParam(i, { ...param, kind: event.target.value as ParamDef['kind'] })}><option value="text">Текст</option><option value="number">Число</option><option value="choice">Выбор</option></select></label>
          {field('Ед.', param.unit || '', unit => setParam(i, { ...param, unit }))}<button className="fx-btn fx-btn-sm" onClick={() => setFamily({ ...family, params: family.params.filter((_, n) => n !== i) })} aria-label={`Удалить параметр ${param.key || i + 1}`}>Удалить</button>
          <div className="col-span-full">{field('По умолчанию', String(param.default ?? ''), value => setParam(i, { ...param, default: value === '' ? undefined : value }))}</div>
          {param.kind === 'choice' && <label className="fx-field col-span-full"><span className="fx-label">Варианты через запятую</span><input className="fx-input" defaultValue={(param.values || []).map(value => value.code).join(', ')} onBlur={event => setParam(i, { ...param, values: event.target.value.split(',').map(code => code.trim()).filter(Boolean).map(code => param.values?.find(item => item.code === code) || { code, label: { ru: code } }) })} /></label>}
        </div>)}
      </div>
      <div><div className="flex items-center justify-between"><h3 className="fx-group-title">Характеристики</h3><button className="fx-btn fx-btn-sm" onClick={() => setFamily({ ...family, specs: [...family.specs, { key: '', label: { ru: '' }, value: { ru: '' } }] })}>Добавить характеристику</button></div>
        {family.specs.map((spec, i) => <div key={i} className="grid grid-cols-[1fr_1fr_1fr_80px_auto] items-end gap-2 py-2">
          {field('Ключ', spec.key, key => setSpec(i, { ...spec, key }))}{field('Название', textOf(spec.label), value => setSpec(i, { ...spec, label: { ...spec.label, ru: value } }))}{field('Значение', textOf(spec.value), value => setSpec(i, { ...spec, value: { ...spec.value, ru: value } }))}{field('Ед.', spec.unit || '', unit => setSpec(i, { ...spec, unit }))}
          <button className="fx-btn fx-btn-sm" onClick={() => setFamily({ ...family, specs: family.specs.filter((_, n) => n !== i) })} aria-label={`Удалить характеристику ${spec.key || i + 1}`}>Удалить</button>
        </div>)}
      </div>
    </div><div className="flex justify-end gap-2 border-t border-[var(--flux-line)] p-3"><button className="fx-btn" onClick={onCancel}>Отмена</button><button className="fx-btn fx-btn-primary" disabled={!family.code.trim() || !textOf(family.title).trim() || !textOf(family.typeLabel).trim() || !family.classId || !family.manufacturerId || family.params.some(p => !p.key.trim() || !textOf(p.label).trim()) || family.specs.some(s => !s.key.trim() || !textOf(s.label).trim())} onClick={() => onSave({ ...family, params: family.params.map(param => param.kind === 'number' && param.default !== undefined && param.default !== '' ? { ...param, default: Number(param.default) } : param) })}>Предпросмотр</button></div>
  </div>;
}
