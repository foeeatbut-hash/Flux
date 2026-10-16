export interface EquipmentIdentitySource {
  name: string;
  specs?: string;
}

/** Единообразно сокращает имя и модель позиции в обзоре и компактной навигации. */
export function equipmentIdentityOf(component: EquipmentIdentitySource): { name: string; model: string } {
  const raw = String(component.name || '').trim();
  const split = raw.match(/^(Клапан|Электропривод|Теплообменник|Узел регулирующий|Бак|Вентилятор|Электродвигатель|Выключатель светильника|Сервисный выключатель)\s+(.+?)(?:\s+(№\d+))?$/iu);
  if (split) return { name: split[1] + (split[3] ? ' ' + split[3] : ''), model: split[2].trim() };
  let model: unknown = '';
  try {
    const rawSpecs = typeof component.specs === 'string' ? JSON.parse(component.specs) : component.specs;
    model = (Array.isArray(rawSpecs?.groups) ? rawSpecs.groups : [])
      .flatMap((group: any) => group.params || [])
      .find((param: any) => /^(кассета 1|теплообменник|вентилятор|клапан|узел обвязки|электродвигатель|электропривод)$/iu.test(String(param.key || ''))
        && String(param.value || '').trim() && String(param.value).trim() !== '-')?.value;
  } catch { /* Некорректные характеристики не должны скрывать имя позиции. */ }
  const compact = raw.replace(/^Блок воздухоприемный.*$/iu, 'Воздухоприёмный')
    .replace(/^Воздухонагреватель жидкостный.*$/iu, 'Нагреватель')
    .replace(/^Воздухоохладитель.*$/iu, 'Охладитель')
    .replace(/^Фильтр карманный.*$/iu, 'Фильтр')
    .replace(/^Вентилятор.*$/iu, 'Вентилятор');
  return { name: compact, model: String(model || '') };
}

export function equipmentIdentityText(component: EquipmentIdentitySource): string {
  const identity = equipmentIdentityOf(component);
  return [identity.name, identity.model].filter(Boolean).join(' ');
}
