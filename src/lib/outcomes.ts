/**
 * Итог действия над несколькими предметами сразу.
 *
 * Зачем. Массовое удаление в Проводнике запускало удаления и НЕ ждало их, а
 * сразу показывало «Перемещено в корзину: 5 элементов». Отказ по любому из них
 * в это сообщение не попадал вовсе: выбор уже очищен, список перечитан, и файл,
 * который сервер отказался удалять, просто оставался на месте — как будто
 * человек его и не выбирал. Через день он спрашивает, почему «удалённое»
 * вернулось, и ответить нечем.
 *
 * Правило отделено от экрана, потому что формулировка здесь — не украшение:
 * «5 перемещены» и «4 перемещены, 1 не удалось» ведут человека к разным
 * следующим действиям, и перепутать их нельзя.
 */

import { countOf, type WordKey } from './plural';

/** Чем закончилось одно действие в пачке. */
export interface ItemOutcome {
  id: string;
  ok: boolean;
  /** Почему не вышло — это же покажем человеку */
  error?: string;
}

/** Итог пачки: сколько вышло, что осталось и что сказать. */
export interface BatchOutcome {
  done: number;
  failed: string[];
  /** Причины без повторов: пять одинаковых «нет прав» — это одна новость */
  reasons: string[];
  text: string;
  tone: 'success' | 'error' | 'info';
}

/**
 * Свести исходы в одну новость.
 *
 * `noun` — то, над чем работали: ключ общего словаря форм (`lib/plural`),
 * чтобы «1 элемент» и «5 элементов» не расходились с остальной программой.
 */
export function summarize(items: ItemOutcome[], noun: WordKey, verb: {
  done: string;
  failed: string;
}): BatchOutcome {
  const good = items.filter((i) => i.ok);
  const bad = items.filter((i) => !i.ok);
  const reasons = [...new Set(bad.map((i) => i.error || '').filter(Boolean))];

  const done = good.length;
  const failed = bad.map((i) => i.id);

  // Полный успех и полный отказ — короткие фразы. Частичный обязан назвать оба
  // числа: это единственный случай, когда человеку надо что-то доделать
  if (!bad.length) {
    return {
      done, failed, reasons, tone: 'success',
      text: `${verb.done}: ${countOf(done, noun)}`,
    };
  }
  if (!good.length) {
    return {
      done, failed, reasons, tone: 'error',
      text: reasons.length === 1
        ? `${verb.failed}: ${reasons[0]}`
        : `${verb.failed}: ${countOf(bad.length, noun)}`,
    };
  }
  return {
    done, failed, reasons, tone: 'error',
    text: `${verb.done}: ${done}, не вышло: ${bad.length}`
      + (reasons.length === 1 ? ` — ${reasons[0]}` : ''),
  };
}

/**
 * Автор записи журнала.
 *
 * Журнал сводит два источника: события проекта (у них есть символ сотрудника) и
 * действия, которые пишет сервер (у них есть `userId`). Списку авторов раньше
 * доставался символ, и всем серверным действиям он ставился ПУСТЫМ — в
 * результате `Map` по этому ключу схлопывала всех в одну запись, счётчик людей
 * занижался, а выбрать такого автора в фильтре было нельзя вовсе: пустая
 * строка означала «все».
 *
 * Поэтому ключ автора — отдельное понятие, и у каждой записи он свой.
 */
export const ALL_AUTHORS = '__all__';

export function authorKey(row: { userId?: string; userSymbol?: string; userName?: string }): string {
  if (row.userId) return `id:${row.userId}`;
  if (row.userSymbol) return `sym:${row.userSymbol}`;
  // Ни того ни другого: имя — последнее, чем можно различить людей. Плохо, но
  // лучше, чем свалить их в кучу
  return `name:${row.userName || 'неизвестно'}`;
}

export function authorLabel(row: { userSymbol?: string; userName?: string }): string {
  const name = row.userName || 'Сотрудник';
  return row.userSymbol ? `${name} (${row.userSymbol})` : name;
}

/** Уникальные авторы списка, по одному на человека. */
export function authorsOf<T extends { userId?: string; userSymbol?: string; userName?: string }>(
  rows: T[],
): { key: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const r of rows) {
    const k = authorKey(r);
    if (!seen.has(k)) seen.set(k, authorLabel(r));
  }
  return [...seen.entries()]
    .map(([key, label]) => ({ key, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
