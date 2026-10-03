/** Контекст обращения о неточности данных каталога. */
export interface CatalogDataIssueContext {
  program: 'catalog' | 'equipment' | 'builder';
  entityId: string;
  entityTitle: string;
  field?: string;
  currentValue?: string;
  revision?: string;
  source?: { file: string; pages?: string; edition?: string };
}

export interface CatalogDataIssue {
  namespace: 'catalogDataIssue';
  context: CatalogDataIssueContext;
  proposedValue?: string;
  sourceText?: string;
}

/** Проверка пригодна и форме, и серверу; она отсекает неизвестные поля. */
export function validateCatalogDataIssue(raw: unknown): { ok: boolean; value?: CatalogDataIssue; error?: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'Контекст неточности: ожидался объект' };
  const value = raw as Record<string, any>;
  if (Object.keys(value).some((key) => !['namespace', 'context', 'proposedValue', 'sourceText'].includes(key))) {
    return { ok: false, error: 'В контексте неточности есть неизвестные поля' };
  }
  if (value.namespace !== 'catalogDataIssue') return { ok: false, error: 'Неизвестный вид контекста обращения' };
  const context = value.context;
  if (!context || typeof context !== 'object' || Array.isArray(context)) return { ok: false, error: 'Контекст неточности обязателен' };
  if (Object.keys(context).some((key) => !['program', 'entityId', 'entityTitle', 'field', 'currentValue', 'revision', 'source'].includes(key))) {
    return { ok: false, error: 'В контексте элемента есть неизвестные поля' };
  }
  const programs = ['catalog', 'equipment', 'builder'];
  if (!programs.includes(context.program)) return { ok: false, error: 'Неизвестный раздел каталога' };
  if (typeof context.entityId !== 'string' || !context.entityId.trim() || context.entityId.length > 200) {
    return { ok: false, error: 'Идентификатор элемента обязателен и не длиннее 200 знаков' };
  }
  if (typeof context.entityTitle !== 'string' || !context.entityTitle.trim() || context.entityTitle.length > 400) {
    return { ok: false, error: 'Название элемента обязательно и не длиннее 400 знаков' };
  }
  const bounds: Array<[string, unknown, number]> = [
    ['field', context.field, 200], ['currentValue', context.currentValue, 4000], ['revision', context.revision, 200],
  ];
  for (const [name, text, max] of bounds) {
    if (text !== undefined && (typeof text !== 'string' || text.length > max)) return { ok: false, error: `Поле ${name} не длиннее ${max} знаков` };
  }
  let source: CatalogDataIssueContext['source'];
  if (context.source !== undefined) {
    const rawSource = context.source;
    if (!rawSource || typeof rawSource !== 'object' || Array.isArray(rawSource)
        || typeof rawSource.file !== 'string' || !rawSource.file.trim() || rawSource.file.length > 1000) {
      return { ok: false, error: 'В источнике обязателен файл длиной до 1000 знаков' };
    }
    if (Object.keys(rawSource).some((key) => !['file', 'pages', 'edition'].includes(key))) {
      return { ok: false, error: 'В источнике есть неизвестные поля' };
    }
    for (const name of ['pages', 'edition']) {
      if (rawSource[name] !== undefined && (typeof rawSource[name] !== 'string' || rawSource[name].length > 200)) {
        return { ok: false, error: `Поле источника ${name} не длиннее 200 знаков` };
      }
    }
    source = {
      file: rawSource.file.trim(),
      ...(typeof rawSource.pages === 'string' ? { pages: rawSource.pages.trim() } : {}),
      ...(typeof rawSource.edition === 'string' ? { edition: rawSource.edition.trim() } : {}),
    };
  }
  for (const name of ['proposedValue', 'sourceText']) {
    if (value[name] !== undefined && (typeof value[name] !== 'string' || value[name].length > 4000)) {
      return { ok: false, error: `${name} не длиннее 4000 знаков` };
    }
  }
  const checked: CatalogDataIssue = {
    namespace: 'catalogDataIssue',
    context: {
      program: context.program,
      entityId: context.entityId.trim(), entityTitle: context.entityTitle.trim(),
      ...(typeof context.field === 'string' && context.field.trim() ? { field: context.field.trim() } : {}),
      ...(typeof context.currentValue === 'string' && context.currentValue.trim() ? { currentValue: context.currentValue.trim() } : {}),
      ...(typeof context.revision === 'string' && context.revision.trim() ? { revision: context.revision.trim() } : {}),
      ...(source ? { source } : {}),
    },
    ...(typeof value.proposedValue === 'string' && value.proposedValue.trim() ? { proposedValue: value.proposedValue.trim() } : {}),
    ...(typeof value.sourceText === 'string' && value.sourceText.trim() ? { sourceText: value.sourceText.trim() } : {}),
  };
  return { ok: true, value: checked };
}
