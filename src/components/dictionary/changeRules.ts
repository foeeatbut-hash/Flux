/**
 * Правила «что изменилось» для пункта справочника: только то, что человек видит в строке.
 *
 * Пункт — это код, название и родитель; идентификатор, номер версии и справочник в
 * перечень не входят. Две особенности экрана:
 *   - у категорий «Дополнительных параметров» и «Маркировки» код служебный («001_ab12»:
 *     порядковый номер и идентификатор), человеку его не показывают, а видит он место
 *     в списке. Поэтому там вместо «Кода» — «Порядок» (`hideCode`);
 *   - родитель в записи — идентификатор, а в строке — имя родителя: имя подставляет
 *     `DictNames`, его собирает экран из загруженных справочников.
 *
 * Без React и без сети: наборы гоняют это на голых объектах.
 */
import { changesBetween, type ChangeRule, type FieldChange } from '../../lib/recordChanges';

export interface DictNames {
  /** Имя родителя вместо идентификатора; нет имени — остаётся идентификатор */
  parent?: (id: string) => string | undefined;
  /** Код пункта человеку не показывается: вместо него — порядок в списке */
  hideCode?: boolean;
}

const text = (v: unknown): string => String(v ?? '').trim();

/** Порядковый номер из служебного кода «002_ab12» → «2»; кода другого вида — пусто */
export function orderOf(code: unknown): string {
  const m = /^(\d+)_/.exec(text(code));
  return m ? String(Number(m[1])) : '';
}

export function dictRules(names: DictNames = {}): ChangeRule[] {
  const rules: ChangeRule[] = names.hideCode
    ? [{ label: 'Порядок', value: (r) => orderOf(r.code) }]
    : [{ label: 'Код', value: (r) => r.code }];
  rules.push(
    { label: 'Название', value: (r) => r.nameRu },
    { label: 'Родитель', value: (r) => { const p = text(r.parentId); return p ? names.parent?.(p) || p : ''; } },
  );
  return rules;
}

/** Перечень изменений пункта; `shown` — копия, какой её видел экран в момент правки, `current` — запись из отказа. */
export function dictChanges(shown: unknown, current: unknown, names: DictNames = {}): FieldChange[] {
  return changesBetween(shown, current, dictRules(names));
}

/** Имена родителей из загруженных справочников: «код (название)», а у служебных кодов — только название. */
export function dictNamesOf(dictionaries: any[], hideCode = false): DictNames {
  return {
    hideCode,
    parent: (id) => {
      for (const d of dictionaries || []) {
        const item = (d?.items || []).find((i: any) => i.id === id);
        if (item) return hideCode ? text(item.nameRu) || undefined : `${text(item.code)} (${text(item.nameRu)})`;
      }
      return undefined;
    },
  };
}
