/** Состав документации для класса оборудования проекта. */
export interface DocflowKitItem {
  docType: string; stage: '' | 'П' | 'Р'; unit: 'tag' | 'group' | 'project';
  necessity: 'required' | 'customer' | 'optional'; responsibleRole: string; milestone: string; workdays: number;
  condition: null | { parameter: string; operator: 'exists' | 'equals' | 'notEquals'; value: string };
}
export interface DocflowKit { classId: string; items: DocflowKitItem[] }
const str = (v: unknown) => typeof v === 'string' ? v.trim() : '';
const isObject = (v: any) => !!v && typeof v === 'object' && !Array.isArray(v);
const unknown = (v: any, keys: string[]) => Object.keys(v).some(key => !keys.includes(key));
const defaults = (docType: string): DocflowKitItem => ({ docType, stage: '', unit: 'tag', necessity: 'required', responsibleRole: '', milestone: '', workdays: 0, condition: null });

/** Ошибки исходного ввода проверяются до нормализации: лишние поля не теряются молча. */
export function kitErrors(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return ['Комплекты должны быть списком'];
  const errors: string[] = []; const classes = new Set<string>(); let total = 0;
  if (value.length > 500) errors.push('Допустимо не более 500 классов');
  value.forEach((kit: any, index) => {
    const prefix = `Комплект ${index + 1}`;
    if (!isObject(kit)) { errors.push(`${prefix}: неверная запись`); return; }
    if (unknown(kit, ['classId', 'items', 'types'])) errors.push(`${prefix}: неизвестные поля`);
    const id = str(kit.classId);
    if (!id || id.length > 200) errors.push(`${prefix}: укажите класс длиной до 200 символов`);
    if (id && classes.has(id)) errors.push(`${prefix}: класс указан повторно`);
    classes.add(id);
    if (kit.items !== undefined && kit.types !== undefined) errors.push(`${prefix}: два формата состава`);
    const entries = kit.items === undefined && Array.isArray(kit.types) ? kit.types.map((type: unknown) => defaults(str(type))) : kit.items;
    if (!Array.isArray(entries)) { errors.push(`${prefix}: состав должен быть списком`); return; }
    total += entries.length; if (entries.length > 100) errors.push(`${prefix}: не более 100 документов`);
    const keys = new Set<string>();
    entries.forEach((item: any, i: number) => {
      const label = `${prefix}, строка ${i + 1}`;
      if (!isObject(item)) { errors.push(`${label}: неверная запись`); return; }
      if (unknown(item, ['docType','stage','unit','necessity','responsibleRole','milestone','workdays','condition'])) errors.push(`${label}: неизвестные поля`);
      for (const key of ['docType','responsibleRole','milestone']) if (typeof item[key] !== 'string' || item[key].trim().length > 200 || (key === 'docType' && !item[key].trim())) errors.push(`${label}: неверное поле ${key}`);
      if (!['','П','Р'].includes(item.stage)) errors.push(`${label}: неверная стадия`);
      if (!['tag','group','project'].includes(item.unit)) errors.push(`${label}: неверная единица`);
      if (!['required','customer','optional'].includes(item.necessity)) errors.push(`${label}: неверная обязательность`);
      if (!Number.isInteger(item.workdays) || item.workdays < 0 || item.workdays > 3650) errors.push(`${label}: срок должен быть целым от 0 до 3650`);
      const key = `${str(item.docType)}\0${item.unit}`; if (keys.has(key)) errors.push(`${label}: тип и единица повторяются`); keys.add(key);
      if (item.condition !== null) {
        const c = item.condition;
        if (!isObject(c) || unknown(c, ['parameter','operator','value']) || typeof c.parameter !== 'string' || !c.parameter.trim() || c.parameter.trim().length > 240 || !['exists','equals','notEquals'].includes(c.operator) || typeof c.value !== 'string' || c.value.length > 500) errors.push(`${label}: неверное условие`);
      }
    });
  });
  if (total > 5000) errors.push('Допустимо не более 5000 документов');
  return errors;
}

/** Старые types переводятся в строки с безопасными умолчаниями. */
export function normalizeKit(value: any): DocflowKit {
  const source = Array.isArray(value?.items) ? value.items : Array.isArray(value?.types) ? value.types.map((x: unknown) => defaults(str(x))) : [];
  return { classId: str(value?.classId).slice(0, 200), items: source.slice(0, 100).filter(isObject).map((x: any) => ({
    docType: str(x.docType).slice(0, 200), stage: x.stage === 'П' || x.stage === 'Р' ? x.stage : '', unit: x.unit === 'group' || x.unit === 'project' ? x.unit : 'tag',
    necessity: x.necessity === 'customer' || x.necessity === 'optional' ? x.necessity : 'required', responsibleRole: str(x.responsibleRole).slice(0, 200), milestone: str(x.milestone).slice(0, 200),
    workdays: Number.isInteger(x.workdays) ? Math.max(0, Math.min(3650, x.workdays)) : 0,
    condition: isObject(x.condition) && str(x.condition.parameter) ? { parameter: str(x.condition.parameter).slice(0, 240), operator: x.condition.operator === 'equals' || x.condition.operator === 'notEquals' ? x.condition.operator : 'exists', value: typeof x.condition.value === 'string' ? x.condition.value.slice(0, 500) : '' } : null,
  })) };
}
export function normalizeKits(value: unknown): DocflowKit[] {
  if (!Array.isArray(value)) return [];
  let remaining = 5000;
  return value.slice(0, 500).filter(isObject).map(raw => {
    const kit = normalizeKit(raw);
    kit.items = kit.items.slice(0, remaining);
    remaining -= kit.items.length;
    return kit;
  });
}
