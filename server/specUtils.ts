import { similarityKeyOf } from '../equipment/tagPolicy.js';
/**
 * Compares two JSON spec objects to see if they are different.
 * Returns an object with isDifferent: boolean and a list of changed properties.
 */
export function compareSpecs(oldSpecs: Record<string, string>, newSpecs: Record<string, string>) {
  const changes: { param: string; oldVal: string; newVal: string }[] = [];
  
  // Find modified or deleted keys
  for (const key of Object.keys(oldSpecs)) {
    if (!(key in newSpecs)) {
      changes.push({ param: key, oldVal: oldSpecs[key], newVal: '— (удалено)' });
    } else if (oldSpecs[key] !== newSpecs[key]) {
      changes.push({ param: key, oldVal: oldSpecs[key], newVal: newSpecs[key] });
    }
  }

  // Find newly added keys
  for (const key of Object.keys(newSpecs)) {
    if (!(key in oldSpecs)) {
      changes.push({ param: key, oldVal: '—', newVal: newSpecs[key] });
    }
  }

  return {
    isDifferent: changes.length > 0,
    changes
  };
}

/**
 * Checks if the equipment type has drastically changed on the same position (itemCode).
 * Returns true if there is a type mismatch.
 */
export function detectTypeMismatch(
  oldName: string, 
  newName: string, 
  oldSpecs: Record<string, string>, 
  newSpecs: Record<string, string>
): boolean {
  const oName = oldName.toLowerCase();
  const nName = newName.toLowerCase();

  // 1. Tag name based keywords mismatch check
  const types = [
    { keys: ['вентилят', 'fan', 'шв'], label: 'fan' },
    { keys: ['нагрев', 'калориф', 'heater', 'тэн'], label: 'heater' },
    { keys: ['фильтр', 'filter'], label: 'filter' },
    { keys: ['заслон', 'клапан', 'damper', 'valve'], label: 'valve' },
    { keys: ['шумоглуш', 'silencer'], label: 'silencer' },
    { keys: ['рекупер', 'recuperator'], label: 'recuperator' },
    { keys: ['охладит', 'cooler'], label: 'cooler' }
  ];

  let oldType = '';
  let newType = '';

  for (const t of types) {
    if (t.keys.some(k => oName.includes(k))) oldType = t.label;
    if (t.keys.some(k => nName.includes(k))) newType = t.label;
  }

  if (oldType && newType && oldType !== newType) {
    return true; // Names clearly point to different device types!
  }

  // 2. Specs overlap check
  const oldKeys = Object.keys(oldSpecs);
  const newKeys = Object.keys(newSpecs);

  if (oldKeys.length > 0 && newKeys.length > 0) {
    const commonKeys = oldKeys.filter(k => newKeys.includes(k));
    const maxKeys = Math.max(oldKeys.length, newKeys.length);
    const overlapPercentage = commonKeys.length / maxKeys;

    // If they share less than 20% of parameter keys, it's a structural type mismatch
    if (overlapPercentage < 0.2) {
      return true;
    }
  }

  return false;
}

/**
 * Ключ ручной правки инженера в ComponentElement.overrides.
 *
 * Разделитель — ДВЕ вертикальные черты: так пишет карточка оборудования
 * («вручную» и «оставить моё») и так же читает её интерфейс. Одинарная черта
 * в читающих местах была молчаливой ошибкой: защита «не затирать ручную
 * правку» не срабатывала ни разу — ни в плане импорта, ни в Конструкторе,
 * ни в проверке данных. Одно место на всех, чтобы это не разошлось снова.
 */
export function overrideKey(group: string, key: string): string {
  return `${group}||${key}`;
}

/**
 * Составной ключ блока: система‖моноблок‖код. Уникален в пределах файла и
 * служит адресом позиции всюду — в плане импорта, в правках предпросмотра,
 * в выборе области и в привязке тегов. Живёт здесь, чтобы им могли
 * пользоваться и план, и запись, не завися друг от друга.
 */
export function blockKey(systemName: string, mbName: string, code: string): string {
  return `${systemName}\u2016${mbName}\u2016${code}`;
}

// Нормализация кода установки для сопоставления: регистр, латиница/кириллица, дефисы
function normCode(s: string): string {
  return String(s || '').toLowerCase().replace(/[\s \-_.]/g, '')
    .replace(/y/g, 'у').replace(/mn/g, 'мн').replace(/bl/g, 'бл');
}

/**
 * Найти установку, в которую ляжет ввоз: точное имя, затем то же написание
 * без опечаток раскладки, затем прежнее грубое сравнение.
 *
 * Обозначение теперь исправляется при разборе («…-001А» с кириллической «А»
 * становится «…-001A»), а в реестре могла остаться установка, ввезённая раньше
 * с опечаткой. Без сравнения по похожести повторный ввоз завёл бы ВТОРУЮ
 * установку рядом с первой — со всеми тегами и историей у старой.
 *
 * Функция общая для плана и записи: раньше план сравнивал грубо, а запись —
 * только точно, и предпросмотр обещал «обновим существующую», а в базе
 * появлялась новая.
 */
export function matchSystem<T extends { name: string }>(existing: T[], name: string): { system: T | null; how: 'exact' | 'similar' | 'none' } {
  const exact = existing.find(s => s.name === name);
  if (exact) return { system: exact, how: 'exact' };
  const key = similarityKeyOf(name);
  const similar = existing.find(s => similarityKeyOf(s.name) === key)
    || existing.find(s => normCode(s.name) === normCode(name));
  return similar ? { system: similar, how: 'similar' } : { system: null, how: 'none' };
}
