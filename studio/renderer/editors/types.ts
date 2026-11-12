/**
 * Типы черновика программы для редакторов Studio.
 *
 * Форма — тот же form.json, что читает и рисует Flux (modules/runtime/form.ts, схема —
 * modules/formSchema.ts): единица, пояснение и условие показа исполняются во Flux так же, как в
 * предпросмотре Studio.
 */
import type { Resource } from '../../../modules/contract';

export type { Resource };

/** Условие показа: поле или таблица видны, пока привязка `bind` удовлетворяет условию */
export interface FormVisibility {
  bind: string;
  op: 'eq' | 'ne' | 'filled' | 'empty';
  value?: string;
}

export interface FormField {
  label: string;
  bind: string;
  kind?: 'code';
  /** Единица измерения, показывается после значения */
  unit?: string;
  /** Одно предложение, и только там, где без него ошибутся */
  hint?: string;
  visibleIf?: FormVisibility;
}

export interface FormColumn { label: string; key: string; align?: 'end'; unit?: string }
export interface FormGroup { title: string; fields: FormField[]; visibleIf?: FormVisibility }
export interface FormTable { title: string; bind: string; columns: FormColumn[]; visibleIf?: FormVisibility }

export interface FormDef {
  version: 1;
  onDataChanged?: string;
  groups: FormGroup[];
  tables: FormTable[];
}

export type CodeLanguage = 'typescript' | 'javascript' | 'python' | 'rust' | 'cpp' | 'c' | 'go' | 'csharp';
export interface CodeFile { path: string; language: CodeLanguage; text: string }

export type ValueType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array';
/** Значение, которое программа отдаёт (calc.out.*) или хранит (state.*) */
export interface ContractValue { name: string; type: ValueType; /** Для списка: тип элемента */ items?: ValueType; unit?: string; description?: string }

/** Договор программы: что она читает у Flux и что кладёт в state и calc.out */
export interface ContractDraft {
  version: 1;
  reads: Resource[];
  state: ContractValue[];
  outputs: ContractValue[];
}

export interface ModuleDraft {
  form: FormDef;
  code: CodeFile[];
  contract: ContractDraft;
}

/** Результат любой проверки: что не так, где и по какому правилу */
export interface Finding {
  rule: string;
  severity: 'error' | 'warning';
  /** Путь внутри формы: groups[0].fields[1].label */
  path: string;
  message: string;
  /** Раздел методологии, откуда правило */
  source?: string;
}
