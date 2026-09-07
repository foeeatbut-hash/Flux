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
