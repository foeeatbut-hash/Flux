/** Размещение результата переводчика в Word и Таблице. */

export type TranslationApp = 'docs' | 'sheets';
export type TranslationScope = 'document' | 'sheet' | 'selection' | 'header';
export type TranslationMode =
  | 'new-file' | 'new-page' | 'after-paragraph' | 'inline-before' | 'inline-after' | 'replace'
  | 'new-sheet' | 'adjacent-column' | 'adjacent-row';
export type TranslationSeparator = 'newline' | 'slash' | 'dash' | 'pipe' | 'custom';
export type TranslationOrder = 'source-first' | 'target-first';
export type TranslationLangDirection = 'ru-en' | 'en-ru';

export interface OfficeTranslationRecord {
  sourceId: string; key: string; destination: string; revision: string; time: number;
  mode: string; scope: TranslationScope; targetLocation: Record<string, unknown>; targetText: string; sourceText: string;
}

export interface TranslationPlacementOptions {
  mode: TranslationMode;
  scope: TranslationScope;
  separator: TranslationSeparator;
  customSeparator: string;
  order: TranslationOrder;
  sourceRevision: string;
}

export interface TranslationPlacementPayload {
  mode: TranslationMode;
  scope: TranslationScope;
  separator: 'newline' | 'custom';
  customSeparator?: string;
  order: TranslationOrder;
  sourceRevision: string;
}

export const TRANSLATION_MODES: Record<TranslationApp, Array<{ value: TranslationMode; label: string }>> = {
  sheets: [
    { value: 'new-sheet', label: 'Новый лист' },
    { value: 'new-file', label: 'Новый файл' },
    { value: 'adjacent-column', label: 'Соседний столбец' },
    { value: 'adjacent-row', label: 'Строка под оригиналом' },
    { value: 'inline-after', label: 'В той же ячейке через разделитель' },
    { value: 'replace', label: 'Заменить с резервной копией' },
  ],
  docs: [
    { value: 'new-file', label: 'Новый DOCX' },
    { value: 'new-page', label: 'Новая страница' },
    { value: 'after-paragraph', label: 'После абзаца' },
    { value: 'inline-after', label: 'Внутри строки или таблицы' },
    { value: 'replace', label: 'Заменить с резервной копией' },
  ],
};

const SEPARATOR_TEXT: Record<Exclude<TranslationSeparator, 'custom'>, string> = {
  newline: '\n', slash: '/', dash: '—', pipe: '|',
};

export function separatorValue(kind: TranslationSeparator, custom: string): string {
  return kind === 'custom' ? String(custom).slice(0, 30) : SEPARATOR_TEXT[kind];
}

/** Переключатель порядка должен совпадать с расположением оригинала и перевода. */
export function orderedMode(mode: TranslationMode, order: TranslationOrder): TranslationMode {
  if (mode !== 'inline-before' && mode !== 'inline-after') return mode;
  return order === 'target-first' ? 'inline-before' : 'inline-after';
}

/** Каноническая форма команды редактора; специальные разделители остаются буквальными. */
export function toRuntimePlacement(options: TranslationPlacementOptions): TranslationPlacementPayload {
  const customSeparator = separatorValue(options.separator, options.customSeparator);
  return {
    mode: orderedMode(options.mode, options.order),
    scope: options.scope,
    separator: options.separator === 'newline' ? 'newline' : 'custom',
    ...(options.separator === 'newline' ? {} : { customSeparator }),
    order: options.order,
    sourceRevision: options.sourceRevision,
  };
}

export function allowedScopes(app: TranslationApp): TranslationScope[] {
  return app === 'sheets' ? ['document', 'sheet', 'selection', 'header'] : ['document', 'selection', 'header'];
}

export function scopeLabel(scope: TranslationScope): string {
  return ({ document: 'Весь документ', sheet: 'Лист', selection: 'Выделение', header: 'Шапка' })[scope];
}
