/**
 * Свойства выбранного компонента формы: подпись, единицы, допустимые значения, обязательность,
 * привязка к входу или выходу договора, условие показа и проверка ввода на примере.
 */
import React from 'react';
import { columnKeys, bindingOptions, type BindingOption } from './contractModel';
import { itemAt, type Selection } from './formModel';
import { Check, SelectField, TextField } from './controls';
import type { ContractDraft, Finding, FormColumn, FormDef, FormField, FormGroup, FormTable, FormVisibility } from './types';

const KIND_LABEL: Record<BindingOption['kind'], string> = { input: 'Данные Flux (вход)', output: 'Результат расчёта (выход)', state: 'Своё состояние' };

function BindSelect({ label, value, options, onChange, hint, error }: { label: string; value: string; options: BindingOption[]; onChange: (value: string) => void; hint?: string; error?: string }) {
  const known = options.some(option => option.path === value);
  return (
    <SelectField label={label} value={value} onChange={onChange} hint={hint} error={error}>
      <option value="">— не выбрано —</option>
      {!known && value && <option value={value}>{value} (нет в договоре)</option>}
      {(['input', 'output', 'state'] as const).map(kind => {
        const group = options.filter(option => option.kind === kind);
        return group.length ? (
          <optgroup key={kind} label={KIND_LABEL[kind]}>
            {group.map(option => <option key={option.path} value={option.path}>{option.path}{option.unit ? `, ${option.unit}` : ''}</option>)}
          </optgroup>
        ) : null;
      })}
    </SelectField>
  );
}

const OPS: Array<[string, string]> = [['', 'Всегда'], ['filled', 'Когда заполнено'], ['empty', 'Когда пусто'], ['eq', 'Когда равно'], ['ne', 'Когда не равно']];

function Visibility({ rule, options, onChange }: { rule?: FormVisibility; options: BindingOption[]; onChange: (rule: FormVisibility | undefined) => void }) {
  return (
    <>
      <h4 className="ed-section">Условие показа</h4>
      <SelectField label="Показывать" value={rule?.op ?? ''} onChange={op => onChange(op ? { bind: rule?.bind ?? '', op: op as FormVisibility['op'], ...(op === 'eq' || op === 'ne' ? { value: rule?.value ?? '' } : {}) } : undefined)}>
        {OPS.map(([key, text]) => <option key={key} value={key}>{text}</option>)}
      </SelectField>
      {rule && <BindSelect label="Если значение" value={rule.bind} options={options.filter(option => option.type !== 'array')} onChange={bind => onChange({ ...rule, bind })} />}
      {rule && (rule.op === 'eq' || rule.op === 'ne') && <TextField label="Значение для сравнения" value={rule.value ?? ''} onChange={value => onChange({ ...rule, value })} />}
    </>
  );
}

interface Props {
  form: FormDef;
  selection: Selection;
  contract: ContractDraft;
  patch: (change: Record<string, unknown>) => void;
  messages: string[];
  findings: Finding[];
}

export function FormProps({ form, selection, contract, patch, messages, findings }: Props) {
  const item = itemAt(form, selection);
  const options = bindingOptions(contract);
  const scalar = options.filter(option => option.type !== 'array' && option.type !== 'object');
  let body: React.ReactNode = null;

  if (selection.kind === 'form') {
    body = <TextField label="Обработчик «данные изменились»" value={form.onDataChanged ?? ''} onChange={value => patch({ onDataChanged: value })} placeholder="recalc" mono hint="Имя функции из кода: она вызывается, когда данные Flux изменились." />;
  } else if (item && selection.kind === 'group') {
    const group = item as FormGroup;
    body = (
      <>
        <TextField label="Заголовок группы" value={group.title} onChange={value => patch({ title: value })} />
        <Visibility rule={group.visibleIf} options={options} onChange={rule => patch({ visibleIf: rule })} />
      </>
    );
  } else if (item && selection.kind === 'field') {
    const field = item as FormField;
    body = (
      <>
        <TextField label="Подпись" value={field.label} onChange={value => patch({ label: value })} hint="Подпись говорит, что будет: «Расход воздуха», а не «Параметр 1»." />
        <BindSelect label="Привязка" value={field.bind} options={scalar} onChange={value => patch({ bind: value })} hint="Откуда берётся значение: вход договора, выход расчёта или своё состояние." />
        <Check label="Код (моноширинный шрифт)" checked={field.kind === 'code'} onChange={value => patch({ kind: value ? 'code' : undefined })} />
        <TextField label="Единица" value={field.unit ?? ''} onChange={value => patch({ unit: value })} placeholder="м³/ч" />
        <TextField label="Пояснение" value={field.hint ?? ''} onChange={value => patch({ hint: value })} hint="Одно предложение под полем, и только там, где без него ошибутся." />
        <Visibility rule={field.visibleIf} options={options} onChange={rule => patch({ visibleIf: rule })} />
      </>
    );
  } else if (item && selection.kind === 'table') {
    const table = item as FormTable;
    const missing = columnKeys(table.bind, contract).filter(key => !table.columns.some(column => column.key === key));
    body = (
      <>
        <TextField label="Заголовок таблицы" value={table.title} onChange={value => patch({ title: value })} />
        <BindSelect label="Список" value={table.bind} options={options.filter(option => option.type === 'array' && option.path.startsWith('flux.'))} onChange={value => patch({ bind: value })} hint="Таблица показывает строки списка из данных Flux; state и calc.out в таблицу не выводятся." />
        <button type="button" className="ed-btn" disabled={!missing.length}
          onClick={() => patch({ columns: [...table.columns, ...missing.map(key => ({ label: key, key }))] })}>Добавить все колонки списка</button>
        <Visibility rule={table.visibleIf} options={options} onChange={rule => patch({ visibleIf: rule })} />
      </>
    );
  } else if (item && selection.kind === 'column') {
    const column = item as FormColumn;
    const table = form.tables[selection.t];
    const keys = columnKeys(table.bind, contract);
    body = (
      <>
        <TextField label="Подпись колонки" value={column.label} onChange={value => patch({ label: value })} />
        <SelectField label="Поле списка" value={column.key} onChange={value => patch({ key: value })}>
          <option value="">— не выбрано —</option>
          {!keys.includes(column.key) && column.key && <option value={column.key}>{column.key} (нет в списке)</option>}
          {keys.map(key => <option key={key} value={key}>{key}</option>)}
        </SelectField>
        <TextField label="Единица" value={column.unit ?? ''} onChange={value => patch({ unit: value })} placeholder="кВт" />
        <Check label="Числа по правому краю" checked={column.align === 'end'} onChange={value => patch({ align: value ? 'end' : undefined })} />
      </>
    );
  }

  return (
    <div className="ed-props" data-testid="props">
      {body ?? <p className="ed-muted">Выберите компонент в структуре формы.</p>}
      {(messages.length > 0 || findings.length > 0) && (
        <>
          <h4 className="ed-section">Замечания</h4>
          <ul className="ed-findings" data-testid="item-findings">
            {messages.map((message, i) => <li key={`m${i}`} className="is-error">{message}</li>)}
            {findings.map((finding, i) => (
              <li key={`f${i}`} className={`is-${finding.severity}`}>{finding.message}<span className="ed-src">{finding.source}</span></li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
