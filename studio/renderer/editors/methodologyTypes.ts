/** Выписка из docs/methodology/01-design.md; наполняет её scripts/gen-studio-editor-methodology.ts */
export interface MethodologyExtract {
  source: string;
  /** Таблица раздела 5: что, класс, компонент */
  components: Array<{ what: string; cls: string; component: string }>;
  /** Подразделы раздела 5 по названию: пункты и абзацы */
  sections: Record<string, string[]>;
  /** Абзац после таблицы раздела 5 про числа и коды */
  fontRule: string;
  /** Таблица высот раздела 1 */
  heights: Array<{ element: string; height: string; note: string }>;
  /** Допустимые отступы раздела 1 */
  spacing: number[];
  textRules: string[];
  checklist: string[];
}
