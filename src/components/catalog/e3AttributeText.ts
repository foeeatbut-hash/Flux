/**
 * Слова справочника атрибутов E3: как назвать источник, типы и правило спора
 * со скриптом человеку. Таблица, карточка и окно плана говорят одинаково.
 */
import { E3_FIELD_TITLES, defaultClassesOf, type E3Attribute, type E3Conflict, type E3Source } from '../../../e3/attributes';
import { classTitle } from '../../../equipment/classes';

export const CONFLICT_TITLES: Record<E3Conflict, string> = {
  'flux': 'Flux главнее',
  'flux-once': 'Flux только первый раз',
  'script': 'Скрипт главнее',
  'ask': 'Спросить',
};

export const SOURCE_KINDS: Array<{ value: E3Source['kind']; label: string }> = [
  { value: 'none', label: 'нет' },
  { value: 'field', label: 'служебное поле' },
  { value: 'param', label: 'характеристика' },
  { value: 'const', label: 'постоянное значение' },
];

export function sourceText(s: E3Source): string {
  if (s.kind === 'field') return E3_FIELD_TITLES[s.key] || s.key;
  if (s.kind === 'param') return s.unit ? `${s.name}, ${s.unit}` : s.name;
  if (s.kind === 'const') return `«${s.value}»`;
  return '';
}

/** Типы Flux словами; пусто — «по классу», как у самой записи */
export function classesText(a: E3Attribute): string {
  return a.classes.length ? a.classes.map(classTitle).join(', ') : '';
}

/** Что даёт «по классу» для основного класса файла: список типов или «все типы» */
export function defaultClassesText(attrClass: string): string {
  const ids = defaultClassesOf(attrClass);
  return ids.length ? ids.map(classTitle).join(', ') : 'все типы';
}

/** Поля из файла — подписи для списка «поле: было → стало» в плане загрузки */
export const FILE_FIELD_TITLES: Record<string, string> = {
  title: 'Описание', carrier: 'Носитель', attrClass: 'Класс', service: 'Служебный', fromFlux: 'Заполняет Flux',
  script: 'Скрипт', comment: 'Комментарий', removed: 'Снят',
};

export function fieldValueText(v: unknown): string {
  if (typeof v === 'boolean') return v ? 'да' : 'нет';
  const t = String(v ?? '').trim();
  return t ? (t.length > 60 ? `${t.slice(0, 60)}…` : t) : 'пусто';
}
