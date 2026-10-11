/**
 * Чистая модель шапки и заполнения Flux Office. Здесь нет DOM и доступа к
 * редактору: защищённые метки переживают сериализацию как отдельные части.
 */

export interface OfficeBinding {
  fieldKey: string;
  sourceId: string;
  entityType: string;
  /** null в шапке означает «значение для каждой строки», а не координату. */
  entityId: string | null;
  sourceRevision: string;
  unit?: string;
  anchorId: string;
}

export type OfficePart =
  | { kind: 'text'; text: string }
  | { kind: 'field'; binding: OfficeBinding }
  | { kind: 'operator'; operator: '+' | '-' | '*' | '/' | '(' | ')' }
  | { kind: 'union'; mode: 'first-match'; alternatives: Array<OfficeBinding & { priority: number }> };

export interface OfficeHeaderAnchor {
  kind: 'word-row' | 'excel-range';
  id: string;
  documentPart?: string;
  sheetName?: string;
  address?: string;
  parts: OfficePart[];
}

export interface OfficeHeaderSchema {
  version: 1;
  anchors: OfficeHeaderAnchor[];
}

export interface OfficeValue {
  value: string | number | null;
  unit?: string;
  revision?: string;
  manuallyEdited?: boolean;
}

export interface OfficeEntityRow {
  entityId: string;
  entityType: string;
  sourceId: string;
  values: Record<string, OfficeValue>;
}

/** Стабильный UI ID включает источник и тип: raw ID может совпасть. */
export function officeEntityId(sourceId: string, entityType: string, rawId: string): string {
  return `office:${encodeURIComponent(sourceId)}:${encodeURIComponent(entityType)}:${encodeURIComponent(rawId)}`;
}

export interface OfficeManualRow {
  rowId: string;
  values: Record<string, unknown>;
}

export interface OfficeFillPlan {
  baseHash: string;
  sourceRevision: string;
  selectedEntityIds: string[];
  writes: Array<{ entityId: string; anchorId: string; value: string | number; unit?: string }>;
  adds: string[];
  replaces: string[];
  manualRows: string[];
  skips: Array<{ entityId: string; anchorId: string; reason: string }>;
  errors: Array<{ entityId: string; anchorId: string; message: string }>;
  conflicts: Array<{ entityId: string; anchorId: string; candidates: string[] }>;
}

const MAX_SCALE = 6;
const RESULT_SCALE = 6;
const SCALE = 10n ** BigInt(MAX_SCALE);

interface Quantity { amount: bigint; dimension: string; unit: string }

const UNITS: Record<string, { dimension: string; factor: bigint; canonical: string }> = {
  'w': { dimension: 'power', factor: 1n, canonical: 'W' },
  'kw': { dimension: 'power', factor: 1000n, canonical: 'W' },
  'квт': { dimension: 'power', factor: 1000n, canonical: 'W' },
  'мвт': { dimension: 'power', factor: 1000000n, canonical: 'W' },
  'pa': { dimension: 'pressure', factor: 1n, canonical: 'Pa' },
  'кпа': { dimension: 'pressure', factor: 1000n, canonical: 'Pa' },
  'мпа': { dimension: 'pressure', factor: 1000000n, canonical: 'Pa' },
  'м³/ч': { dimension: 'airflow', factor: 1n, canonical: 'м³/ч' },
  'm³/h': { dimension: 'airflow', factor: 1n, canonical: 'м³/ч' },
};

const cleanUnit = (unit: string) => unit.trim().toLocaleLowerCase('ru-RU').replaceAll(' ', '');

function parseQuantity(input: OfficeValue): Quantity | null {
  if (input.value === null || input.value === '') return null;
  const raw = String(input.value).trim().replace(/\s+/g, '').replace(',', '.');
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw)) return null;
  const [whole = '0', fraction = ''] = raw.replace(/^[+-]/, '').split('.');
  if (fraction.length > MAX_SCALE) return null;
  const sign = raw.startsWith('-') ? -1n : 1n;
  const amount = sign * BigInt(whole || '0') * SCALE + sign * BigInt((fraction + '0'.repeat(MAX_SCALE)).slice(0, MAX_SCALE) || '0');
  const unit = input.unit || '';
  const known = UNITS[cleanUnit(unit)];
  if (known) return { amount: amount * known.factor, dimension: known.dimension, unit: known.canonical };
  return { amount, dimension: unit ? `unit:${cleanUnit(unit)}` : 'scalar', unit };
}

function decimalText(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / SCALE;
  const rest = (absolute % SCALE).toString().padStart(MAX_SCALE, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${rest ? `.${rest}` : ''}`;
}

function fromQuantity(q: Quantity): OfficeValue {
  const unit = UNITS[cleanUnit(q.unit)];
  const amount = unit ? q.amount / unit.factor : q.amount;
  return { value: decimalText(amount), ...(q.unit ? { unit: q.unit } : {}) };
}

function readPartValue(part: Extract<OfficePart, { kind: 'field' | 'union' }>, row: OfficeEntityRow): { value?: OfficeValue; conflict?: string[] } {
  if (part.kind === 'field') {
    if ((part.binding.sourceId && part.binding.sourceId !== row.sourceId) || (part.binding.entityType && part.binding.entityType !== row.entityType)) return {};
    const value = row.values[part.binding.fieldKey];
    return value ? { value: { ...value, unit: value.unit || part.binding.unit } } : {};
  }
  const candidates = part.alternatives
    .filter((binding) => (!binding.sourceId || binding.sourceId === row.sourceId) && (!binding.entityType || binding.entityType === row.entityType))
    .map((binding) => ({ binding, value: row.values[binding.fieldKey] }))
    .filter((x) => x.value?.value !== null && x.value?.value !== undefined && x.value?.value !== '')
    .sort((a, b) => a.binding.priority - b.binding.priority || a.binding.fieldKey.localeCompare(b.binding.fieldKey));
  const tied = candidates.filter((x) => x.binding.priority === candidates[0]?.binding.priority);
  if (tied.length > 1) return { conflict: tied.map((x) => `${x.binding.sourceId}:${x.binding.entityType}:${x.binding.fieldKey}`) };
  const selected = candidates[0];
  return selected?.value ? { value: { ...selected.value, unit: selected.value.unit || selected.binding.unit } } : {};
}

type Token = { kind: 'number'; quantity: Quantity } | { kind: 'op'; value: string };

/**
 * Считает только цепочку из полей, операторов и чисел. Обычный текст остаётся
 * обычным текстом, а неизвестная размерность никогда не складывается молча.
 */
export function evaluateOfficeParts(parts: OfficePart[], row: OfficeEntityRow): { value?: OfficeValue; error?: string; conflict?: string[] } {
  const tokens: Token[] = [];
  const significant = parts.filter((part) => part.kind !== 'text' || !!part.text.trim());
  const arithmeticParts = significant.some((part) => part.kind === 'operator');
  const firstExpression = significant.findIndex((part) => part.kind === 'operator' || part.kind === 'field' || part.kind === 'union' || (part.kind === 'text' && /^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)$/.test(part.text.trim())));
  let lastExpression = significant.length - 1;
  while (lastExpression >= 0) {
    const last = significant[lastExpression];
    if (last.kind !== 'text' || /^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)$/.test(last.text.trim()) || last.text.trim() === ')') break;
    lastExpression--;
  }
  const expressionParts = arithmeticParts ? significant.slice(firstExpression, lastExpression + 1) : significant;
  if (!arithmeticParts) {
    const values: OfficeValue[] = [];
    for (const part of significant) {
      if (part.kind === 'text') { values.push({ value: part.text }); continue; }
      if (part.kind === 'operator') return {};
      const chosen = readPartValue(part, row);
      if (chosen.conflict) return { conflict: chosen.conflict };
      const selected = chosen.value;
      if (!selected || selected.value === null || selected.value === undefined || selected.value === '') return { error: 'Источник не вернул значение' };
      values.push(selected);
    }
    if (values.length === 1) return { value: values[0] };
    const text = values.map((v) => String(v.value)).join('');
    return { value: { value: text } };
  }
  for (const part of expressionParts) {
    if (part.kind === 'text') {
      const text = part.text.trim();
      if (!text) continue;
      if (/^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)$/.test(text)) {
        const q = parseQuantity({ value: text });
        if (!q) return { error: 'Число имеет слишком много знаков после запятой' };
        tokens.push({ kind: 'number', quantity: q });
      } else return {};
    } else if (part.kind === 'operator') tokens.push({ kind: 'op', value: part.operator });
    else {
      const chosen = readPartValue(part, row);
      if (chosen.conflict) return { conflict: chosen.conflict };
      const selected = chosen.value;
      const q = selected && parseQuantity(selected);
      if (!q) return { error: `Поле «${part.kind === 'field' ? part.binding.fieldKey : 'объединённого поля'}» не содержит числа с совместимой единицей` };
      tokens.push({ kind: 'number', quantity: q });
    }
  }
  if (!tokens.length || !tokens.some((x) => x.kind === 'op')) return {};
  const stack: Quantity[] = [];
  const ops: string[] = [];
  const precedence = (op: string) => op === 'u-' || op === 'u+' ? 3 : op === '*' || op === '/' ? 2 : 1;
  const apply = (): string | null => {
    const op = ops.pop();
    if (!op || op === '(') return 'Нарушен порядок операторов';
    if (op === 'u-' || op === 'u+') {
      const value = stack.pop();
      if (!value) return 'Не хватает значения около унарного знака';
      stack.push({ ...value, amount: op === 'u-' ? -value.amount : value.amount });
      return null;
    }
    const right = stack.pop(), left = stack.pop();
    if (!left || !right) return 'Не хватает значения около оператора';
    if (op === '+' || op === '-') {
      if (left.dimension !== right.dimension) return 'Нельзя складывать поля с разными единицами';
      stack.push({ ...left, amount: op === '+' ? left.amount + right.amount : left.amount - right.amount });
    } else if (op === '*') {
      const dimension = left.dimension === 'scalar' ? right.dimension : right.dimension === 'scalar' ? left.dimension : `${left.dimension}·${right.dimension}`;
      stack.push({ amount: left.amount * right.amount / SCALE, dimension, unit: dimension === 'scalar' ? '' : left.unit && right.unit ? `${left.unit}·${right.unit}` : left.unit || right.unit });
    } else {
      if (right.amount === 0n) return 'Деление на ноль';
      const dimension = left.dimension === right.dimension ? 'scalar' : right.dimension === 'scalar' ? left.dimension : `${left.dimension}/${right.dimension}`;
      stack.push({ amount: left.amount * SCALE / right.amount, dimension, unit: dimension === 'scalar' ? '' : left.unit && right.unit ? `${left.unit}/${right.unit}` : left.unit });
    }
    return null;
  };
  let expectsValue = true;
  for (const token of tokens) {
    if (token.kind === 'number') {
      if (!expectsValue) return { error: 'Между значениями нужен оператор' };
      stack.push(token.quantity); expectsValue = false;
    } else if (token.value === '(') {
      if (!expectsValue) return { error: 'Перед скобкой нужен оператор' };
      ops.push(token.value);
    } else if (token.value === ')') {
      if (expectsValue) return { error: 'Пустые или незакрытые скобки' };
      while (ops.length && ops[ops.length - 1] !== '(') { const err = apply(); if (err) return { error: err }; }
      if (ops.pop() !== '(') return { error: 'Нет открывающей скобки' };
    } else {
      if (expectsValue && (token.value === '-' || token.value === '+')) { ops.push(token.value === '-' ? 'u-' : 'u+'); continue; }
      if (expectsValue) return { error: 'После оператора нужно значение' };
      while (ops.length && ops[ops.length - 1] !== '(' && precedence(ops[ops.length - 1]) >= precedence(token.value)) { const err = apply(); if (err) return { error: err }; }
      ops.push(token.value); expectsValue = true;
    }
  }
  if (expectsValue) return { error: 'Выражение заканчивается оператором' };
  while (ops.length) { if (ops[ops.length - 1] === '(') return { error: 'Не закрыта скобка' }; const err = apply(); if (err) return { error: err }; }
  const result = stack.pop();
  if (!result || stack.length) return { error: 'Не удалось разобрать выражение' };
  // Внутреннее хранение фиксировано с шестью знаками; округление задаёт единый
  // результат и не зависит от платформенного double округления.
  const round = (value: bigint) => value >= 0n ? (value + 5n) / 10n : (value - 5n) / 10n;
  const rounded = fromQuantity({ ...result, amount: round(result.amount) * 10n });
  const prefix = significant.slice(0, firstExpression).filter((part) => part.kind === 'text').map((part) => (part as Extract<OfficePart, {kind:'text'}>).text).join('');
  const suffix = significant.slice(lastExpression + 1).filter((part) => part.kind === 'text').map((part) => (part as Extract<OfficePart, {kind:'text'}>).text).join('');
  const suffixUnit = suffix.trim().match(/^(?:кВт|мВт|Вт|kW|MW|W|Па|кПа|МПа|м³\/ч|m³\/h)$/i)?.[0];
  let rendered = rounded;
  const displayUnit = suffixUnit ? UNITS[cleanUnit(suffixUnit)] : undefined;
  if (suffixUnit && displayUnit && result.dimension === displayUnit.dimension) {
    rendered = { value: decimalText(result.amount / displayUnit.factor) };
  }
  if (prefix || suffix) return { value: { value: `${prefix}${rendered.value}${rendered.unit ? ` ${rendered.unit}` : ''}${suffix}` } };
  return { value: rendered };
}

export interface ExistingOfficeRow { entityId?: string; rowId: string; manuallyEdited?: boolean }

/** План учитывает только явный выбор; ручные строки и дубли остаются видимыми. */
export function planOfficeFill(args: {
  baseHash: string;
  sourceRevision: string;
  selectedEntityIds: string[];
  rows: OfficeEntityRow[];
  anchors: OfficeHeaderAnchor[];
  existingRows?: ExistingOfficeRow[];
}): OfficeFillPlan {
  const plan: OfficeFillPlan = { baseHash: args.baseHash, sourceRevision: args.sourceRevision, selectedEntityIds: [...new Set(args.selectedEntityIds)], writes: [], adds: [], replaces: [], manualRows: [], skips: [], errors: [], conflicts: [] };
  const rowById = new Map(args.rows.map((row) => [row.entityId, row]));
  const oldById = new Map<string, ExistingOfficeRow>();
  const duplicateRows = new Map<string, string[]>();
  for (const row of args.existingRows || []) {
    if (row.manuallyEdited || !row.entityId) plan.manualRows.push(row.rowId);
    else {
      const siblings = duplicateRows.get(row.entityId) || [];
      siblings.push(row.rowId);
      duplicateRows.set(row.entityId, siblings);
      oldById.set(row.entityId, row);
    }
  }
  for (const entityId of plan.selectedEntityIds) {
    const duplicates = duplicateRows.get(entityId);
    if (duplicates && duplicates.length > 1) {
      plan.conflicts.push({ entityId, anchorId: '', candidates: duplicates });
      continue;
    }
    const row = rowById.get(entityId);
    if (!row) { plan.skips.push({ entityId, anchorId: '', reason: 'Сущность отсутствует в текущей выборке' }); continue; }
    const existed = oldById.has(entityId);
    (existed ? plan.replaces : plan.adds).push(entityId);
    for (const anchor of args.anchors) {
      const result = evaluateOfficeParts(anchor.parts, row);
      if (result.conflict) plan.conflicts.push({ entityId, anchorId: anchor.id, candidates: result.conflict });
      else if (result.error) plan.errors.push({ entityId, anchorId: anchor.id, message: result.error });
      else if (result.value?.value !== null && result.value?.value !== undefined) plan.writes.push({ entityId, anchorId: anchor.id, value: result.value.value, unit: result.value.unit });
      else {
        const fields = anchor.parts.filter((part) => part.kind === 'field');
        if (fields.length === 1) {
          const binding = (fields[0] as Extract<OfficePart, {kind:'field'}>).binding;
          const value = row.values[binding.fieldKey];
          if (value?.value !== null && value?.value !== undefined) plan.writes.push({ entityId, anchorId: anchor.id, value: value.value, unit: value.unit });
          else plan.skips.push({ entityId, anchorId: anchor.id, reason: 'Источник не вернул значение; существующая ячейка сохраняется' });
        }
      }
    }
  }
  return plan;
}

/** Сверяет точные ревизии и предотвращает применение старого предпросмотра. */
export function canApplyOfficePlan(plan: OfficeFillPlan, confirmation: { baseHash: string; sourceRevision: string; selectedEntityIds: string[] }): { ok: true } | { ok: false; reason: string } {
  if (plan.baseHash !== confirmation.baseHash) return { ok: false, reason: 'Документ изменился после предпросмотра' };
  if (plan.sourceRevision !== confirmation.sourceRevision) return { ok: false, reason: 'Источник изменился после предпросмотра' };
  const expected = [...new Set(plan.selectedEntityIds)].sort().join('\u0000');
  const actual = [...new Set(confirmation.selectedEntityIds)].sort().join('\u0000');
  if (expected !== actual) return { ok: false, reason: 'Выбор строк изменился после предпросмотра' };
  if (plan.errors.length || plan.conflicts.length) return { ok: false, reason: 'В плане остались ошибки или конфликты' };
  return { ok: true };
}
