/** Deterministic answers from the structured Catalog. No network or AI calls. */
import type { Catalog, CatalogRef, Component, Cond, Family, Facts } from './model';
import { parseWithFamily } from './designation';
import { foldText } from './text';

export interface CatalogQueryResult {
  answer: string;
  matches: Array<{ familyId: string; title: string }>;
  sources: Array<{ file: string; edition?: string; pages?: string }>;
  ambiguous: boolean;
}

const MAX_QUESTION_LENGTH = 4096;
const MAX_MATCHES = 20;
const MAX_ANSWER_LENGTH = 16000;

const text = (v: { ru: string; en?: string } | string | undefined): string =>
  typeof v === 'string' ? v : v?.ru || v?.en || '';
const normalize = (s: string) => foldText(s).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const hasWholePhrase = (haystack: string, needle: string) => !!needle && ` ${normalize(haystack)} `.includes(` ${normalize(needle)} `);

function familyTitle(f: Family): string { return text(f.title) || f.code; }
function familySearchText(catalog: Catalog, f: Family): string {
  const manufacturer = catalog.manufacturers.find((m) => m.id === f.manufacturerId);
  const equipmentClass = catalog.classes.find((c) => c.id === f.classId);
  return [f.code, f.article, familyTitle(f), text(f.description), ...(f.aliases || []), manufacturer?.name, manufacturer?.shortName,
    text(equipmentClass?.title), text(f.typeLabel)].filter(Boolean).join(' ');
}

function selectedFacts(f: Family, values: Record<string, string | number>): Facts {
  const facts: Facts = { ...(f.facts || {}) };
  for (const param of f.params) {
    const code = values[param.key];
    if (code === undefined) continue;
    const value = param.values?.find((item) => String(item.code) === String(code));
    if (value?.facts) Object.assign(facts, value.facts);
  }
  return facts;
}

function conditionMatches(f: Family, values: Record<string, string | number>, cond: Cond): boolean | undefined {
  if (cond.all) {
    const states = cond.all.map((c) => conditionMatches(f, values, c));
    return states.includes(false) ? false : states.includes(undefined) ? undefined : true;
  }
  if (cond.any) {
    const states = cond.any.map((c) => conditionMatches(f, values, c));
    return states.includes(true) ? true : states.includes(undefined) ? undefined : false;
  }
  if (cond.not) {
    const state = conditionMatches(f, values, cond.not);
    return state === undefined ? undefined : !state;
  }
  if (cond.fact) {
    const value = selectedFacts(f, values)[cond.fact];
    return value === undefined ? undefined : cond.eq === undefined ? true : value === cond.eq;
  }
  if (cond.param) {
    const value = values[cond.param];
    if (cond.set !== undefined && (value !== undefined) !== cond.set) return false;
    if (value === undefined) return undefined;
    if (cond.in && !cond.in.some((v) => String(v) === String(value))) return false;
    if (typeof value === 'number') {
      if (cond.gt !== undefined && !(value > cond.gt)) return false;
      if (cond.gte !== undefined && !(value >= cond.gte)) return false;
      if (cond.lt !== undefined && !(value < cond.lt)) return false;
      if (cond.lte !== undefined && !(value <= cond.lte)) return false;
    }
    return true;
  }
  return undefined;
}

function refsOf(f: Family, includeMarkingPage = false): CatalogRef[] {
  const docs = includeMarkingPage ? (f.documents || []).filter((document) => /маркиров|marking/i.test(document.label)) : [];
  return [...(f.catalog?.file ? [f.catalog] : []), ...docs.filter((doc) => !!doc.file)];
}

function refsOfComponent(component: Component): CatalogRef[] {
  const catalogRef = component.catalog
    ? [{ ...component.catalog, ...(component.sourcePdfPage ? { physicalPage: component.sourcePdfPage } : {}) }]
    : [];
  return [...catalogRef, ...(component.specs || []).flatMap((spec) => spec.sourceRef ? [spec.sourceRef] : [])];
}

function citeRefs(refs: CatalogRef[]): string {
  const unique = [...new Map(refs.filter((r) => r.file).map((r) => [`${r.file}\0${r.edition || ''}\0${r.pages || ''}\0${r.physicalPage || ''}`, r])).values()].slice(0, MAX_MATCHES);
  if (!unique.length) return 'Источник в Каталоге не указан.';
  return `Источники: ${unique.map((ref) => `${ref.file}${ref.edition ? `, редакция ${ref.edition}` : ''}${ref.pages ? `, стр. ${ref.pages}` : ''}${ref.physicalPage ? ` (физ. стр. ${ref.physicalPage})` : ''}`).join('; ')}.`;
}

function sourcesOf(refs: CatalogRef[]) {
  const seen = new Set<string>();
  return refs.flatMap((ref) => {
    if (!ref?.file) return [];
    const pages = ref.physicalPage ? String(ref.physicalPage) : ref.pages;
    const key = `${ref.file}\0${ref.edition || ''}\0${pages || ''}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ file: ref.file, ...(ref.edition ? { edition: ref.edition } : {}), ...(pages ? { pages } : {}) }];
  }).slice(0, MAX_MATCHES);
}

/** Resolve a complete model designation after any known family code or spaced alias. */
function designationForFamily(f: Family, question: string): string {
  if (f.designationMode === 'article' || f.designationMode === 'free') {
    return [f.article, f.code, ...(f.aliases || [])].filter((v): v is string => !!v)
      .find((name) => hasWholePhrase(question, name)) || '';
  }
  const haystack = question.toLocaleUpperCase('ru');
  const names = [...new Set([f.code, ...(f.aliases || [])])].sort((a, b) => b.length - a.length);
  let partial = '';
  for (const name of names) {
    const needle = name.toLocaleUpperCase('ru');
    let at = -1;
    while ((at = haystack.indexOf(needle, at + 1)) >= 0) {
      const afterName = question.slice(at + needle.length).replace(/^\s+/, '');
      const tail = afterName.match(/^(?:[-–]\s*)?[\p{L}\p{N}*×хХ/._\-]+/u)?.[0] || '';
      const candidate = `${f.code}${tail.replace(/^[-–]\s*/, '-')}`;
      if (parseWithFamily(f, candidate).complete) return candidate;
      if (!partial && tail) partial = candidate;
    }
  }
  return partial;
}

function findFamilies(catalog: Catalog, question: string): Family[] {
  const q = normalize(question);
  if (!q) return [];
  // Full designation parsing takes precedence over loose name matching.
  const parsed = catalog.families.filter((f) => {
    const designation = designationForFamily(f, question);
    return !!designation && parseWithFamily(f, designation).complete;
  });
  if (parsed.length) return parsed;
  const exact = catalog.families.filter((f) =>
    [f.code, f.article, familyTitle(f), ...(f.aliases || [])].some((name) => normalize(name) === q));
  if (exact.length) return exact;
  const included = catalog.families.filter((f) =>
    [f.code, f.article, familyTitle(f), ...(f.aliases || [])].some((name) => hasWholePhrase(question, name)));
  if (included.length) return included;
  const terms = q.split(' ').filter((x) => x.length > 2).slice(0, 40);
  if (!terms.length) return [];
  const scored = catalog.families.map((f) => ({ f, score: terms.filter((t) => normalize(familySearchText(catalog, f)).split(' ').includes(t)).length }))
    .filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
  return scored.length ? scored.filter((x) => x.score === scored[0].score).map((x) => x.f) : [];
}

function matchingCodeParams(f: Family, question: string) {
  const q = normalize(question);
  return f.params.flatMap((param) => (param.values || []).filter((v) => {
    return q && hasWholePhrase(question, v.code);
  }).map((value) => ({ param, value })));
}

function requestedParams(f: Family, question: string) {
  return f.params.filter((param) => normalize(param.label.ru).split(' ').filter((word) => word.length > 2)
    .some((word) => hasWholePhrase(question, word)));
}

function componentTitle(component: Component): string { return text(component.title) || component.code; }
function findComponents(catalog: Catalog, question: string): Component[] {
  const q = normalize(question);
  if (!q) return [];
  const exact = catalog.components.filter((component) =>
    hasWholePhrase(question, component.code) || normalize(componentTitle(component)) === q || hasWholePhrase(question, componentTitle(component)));
  // Exact code/title matches are intentional; a shared code is kept ambiguous.
  return exact;
}

function componentRefs(component: Component): CatalogRef[] {
  return refsOfComponent(component);
}

function answerComponent(component: Component): string {
  const parts = [`${componentTitle(component)} (${component.code}).`];
  if (component.manufacturer) parts.push(`Изготовитель: ${component.manufacturer}.`);
  for (const spec of (component.specs || []).slice(0, 80)) {
    parts.push(`${text(spec.label)}: ${spec.value || 'значение не указано'}${spec.unit ? ` ${spec.unit}` : ''}.`);
  }
  for (const [key, value] of Object.entries(component.facts || {}).slice(0, 40)) {
    if (value !== undefined) parts.push(`${key}: ${String(value)}.`);
  }
  if (!(component.specs?.length) && !Object.values(component.facts || {}).some((v) => v !== undefined)) {
    parts.push('В структурированных данных компонента характеристики не указаны.');
  }
  if (!component.catalog?.file && component.sourcePdfPage) parts.push(`В записи указан PDF-номер страницы ${component.sourcePdfPage}, но имя файла не указано.`);
  parts.push(citeRefs(componentRefs(component)));
  return parts.join('\n');
}

function tableAnswers(f: Family, values: Record<string, string | number>, question: string): { lines: string[]; sources: CatalogRef[] } {
  const lines: string[] = [];
  const sources: CatalogRef[] = [];
  for (const table of (f.tables || []).slice(0, 40)) {
    const inputColumns = table.columns.filter((column) => column.role === 'input');
    const outputColumns = table.columns.filter((column) => column.role === 'output');
    if (!inputColumns.length || !outputColumns.length) continue;
    const verifiedRows = table.rows.filter((row) => row.verified).slice(0, 10000);
    const inputs: Record<string, string> = {};
    const missing: string[] = [];
    for (const column of inputColumns) {
      const parsedValue = values[column.key];
      if (parsedValue !== undefined && parsedValue !== null && String(parsedValue).trim()) {
        inputs[column.key] = String(parsedValue);
        continue;
      }
      const labelWords = normalize(column.label).split(' ').filter((word) => word.length >= 4);
      const labelMentioned = labelWords.some((word) => hasWholePhrase(question, word));
      const candidates = [...new Set(verifiedRows.map((row) => row.values[column.key]).filter((v) => v !== null && v !== undefined).map(String))];
      const mentioned = labelMentioned ? candidates.filter((candidate) => hasWholePhrase(question, candidate)) : [];
      if (mentioned.length === 1) inputs[column.key] = mentioned[0];
      else missing.push(column.label);
    }
    if (missing.length) {
      lines.push(`${table.title}: точная проверенная строка не выбрана; укажите ${missing.join(', ')}.`);
      continue;
    }
    const hits = verifiedRows.filter((row) => inputColumns.every((column) => String(row.values[column.key] ?? '') === inputs[column.key]));
    if (hits.length !== 1) {
      if (hits.length > 1) lines.push(`${table.title}: найдено несколько проверенных строк для полного набора осей, значение неоднозначно.`);
      else lines.push(`${table.title}: проверенная строка с таким сочетанием осей не найдена.`);
      continue;
    }
    const row = hits[0];
    for (const column of outputColumns) {
      const value = row.values[column.key];
      if (value === null || value === undefined || !String(value).trim()) continue;
      lines.push(`${column.label}: ${String(value)}${column.unit ? ` ${column.unit}` : ''} (таблица «${table.title}»).`);
    }
    if (row.source || table.source || f.catalog) sources.push(row.source || table.source || f.catalog!);
  }
  return { lines, sources };
}

function answerFamily(f: Family, question: string): string {
  const parts: string[] = [`${familyTitle(f)} (${f.code}).`];
  const designation = designationForFamily(f, question);
  const parsed = designation ? parseWithFamily(f, designation) : parseWithFamily(f, question);
  const values = parsed.complete ? parsed.values : {};
  const codeHits = parsed.complete
    ? f.params.flatMap((param) => values[param.key] === undefined ? [] : (param.values || []).filter((v) => String(v.code) === String(values[param.key])).map((value) => ({ param, value })))
    : matchingCodeParams(f, question);
  if (codeHits.length) {
    const unique = new Map(codeHits.map((hit) => [`${hit.param.key}\0${hit.value.code}`, hit]));
    for (const { param, value } of unique.values()) {
      const meaning = value.note || (value.facts ? Object.entries(value.facts).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${String(v)}`).join('; ') : '');
      parts.push(`Код «${value.code}» — ${text(param.label)}: ${text(value.label)}${meaning ? `; ${meaning}` : ''}.`);
    }
  }
  const asksCodeMeaning = /что\s+(?:значит|означает)|расшифров|meaning\s+of/i.test(question);
  const suffix = designation.replace(new RegExp(f.code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), '');
  const hasUnparsedMarking = !parsed.complete && (!!suffix.match(/-/g)?.length && suffix.split('-').filter(Boolean).length >= 3);
  const hasUnmatchedNumericCode = !parsed.complete && !codeHits.length && /\d/.test(question.replace(new RegExp(f.code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), ''));
  const unknownCodeRequested = asksCodeMeaning && (hasUnparsedMarking || hasUnmatchedNumericCode);
  if (unknownCodeRequested) parts.push('Часть обозначения не сопоставлена с опубликованной расшифровкой; значение неизвестно по структурированным данным.');
  const askedForSpecs = /характер|параметр|напряж|мощност|давлен|температур|габарит|масса|вес|значени|исполнен/i.test(question);
  if (parsed.complete && !askedForSpecs) {
    const selectedCases = f.specs.slice(0, 80).flatMap((spec) => {
      const matched = spec.cases?.find((item) => conditionMatches(f, values, item.when) === true);
      return matched ? [`${text(spec.label)}: ${text(matched.value)}${spec.unit ? ` ${spec.unit}` : ''} (по выбранному варианту).`] : [];
    });
    parts.push(...selectedCases);
  }
  if (askedForSpecs) {
    const specLines = f.specs.slice(0, 80).map((spec) => {
      if (spec.cases?.length) {
        if (!parsed.complete) return `${text(spec.label)}: значение зависит от выбранного исполнения; обозначение варианта не распознано полностью.`;
        const matched = spec.cases.find((item) => conditionMatches(f, values, item.when) === true);
        if (matched) return `${text(spec.label)}: ${text(matched.value)}${spec.unit ? ` ${spec.unit}` : ''}.`;
        const states = spec.cases.map((item) => conditionMatches(f, values, item.when));
        if (states.every((state) => state === false)) return `${text(spec.label)}: ${text(spec.value) || 'значение не указано'}${spec.unit ? ` ${spec.unit}` : ''}.`;
        return `${text(spec.label)}: для этого исполнения значение не указано.`;
      }
      return `${text(spec.label)}: ${text(spec.value) || 'значение не указано'}${spec.unit ? ` ${spec.unit}` : ''}.`;
    });
    const factLines = Object.entries(f.facts || {}).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}: ${String(value)}.`);
    const params = requestedParams(f, question).filter((p) => p.values?.length).slice(0, 40).map((p) => `${text(p.label)}: ${p.values!.slice(0, 80).map((v) => `${v.code} — ${text(v.label)}`).join('; ')}.`);
    const table = tableAnswers(f, values, question);
    parts.push(...specLines, ...factLines, ...params, ...table.lines);
    if (table.sources.length) parts.push(citeRefs(table.sources));
    if (!specLines.length && !factLines.length && !params.length) parts.push('В структурированных данных этих характеристик нет.');
  }
  if (!codeHits.length && !askedForSpecs && !unknownCodeRequested) {
    const params = requestedParams(f, question).filter((p) => p.values?.length).slice(0, 40).map((p) => `${text(p.label)}: ${p.values!.slice(0, 80).map((v) => `${v.code} — ${text(v.label)}`).join('; ')}.`);
    parts.push(...params);
    if (!params.length) parts.push('Для точной расшифровки укажите код сегмента маркировки или полное обозначение.');
  }
  if (f.status !== 'full' && f.todo?.length) parts.push(`В записи отмечено к проверке: ${f.todo.slice(0, 6).map((item) => item.slice(0, 300)).join('; ')}.`);
  parts.push(citeRefs(refsOf(f, parsed.complete)));
  return parts.join('\n');
}

export function queryCatalog(catalog: Catalog, question: string): CatalogQueryResult {
  if (question.length > MAX_QUESTION_LENGTH) return {
    answer: `Вопрос длиннее ${MAX_QUESTION_LENGTH} символов. Сократите его до модели, маркировки или характеристики.`,
    matches: [], sources: [], ambiguous: false,
  };
  const families = findFamilies(catalog, question);
  const components = findComponents(catalog, question);
  if (!families.length && !components.length) return {
    answer: 'В опубликованных структурированных данных подходящая модель не найдена. Уточните семейство или маркировку.',
    matches: [], sources: [], ambiguous: false,
  };
  const totalMatches = families.length + components.length;
  const selectedFamilies = families.slice(0, MAX_MATCHES);
  const selectedComponents = components.slice(0, Math.max(0, MAX_MATCHES - selectedFamilies.length));
  const ambiguous = totalMatches > 1;
  const answers = [...selectedFamilies.map((f) => answerFamily(f, question)), ...selectedComponents.map(answerComponent)];
  const codeAmbiguous = families.some((f) => {
    const designation = designationForFamily(f, question);
    const parsed = designation ? parseWithFamily(f, designation) : parseWithFamily(f, question);
    return !parsed.complete && matchingCodeParams(f, question).length > 1;
  });
  const refs = [
    ...selectedFamilies.flatMap((f) => {
      const designation = designationForFamily(f, question);
      const parsed = designation ? parseWithFamily(f, designation) : parseWithFamily(f, question);
      const asksForSpecs = /характер|параметр|напряж|мощност|давлен|температур|габарит|масса|вес|значени|исполнен/i.test(question);
      const tableRefs = asksForSpecs ? tableAnswers(f, parsed.complete ? parsed.values : {}, question).sources : [];
      return [...refsOf(f, parsed.complete), ...tableRefs];
    }),
    ...selectedComponents.flatMap(componentRefs),
  ];
  const selectedMatches = [
    ...selectedFamilies.map((f) => ({ familyId: f.id, title: familyTitle(f) })),
    ...selectedComponents.map((component) => ({ familyId: component.id, title: componentTitle(component) })),
  ];
  let answer = `${ambiguous ? `Найдено несколько подходящих записей (${totalMatches}); данные приведены отдельно.\n\n` : ''}${totalMatches > MAX_MATCHES ? `Показаны первые ${MAX_MATCHES} записей из ${totalMatches}. Уточните модель для сужения поиска.\n\n` : ''}${codeAmbiguous ? 'Этот код встречается в нескольких позициях обозначения; приведены все совпавшие значения, уточните позицию для однозначной расшифровки.\n\n' : ''}${answers.join('\n\n')}`;
  if (answer.length > MAX_ANSWER_LENGTH) answer = `${answer.slice(0, MAX_ANSWER_LENGTH)}\n\nОтвет сокращён из-за объёма. Уточните один параметр или модель.`;
  return {
    answer,
    matches: selectedMatches,
    sources: sourcesOf(refs), ambiguous: ambiguous || codeAmbiguous,
  };
}
