/** Соответствия типов оборудования классам каталога в настройках проекта. */
export interface EquipmentClassMapping { type: string; classId: string }
const LIMIT = 100;
const normalized = (value: unknown) => typeof value === 'string' ? value.trim() : '';

/** Для записи: ошибки не позволяют незаметно отбросить или сократить строки. */
export function classMappingErrors(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return ['Соответствия классов должны быть списком'];
  const errors: string[] = [];
  if (value.length > 500) errors.push('Допустимо не более 500 соответствий');
  const seen = new Set<string>();
  value.forEach((row, index) => {
    const type = normalized(row?.type).toUpperCase();
    const classId = normalized(row?.classId);
    if (!type || !classId) errors.push(`Строка ${index + 1}: укажите тип и класс`);
    if (type.length > LIMIT || classId.length > LIMIT) errors.push(`Строка ${index + 1}: тип и класс не длиннее ${LIMIT} символов`);
    if (type && seen.has(type)) errors.push(`Строка ${index + 1}: тип ${type} указан повторно`);
    if (type) seen.add(type);
  });
  return errors;
}

/** Прежние и повреждённые настройки читаются без падения, корректные строки сохраняются. */
export function normalizeClassMappings(value: unknown): EquipmentClassMapping[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: EquipmentClassMapping[] = [];
  for (const row of value) {
    const type = normalized(row?.type).toUpperCase();
    const classId = normalized(row?.classId);
    if (!type || !classId || type.length > LIMIT || classId.length > LIMIT || seen.has(type)) continue;
    seen.add(type); result.push({ type, classId });
    if (result.length === 500) break;
  }
  return result;
}
