/**
 * Один источник истины для формы: текст form.json и разобранная форма.
 *
 * Правка в визуальном редакторе переписывает текст, правка текста обновляет форму — но только
 * если текст прошёл разбор и схему. Иначе `form` остаётся последней верной, а ошибки лежат в
 * `problems` с номерами строк: незаконченная правка в тексте не стирает собранное мышью.
 */
import { bindingProblems, structureProblems, type FormDiagnostic } from './formSchema';
import { serializeForm } from './formModel';
import type { ContractDraft, FormDef } from './types';

export interface FormState {
  text: string;
  /** Последняя верная форма — именно её видят визуальный редактор, предпросмотр и проверки */
  form: FormDef;
  /** Совпадает ли текст с `form`: false, пока в тексте ошибка */
  textValid: boolean;
  /** Ошибки разбора и схемы текущего текста */
  problems: FormDiagnostic[];
  /** Привязки, которых нет в описании данных; считаются только по верному тексту */
  bindings: FormDiagnostic[];
}

export function formStateFromForm(form: FormDef, contract: ContractDraft): FormState {
  const text = serializeForm(form);
  return { text, form, textValid: true, problems: [], bindings: bindingProblems(text, form, contract) };
}

/** Состояние по тексту form.json из проекта: при ошибке форма пуста, текст сохранён, правка визуально заблокирована */
export function formStateFromText(text: string, contract: ContractDraft): FormState {
  const base = formStateFromForm({ version: 1, groups: [], tables: [] }, contract);
  return applyText(base, text, contract);
}

export function applyText(state: FormState, text: string, contract: ContractDraft): FormState {
  const { value, problems } = structureProblems(text);
  if (!value) return { ...state, text, textValid: false, problems, bindings: [] };
  return { text, form: value, textValid: true, problems: [], bindings: bindingProblems(text, value, contract) };
}

export function applyForm(state: FormState, form: FormDef, contract: ContractDraft): FormState {
  return formStateFromForm(form, contract);
}

/** Договор изменился: привязки проверяются заново, текст не трогаем */
export function recheck(state: FormState, contract: ContractDraft): FormState {
  return state.textValid ? { ...state, bindings: bindingProblems(state.text, state.form, contract) } : state;
}
