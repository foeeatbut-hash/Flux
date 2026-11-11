/**
 * Договор подпрограммы: что она читает у Flux, какие значения хранит (state) и отдаёт (calc.out).
 * Отсюда берутся список привязок формы, типы для кода и проверка при выпуске.
 */
import React from 'react';
import { resources } from '../../../modules/contract';
import { Check } from './controls';
import type { ContractDraft, ContractValue, Resource, ValueType } from './types';

const RESOURCE_NAMES: Record<Resource, string> = { project: 'Проект', equipment: 'Оборудование', tag: 'Тег', specification: 'Спецификация', catalog: 'Каталог' };
const TYPES: Array<[ValueType, string]> = [['string', 'Строка'], ['number', 'Число'], ['integer', 'Целое'], ['boolean', 'Да или нет'], ['object', 'Объект'], ['array', 'Список']];

function Values({ title, hint, values, onChange, id }: { title: string; hint: string; values: ContractValue[]; onChange: (values: ContractValue[]) => void; id: string }) {
  const set = (index: number, patch: Partial<ContractValue>) => onChange(values.map((value, i) => i === index ? { ...value, ...patch } : value));
  return (
    <section aria-label={title} data-testid={`values-${id}`}>
      <h3 className="ed-title">{title}</h3>
      <p className="ed-hint">{hint}</p>
      {values.length > 0 && (
        <table className="ed-vals">
          <thead><tr><th>Имя</th><th>Тип</th><th>Единица</th><th>Описание</th><th /></tr></thead>
          <tbody>
            {values.map((value, i) => (
              <tr key={i}>
                <td><input className="ed-input" aria-label={`${title}: имя ${i + 1}`} value={value.name} spellCheck={false} onChange={event => set(i, { name: event.target.value.replace(/[^A-Za-z0-9_$]/g, '') })} /></td>
                <td>
                  <select className="ed-input" aria-label={`${title}: тип ${value.name || i + 1}`} value={value.type} onChange={event => set(i, { type: event.target.value as ValueType })}>
                    {TYPES.map(([key, text]) => <option key={key} value={key}>{text}</option>)}
                  </select>
                </td>
                <td><input className="ed-input" aria-label={`${title}: единица ${value.name || i + 1}`} value={value.unit ?? ''} onChange={event => set(i, { unit: event.target.value || undefined })} /></td>
                <td><input className="ed-input" aria-label={`${title}: описание ${value.name || i + 1}`} value={value.description ?? ''} onChange={event => set(i, { description: event.target.value || undefined })} /></td>
                <td><button type="button" className="ed-btn is-danger" aria-label={`Удалить ${value.name || i + 1}`} onClick={() => onChange(values.filter((_, at) => at !== i))}>Удалить</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="ed-actions"><button type="button" className="ed-btn" onClick={() => onChange([...values, { name: '', type: 'string' }])}>Добавить значение</button></div>
    </section>
  );
}

export function ContractEditor({ contract, onChange }: { contract: ContractDraft; onChange: (contract: ContractDraft) => void }) {
  return (
    <div className="ed-contract" data-testid="contract-editor">
      <section aria-label="Что читает подпрограмма">
        <h3 className="ed-title">Что читает подпрограмма</h3>
        <p className="ed-hint">Только отмеченное. Остальные данные Flux подпрограмма не получит, а привязка к ним не пройдёт проверку.</p>
        <div className="ed-checks">
          {resources.map(resource => (
            <Check key={resource} label={RESOURCE_NAMES[resource]} checked={contract.reads.includes(resource)}
              onChange={on => onChange({ ...contract, reads: resources.filter(name => name === resource ? on : contract.reads.includes(name)) })} />
          ))}
        </div>
      </section>
      <Values id="state" title="Своё состояние (state)" hint="Ввод пользователя в окне подпрограммы. Во Flux не записывается." values={contract.state} onChange={state => onChange({ ...contract, state })} />
      <Values id="outputs" title="Результат расчёта (calc.out)" hint="Значения, которые код отдаёт форме." values={contract.outputs} onChange={outputs => onChange({ ...contract, outputs })} />
    </div>
  );
}
