/**
 * Словарь отказов: коды и тексты, когда сервер не записал действие человека
 * (docs/roadmap/offline-work.md, «Решения владельца (15 ноября 2026): отказ при
 * одновременной правке»). Одно место для сервера и клиента: сервер кладёт текст
 * в ответ, клиент берёт его оттуда же там, где ответа нет (например, «уже
 * удалена» после повторного удаления отвечает 200).
 *
 * Без React, сети и базы. Код отказа — отдельное поле ответа и в текст не
 * попадает никогда: человеку код ничего не говорит, а текст, в котором он
 * есть, читается как поломка.
 *
 * Название записи — существительное с формами, а не склеенная строка: «Позицию»,
 * «в установке», «открыта/открыт». Следующая программа добавляет своё слово
 * одной строкой в `NOUNS`, и все тексты для неё готовы.
 *
 * Имена людей — в именительном падеже («открыта у сотрудника: Иванов И. И.»),
 * чтобы не склонять фамилии.
 */

/** Запись изменили после того, как человек её увидел */
export const VERSION_CONFLICT = 'VERSION_CONFLICT';
/** Записи уже нет: её удалили */
export const RECORD_GONE = 'RECORD_GONE';
/** Запись открыта у другого сотрудника — удалить её нельзя */
export const RECORD_OPEN = 'RECORD_OPEN';

export type RefusalCode = typeof VERSION_CONFLICT | typeof RECORD_GONE | typeof RECORD_OPEN;

export interface Noun {
  /** Именительный, строчными: «позиция» */
  nom: string;
  /** Винительный, строчными: «позицию» */
  acc: string;
  /** Предложный («в …»), строчными: «позиции» */
  prep: string;
  /** Род: от него зависят «открыта/открыт», «её/его», «в которую/в который» */
  gender: 'f' | 'm' | 'n';
}

/** Существительные программ. Новое слово — одна строка. */
export const NOUNS = {
  position: { nom: 'позиция', acc: 'позицию', prep: 'позиции', gender: 'f' },
  system: { nom: 'установка', acc: 'установку', prep: 'установке', gender: 'f' },
  block: { nom: 'блок', acc: 'блок', prep: 'блоке', gender: 'm' },
  tag: { nom: 'тег', acc: 'тег', prep: 'теге', gender: 'm' },
  register: { nom: 'реестр', acc: 'реестр', prep: 'реестре', gender: 'm' },
  registerItem: { nom: 'строка реестра', acc: 'строку реестра', prep: 'строке реестра', gender: 'f' },
  file: { nom: 'файл', acc: 'файл', prep: 'файле', gender: 'm' },
  project: { nom: 'проект', acc: 'проект', prep: 'проекте', gender: 'm' },
  dictionary: { nom: 'справочник', acc: 'справочник', prep: 'справочнике', gender: 'm' },
  dictionaryItem: { nom: 'пункт справочника', acc: 'пункт справочника', prep: 'пункте справочника', gender: 'm' },
  tagTemplate: { nom: 'шаблон тегов', acc: 'шаблон тегов', prep: 'шаблоне тегов', gender: 'm' },
} as const satisfies Record<string, Noun>;

export type RefusalNoun = keyof typeof NOUNS;

/** Кто держит запись открытой */
export interface Holder { userId?: string; name: string }

const up = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
/** «Название» в кавычках-ёлочках или ничего, если названия нет */
const quoted = (name: unknown): string => {
  const n = String(name ?? '').trim();
  return n ? ` «${n}»` : '';
};
const byGender = (n: Noun, f: string, m: string, other = m): string => (n.gender === 'f' ? f : n.gender === 'm' ? m : other);

/**
 * «у сотрудника: Иванов И. И.» — без склонения, имена как в карточке человека.
 * Конец фразы вместе с точкой: имя может само кончаться точкой («И. И.»), и
 * вторая была бы лишней.
 */
function holdersText(holders: readonly Holder[]): string {
  const names = Array.from(new Set(holders.map((h) => String(h?.name ?? '').trim()).filter(Boolean)));
  const who = names.length === 0 ? 'у другого сотрудника'
    : `${names.length === 1 ? 'у сотрудника' : 'у сотрудников'}: ${names.join(', ')}`;
  return who.endsWith('.') ? who : `${who}.`;
}

/** Правка изменённой записи */
export function editChangedText(noun: RefusalNoun, name?: unknown): string {
  const n = NOUNS[noun];
  return `${up(n.acc)}${quoted(name)} изменили, пока вы ${byGender(n, 'её', 'его')} правили. Ваша правка не записана и осталась на месте. Ниже — что изменилось.`;
}

/** Удаление изменённой записи */
export function deleteChangedText(noun: RefusalNoun, name?: unknown): string {
  const n = NOUNS[noun];
  return `${up(n.acc)}${quoted(name)} изменили после того, как вы ${byGender(n, 'её', 'его')} открыли, поэтому ${byGender(n, 'она не удалена', 'он не удалён')}. Ниже — что изменилось. Если удалить всё равно нужно — повторите.`;
}

/** Создание записи внутри изменённой */
export function createInsideChangedText(noun: RefusalNoun, name?: unknown): string {
  const n = NOUNS[noun];
  return `${up(n.acc)}${quoted(name)}, ${byGender(n, 'в которую', 'в который')} вы добавляете, изменили. Новая запись не создана, введённое осталось в окне. Ниже — что изменилось.`;
}

/** Массовое действие по предпросмотру: часть записей изменили, пока человек смотрел */
export function bulkChangedText(): string {
  return 'Пока вы смотрели предпросмотр, часть записей изменили. Ничего не записано. Ниже — что изменилось; проверьте и подтвердите заново.';
}

/** Правка удалённой записи (404) */
export function editGoneText(noun: RefusalNoun, name?: unknown): string {
  const n = NOUNS[noun];
  return `${up(n.acc)}${quoted(name)} уже удалили. Ваша правка не записана.`;
}

/** Создание внутри удалённой записи (404) */
export function createInsideGoneText(noun: RefusalNoun): string {
  const n = NOUNS[noun];
  return `${up(n.acc)}, ${byGender(n, 'в которую', 'в который')} вы добавляете, уже удалили. Новая запись не создана.`;
}

/** Повторное удаление: сервер отвечает 200, а экран говорит это сам */
export function deleteGoneText(noun: RefusalNoun): string {
  const n = NOUNS[noun];
  return `${up(n.nom)} уже ${byGender(n, 'удалена', 'удалён', 'удалено')}.`;
}

/** Удаление открытой записи */
export function deleteOpenText(noun: RefusalNoun, name: unknown, holders: readonly Holder[]): string {
  const n = NOUNS[noun];
  return `${up(n.nom)}${quoted(name)} сейчас ${byGender(n, 'открыта', 'открыт', 'открыто')} ${holdersText(holders)} Удалить ${byGender(n, 'её', 'его')} нельзя, пока запись открыта.`;
}

/** Удаление записи, у которой открыта вложенная (удаляется вместе с ней) */
export function deleteOpenNestedText(outer: { noun: RefusalNoun; name?: unknown }, inner: { noun: RefusalNoun; name?: unknown }, holders: readonly Holder[]): string {
  const o = NOUNS[outer.noun];
  const i = NOUNS[inner.noun];
  return `В ${o.prep}${quoted(outer.name)} сейчас ${byGender(i, 'открыта', 'открыт', 'открыто')} ${i.nom}${quoted(inner.name)} ${holdersText(holders)} Удалить ${o.acc} нельзя, пока запись открыта.`;
}

/** Открытые у других записи прочесть не удалось: удалять вслепую нельзя (ответ 503) */
export function openCheckUnavailableText(): string {
  return 'Не удалось проверить, открыта ли запись у других сотрудников. Ничего не удалено — повторите позже.';
}

/** Две записи одновременно, версии у клиента не было (старая сборка) */
export function racedText(): string {
  return 'Запись меняют одновременно, повторите действие.';
}

/** Сравнение показанных полей не нашло различий */
export function nothingChangedText(): string {
  return 'Изменения не затронули то, что показано на экране.';
}

/**
 * Массовое действие по строкам, у которого каждая запись сверяется отдельно (ВДР: «назначить исполнителя»,
 * «заполнить английские названия»): часть строк записана, остальные изменили или удалили, пока человек выбирал.
 */
export function bulkPartialText(written: number, total: number): string {
  if (written <= 0) return 'Ничего не записано: выбранные строки изменили или удалили, пока вы выбирали. Ниже — что с каждой; проверьте и повторите.';
  return `Записано строк: ${written} из ${total}. Остальные не записаны: их изменили или удалили, пока вы выбирали. Ниже — что с каждой; проверьте и повторите для них.`;
}

/** Массовое действие по выбранным записям без предпросмотра (этап закупки, шаблон этапов): всё или ничего */
export function bulkSelectionChangedText(): string {
  return 'Часть выбранных записей успели изменить или удалить. Ничего не записано. Ниже — что изменилось; проверьте и повторите.';
}
