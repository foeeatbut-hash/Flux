/**
 * Типы черновика подпрограммы для редакторов Studio.
 *
 * Форма — тот же form.json, что читает Flux (modules/runtime/form.ts), плюс необязательные поля
 * описания ввода (единицы, допустимые значения, обязательность, условие видимости). Лишние для
 * Flux поля не мешают: modules/validateForm.ts их не отвергает, а прежние формы остаются верными.
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
  /** Допустимые значения: ввод вне списка отклоняется */
  allowed?: string[];
  /** Для числового ввода: границы включительно */
  min?: number;
  max?: number;
  required?: boolean;
  /** Пример значения в пустом поле («AHU-01»), а не повтор подписи */
  placeholder?: string;
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
/** Значение, которое подпрограмма отдаёт (calc.out.*) или хранит (state.*) */
export interface ContractValue { name: string; type: ValueType; unit?: string; description?: string }

/** Договор подпрограммы: что она читает у Flux и что кладёт в state и calc.out */
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

export interface EditorProps {
  moduleId: string;
  draft: ModuleDraft;
  onChange: (draft: ModuleDraft) => void;
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
