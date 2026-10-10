import { sourceValuesEqual } from '../equipment/sourceValueComparison.js';

export interface SourceParam { key: string; value: unknown; unit?: string }
export interface SourceGroup { title: string; params: SourceParam[] }
export interface SourceChange {
  id: string;
  targetId?: string;
  targetLabel?: string;
  group: string;
  key: string;
  kind: 'added' | 'changed' | 'missing';
  current?: SourceParam;
  proposed?: SourceParam;
  manual: boolean;
  /** Только для показа: фактическое значение из закреплённого каталога. */
  catalogCurrent?: SourceParam & { source: 'catalog' };
}

export const parseEquipmentSourceGroups = (raw: string | null | undefined): SourceGroup[] => {
  if (raw == null || raw === '') return [];
  let parsed: any;
  try { parsed = JSON.parse(raw); }
  catch { throw Object.assign(new Error('Сохранённые характеристики повреждены; источник не будет применён поверх них.'), { status: 409 }); }
  const normalizeGroup = (group: any): SourceGroup => {
    if (!group || typeof group !== 'object' || Array.isArray(group) || !Array.isArray(group.params)) {
      throw Object.assign(new Error('Формат сохранённых групп характеристик не распознан; источник не будет применён.'), { status: 409 });
    }
    const params = group.params.map((param: any) => {
        if (!param || typeof param !== 'object' || Array.isArray(param) || !('key' in param)) {
          throw Object.assign(new Error('Формат сохранённых характеристик не распознан; источник не будет применён.'), { status: 409 });
        }
        const key = String(param.key ?? '').trim();
        if (!key) throw Object.assign(new Error('У сохранённой характеристики отсутствует имя; источник не будет применён.'), { status: 409 });
        return { key, value: param.value, unit: String(param.unit || '') };
      });
    return { title: String(group.title || 'Параметры'), params };
  };
  const validateUnique = (groups: SourceGroup[]) => {
    const seen = new Set<string>();
    for (const group of groups) for (const param of group.params) {
      const address = paramId(group.title, param.key);
      if (seen.has(address)) throw Object.assign(new Error('В сохранённых характеристиках повторяется параметр одной группы; источник не будет применён.'), { status: 409 });
      seen.add(address);
    }
    return groups;
  };
  if (Array.isArray(parsed?.groups)) return validateUnique(parsed.groups.map(normalizeGroup));
  // Старые записи хранились непосредственно массивом групп.
  if (Array.isArray(parsed)) return validateUnique(parsed.map(normalizeGroup));
  // Старый плоский формат: {"Параметр":"значение"} или {"Параметр":{"value":"...","unit":"..."}}.
  if (parsed && typeof parsed === 'object') {
    if (Object.keys(parsed).every(key => !['groups', 'params', 'title'].includes(key))) {
      return validateUnique([{ title: 'Параметры', params: Object.entries(parsed).map(([key, value]: [string, any]) => {
        if (!key.trim()) throw Object.assign(new Error('У сохранённой характеристики отсутствует имя; источник не будет применён.'), { status: 409 });
        return {
          key, value: value && typeof value === 'object' && !Array.isArray(value) && 'value' in value ? value.value : value,
          unit: value && typeof value === 'object' && !Array.isArray(value) ? String(value.unit || '') : '',
        };
      }) }]);
    }
  }
  throw Object.assign(new Error('Формат сохранённых характеристик не распознан; источник не будет применён.'), { status: 409 });
};

const paramId = (group: string, key: string) => `${group}\u0000${key}`;
const overrideId = (group: string, key: string) => `${group}||${key}`;

/**
 * Строит дифф по группе и ключу, а не по позиции параметра в XML: порядок
 * файла может поменяться, но инженер должен увидеть ту же характеристику.
 */
export function diffEquipmentSource(currentSpecs: string | null, proposedGroups: SourceGroup[], overridesRaw: string | null): SourceChange[] {
  const current = parseEquipmentSourceGroups(currentSpecs);
  const oldMap = new Map<string, { group: string; param: SourceParam }>();
  const newMap = new Map<string, { group: string; param: SourceParam }>();
  const duplicate = new Set<string>();
  const fill = (groups: SourceGroup[], target: Map<string, { group: string; param: SourceParam }>) => {
    for (const group of groups) for (const param of group.params) {
      const id = paramId(group.title, param.key);
      if (target.has(id)) duplicate.add(id);
      target.set(id, { group: group.title, param });
    }
  };
  fill(current, oldMap); fill(proposedGroups, newMap);
  if (duplicate.size) throw new Error('В XML два одинаковых параметра в одной группе; исправьте файл перед сравнением.');
  let overrides: Record<string, unknown> = {}; let overridesMalformed = false;
  try { overrides = overridesRaw ? JSON.parse(overridesRaw) : {}; if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) overridesMalformed = true; }
  catch { overridesMalformed = true; }
  const changes: SourceChange[] = [];
  for (const [id, next] of newMap) {
    const old = oldMap.get(id);
    const overrideKey = overrideId(next.group, next.param.key);
    const manual = overridesMalformed || Object.prototype.hasOwnProperty.call(overrides, overrideKey);
    const effectiveCurrent = old ? { ...old.param, ...(manual && !overridesMalformed ? { value: overrides[overrideKey] } : {}) }
      : (manual && !overridesMalformed ? { key: next.param.key, value: overrides[overrideKey], unit: next.param.unit } : undefined);
    if (effectiveCurrent && sourceValuesEqual(effectiveCurrent, next.param)) continue;
    changes.push({ id, group: next.group, key: next.param.key, kind: old ? 'changed' : 'added', current: effectiveCurrent, proposed: next.param, manual });
  }
  for (const [id, old] of oldMap) if (!newMap.has(id)) {
    const overrideKey = overrideId(old.group, old.param.key);
    const manual = overridesMalformed || Object.prototype.hasOwnProperty.call(overrides, overrideKey);
    const effectiveCurrent = { ...old.param, ...(manual && !overridesMalformed ? { value: overrides[overrideKey] } : {}) };
    changes.push({ id, group: old.group, key: old.param.key, kind: 'missing', current: effectiveCurrent, manual });
  }
  // Ручные поля могут пережить удаление исходного XML-параметра. Показываем
  // их как отдельное расхождение, чтобы они не исчезали из интерфейса и могли
  // быть удалены только явным решением пользователя.
  if (!overridesMalformed) for (const [address, value] of Object.entries(overrides)) {
    const at = address.indexOf('||');
    if (at < 0) continue;
    const group = address.slice(0, at); const key = address.slice(at + 2); const id = paramId(group, key);
    if (!key || oldMap.has(id) || newMap.has(id)) continue;
    changes.push({ id, group, key, kind: 'missing', current: { key, value }, manual: true });
  }
  return changes.sort((a, b) => a.group.localeCompare(b.group, 'ru') || a.key.localeCompare(b.key, 'ru'));
}

/** Порядок строк не является изменением; физические единицы сравниваются только по разрешённым преобразованиям. */
export function equipmentSourceSpecsEqual(leftRaw: string | null, rightRaw: string | null): boolean {
  const left = new Map<string, SourceParam>(); const right = new Map<string, SourceParam>();
  for (const group of parseEquipmentSourceGroups(leftRaw)) for (const param of group.params) left.set(paramId(group.title, param.key), param);
  for (const group of parseEquipmentSourceGroups(rightRaw)) for (const param of group.params) right.set(paramId(group.title, param.key), param);
  if (left.size !== right.size) return false;
  for (const [id, param] of left) {
    const other = right.get(id);
    if (!other || !sourceValuesEqual(param, other)) return false;
  }
  return true;
}

/** При пересборке устаревшего кандидата сохраняем только «оставить», если это всё ещё та же разница. */
export function rebaseSourceDecisions(oldChanges: SourceChange[], oldDecisions: Record<string, any>, nextChanges: SourceChange[]): Record<string, any> {
  const previous = new Map(oldChanges.map(change => [change.id, change]));
  const kept: Record<string, any> = {};
  for (const change of nextChanges) {
    const decision = oldDecisions[change.id]; const before = previous.get(change.id);
    if (decision?.action !== 'keep' || !before || before.manual !== change.manual) continue;
    if (!sourceValuesEqual(before.current || { value: undefined }, change.current || { value: undefined })) continue;
    if (!sourceValuesEqual(before.proposed || { value: undefined }, change.proposed || { value: undefined })) continue;
    kept[change.id] = decision;
  }
  return kept;
}

/** Применяет только выбранные действия. Отсутствие параметра в файле само его не удаляет. */
export function applyEquipmentSourceDecisions(currentSpecs: string | null, proposedGroups: SourceGroup[], changes: SourceChange[], decisions: Record<string, { action: 'accept' | 'keep' | 'accept_missing'; overrideManual?: boolean }>): string {
  const groups = parseEquipmentSourceGroups(currentSpecs).map(group => ({ ...group, params: [...group.params] }));
  for (const change of changes) {
    const decision = decisions[change.id];
    if (!decision || decision.action === 'keep') continue;
    if (change.manual && !decision.overrideManual) throw Object.assign(new Error(`Параметр «${change.key}» изменён вручную — подтвердите отдельное действие с ручным значением.`), { status: 400 });
    const group = groups.find(item => item.title === change.group);
    if (change.kind === 'missing') {
      if (decision.action !== 'accept_missing') continue;
      if (group) group.params = group.params.filter(param => param.key !== change.key);
      continue;
    }
    if (decision.action !== 'accept' || !change.proposed) continue;
    const existingGroup = group || { title: change.group, params: [] };
    if (!group) groups.push(existingGroup);
    const index = existingGroup.params.findIndex(param => param.key === change.key);
    if (index < 0) existingGroup.params.push(change.proposed);
    else existingGroup.params[index] = change.proposed;
  }
  return JSON.stringify({ groups: groups.filter(group => group.params.length) });
}

export function sourceDecisionStatus(changes: SourceChange[], decisions: Record<string, unknown>, structuralActions: unknown[] = []): 'pending' | 'partial' | 'complete' | 'keepResolved' {
  const structural = structuralActions as Array<{ id?: string }>;
  const structuralResolved = structural.filter(action => !!action.id && Object.prototype.hasOwnProperty.call(decisions, action.id));
  if (!changes.length && !structural.length) return 'pending';
  if (structuralResolved.length < structural.length) return Object.keys(decisions).length ? 'partial' : 'pending';
  if (!changes.length) return structuralResolved.every(action => (decisions[action.id!] as any)?.action === 'accept') ? 'complete' : 'keepResolved';
  const resolved = changes.filter(change => Object.prototype.hasOwnProperty.call(decisions, change.id));
  if (!resolved.length) return structuralResolved.length ? 'partial' : 'pending';
  if (resolved.length < changes.length) return 'partial';
  return resolved.every(change => {
    const action = (decisions[change.id] as any)?.action;
    return action === 'accept' || action === 'accept_missing';
  }) && structuralResolved.every(action => (decisions[action.id!] as any)?.action === 'accept') ? 'complete' : 'keepResolved';
}
