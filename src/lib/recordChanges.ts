/**
 * Что изменилось в записи, пока человек её правил: перечень «Поле: было → стало».
 *
 * Зачем на клиенте. Сервер знает только номер версии и не знает, что именно
 * показывал экран. Поэтому сравнивает клиент: запись, какой её показывал экран
 * в момент действия, против текущей записи из отказа. Сравниваются только
 * поля, которые человек видит, — их перечисляют правила программы (для
 * оборудования — `components/equipment/changeRules.ts`); служебные поля (id,
 * даты, номер версии) в правила не входят и в перечень не попадают.
 *
 * Модуль без React и без сети: наборы гоняют его на голых объектах.
 */

/** Правило одного показанного поля записи. Ровно одно из двух: `value` или `rows`. */
export interface ChangeRule<R = any> {
  /** Подпись поля; у `rows` — запасная, строки подписывают себя сами */
  label: string;
  /** Простое значение поля */
  value?: (record: R) => unknown;
  /** Поле, которое надо развернуть в несколько строк (характеристики из JSON, теги): подпись → значение */
  rows?: (record: R) => Array<{ label: string; value: unknown }>;
}

export interface FieldChange { label: string; was: string; now: string }

/** Пусто для человека — прочерк: «было — → стало 5» читается лучше, чем пустая строка. */
export const EMPTY_SHOWN = '—';

/** Значение строкой для показа: пустое — «—», да/нет вместо true/false, список — через запятую. */
export function shownValue(value: unknown): string {
  if (value === null || value === undefined) return EMPTY_SHOWN;
  if (typeof value === 'boolean') return value ? 'да' : 'нет';
  if (Array.isArray(value)) return value.length ? value.map(shownValue).join(', ') : EMPTY_SHOWN;
  const text = String(value).trim();
  return text === '' ? EMPTY_SHOWN : text;
}

/**
 * Изменения между записью, которую показывал экран, и текущей записью.
 * Порядок — как в правилах; у развёрнутых строк — сначала строки, бывшие на экране,
 * затем появившиеся. Нет одной из записей — сравнивать нечего, перечень пуст.
 */
export function changesBetween(shown: unknown, current: unknown, rules: ChangeRule[]): FieldChange[] {
  if (!shown || !current || typeof shown !== 'object' || typeof current !== 'object') return [];
  const out: FieldChange[] = [];
  for (const rule of rules) {
    if (rule.rows) {
      const was = new Map(rule.rows(shown).map((r) => [r.label, shownValue(r.value)]));
      const now = new Map(rule.rows(current).map((r) => [r.label, shownValue(r.value)]));
      for (const label of new Set([...was.keys(), ...now.keys()])) {
        const a = was.get(label) ?? EMPTY_SHOWN;
        const b = now.get(label) ?? EMPTY_SHOWN;
        if (a !== b) out.push({ label, was: a, now: b });
      }
    } else if (rule.value) {
      const a = shownValue(rule.value(shown));
      const b = shownValue(rule.value(current));
      if (a !== b) out.push({ label: rule.label, was: a, now: b });
    }
  }
  return out;
}
