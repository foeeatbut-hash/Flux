import React from 'react';
import type { CatalogSection } from '../../../catalog/model';
import { Btn, Field, Input, Select } from './ui';

export default function CatalogSectionEditor({ sections, onChange, readOnly }: {
  sections: CatalogSection[]; onChange: (sections: CatalogSection[]) => void; readOnly?: boolean;
}) {
  const update = (id: string, patch: Partial<CatalogSection>) => onChange(sections.map(section => section.id === id ? { ...section, ...patch } : section));
  return <section className="space-y-2">
    <div className="flex items-center gap-2"><h3 className="text-xs font-medium">Содержание справочника · {sections.length} разделов</h3>
      {!readOnly && <Btn className="ml-auto" onClick={() => onChange([...sections, { id: `section-${Date.now().toString(36)}`, title: 'Новый раздел', text: '', kind: 'description', source: { file: '' } }])}>Добавить раздел</Btn>}
    </div>
    {sections.map(section => <details key={section.id} className="border-b border-slate-200 py-2 dark:border-slate-700"><summary className="cursor-pointer text-xs">{section.title}</summary><div className="mt-2 space-y-2">
      <Field label="Название"><Input value={section.title} onChange={event => update(section.id, { title: event.target.value })} disabled={readOnly} /></Field>
      <Field label="Содержание"><textarea value={section.text} onChange={event => update(section.id, { text: event.target.value })} disabled={readOnly} rows={8} className="fx-input w-full text-xs" /></Field>
      <Field label="Раздел"><Select value={section.kind} onChange={value => update(section.id, { kind: value as CatalogSection['kind'] })} disabled={readOnly} options={[
        { value: 'description', label: 'Описание' }, { value: 'dimensions', label: 'Размеры' }, { value: 'selection', label: 'Подбор' }, { value: 'marking', label: 'Маркировка' }, { value: 'installation', label: 'Монтаж' }, { value: 'wiring', label: 'Подключение' }, { value: 'general', label: 'Общие сведения' },
      ]} /></Field>
      <p className="text-xs text-slate-500 dark:text-slate-400">Для проверки: {section.source.file || 'ручной ввод'}{section.source.physicalPage ? ` · физ. страница ${section.source.physicalPage}` : ''}</p>
      {!readOnly && <Btn tone="danger" onClick={() => onChange(sections.filter(item => item.id !== section.id))}>Удалить раздел</Btn>}
    </div></details>)}
  </section>;
}
