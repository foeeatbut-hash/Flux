/**
 * Итог действия над пачкой и авторы журнала.
 *
 * Два правила, каждое из которых стоило дефекта.
 *
 * Первое: массовое удаление в Проводнике не ждало ответов и всегда говорило
 * «Перемещено в корзину: 5 элементов». Отказ по любому из них в сообщение не
 * попадал, выбор очищался, и неудалённый файл оставался на месте — будто его и
 * не выбирали. Частичный отказ обязан называть ОБА числа.
 *
 * Второе: журнал сводит два источника, и серверным действиям ставился пустой
 * символ сотрудника. Список авторов строился по нему и схлопывал всех в одну
 * запись; пустая строка вдобавок означала «все», так что выбрать такого автора
 * было нельзя вовсе.
 *
 * Запуск: npx tsx scripts/test-outcomes.ts
 */

import { summarize, authorKey, authorLabel, authorsOf, ALL_AUTHORS } from '../src/lib/outcomes';

let failed = 0;
const ok = (name: string, cond: boolean, detail?: unknown) =>
  cond
    ? console.log('  ✓', name)
    : (failed++, console.error('  ✗', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)));

const VERB = { done: 'Перемещено в корзину', failed: 'Не удалось удалить' };

console.log('1. Полный успех');
{
  const out = summarize([{ id: 'a', ok: true }, { id: 'b', ok: true }], 'элемент', VERB);
  ok('сказано, сколько вышло', out.text === 'Перемещено в корзину: 2 элемента', out.text);
  ok('тон радостный', out.tone === 'success');
  ok('невыполненных нет', out.failed.length === 0);
  ok('склонение по числу', summarize([{ id: 'a', ok: true }], 'элемент', VERB).text.endsWith('1 элемент'),
    summarize([{ id: 'a', ok: true }], 'элемент', VERB).text);
  ok('пять — «элементов»',
    summarize(Array.from({ length: 5 }, (_, i) => ({ id: String(i), ok: true })), 'элемент', VERB)
      .text.endsWith('5 элементов'));
}

console.log('\n2. Частичный отказ — вот ради чего всё');
{
  const out = summarize([
    { id: 'a', ok: true }, { id: 'b', ok: true }, { id: 'c', ok: false, error: 'нет прав' },
  ], 'элемент', VERB);

  ok('названы оба числа', out.text.includes('2') && out.text.includes('1'), out.text);
  ok('это НЕ успех', out.tone === 'error', out.tone);
  ok('причина названа', out.text.includes('нет прав'), out.text);
  // Неудавшиеся возвращаются вызывающему: их оставляют выбранными
  ok('неудавшийся назван по имени', out.failed.join() === 'c', out.failed);
  ok('успешных посчитано', out.done === 2);
}

console.log('\n3. Полный отказ');
{
  const one = summarize([{ id: 'a', ok: false, error: 'нет прав' }], 'элемент', VERB);
  ok('одна причина — она и в тексте', one.text === 'Не удалось удалить: нет прав', one.text);

  const many = summarize([
    { id: 'a', ok: false, error: 'нет прав' }, { id: 'b', ok: false, error: 'файл занят' },
  ], 'элемент', VERB);
  ok('причин несколько — называем число', many.text === 'Не удалось удалить: 2 элемента', many.text);
  ok('обе причины сохранены для разбора', many.reasons.length === 2, many.reasons);
}

console.log('\n4. Повторяющиеся причины не множатся');
{
  // Пять одинаковых «нет прав» — это одна новость, а не пять
  const out = summarize(
    Array.from({ length: 5 }, (_, i) => ({ id: String(i), ok: false, error: 'нет прав' })),
    'элемент', VERB,
  );
  ok('причина одна', out.reasons.length === 1, out.reasons);
  ok('и она в тексте', out.text.includes('нет прав'), out.text);
}

console.log('\n5. Пусто');
{
  const out = summarize([], 'элемент', VERB);
  ok('ничего не делали — и говорить нечего страшного', out.done === 0 && out.failed.length === 0);
  ok('тон не тревожный', out.tone === 'success');
}

console.log('\n6. Авторы журнала различаются');
{
  // Два РАЗНЫХ сотрудника, у обоих символа нет — ровно случай серверных
  // действий, на котором список схлопывал их в одного
  const rows = [
    { userId: 'u1', userName: 'Иванов', userSymbol: '' },
    { userId: 'u2', userName: 'Петров', userSymbol: '' },
    { userId: 'u1', userName: 'Иванов', userSymbol: '' },
  ];
  const authors = authorsOf(rows);
  ok('людей двое, а не один', authors.length === 2, authors);
  ok('ключи разные', authorKey(rows[0]) !== authorKey(rows[1]));
  ok('один и тот же человек — один ключ', authorKey(rows[0]) === authorKey(rows[2]));

  // События проекта различаются символом
  const bySym = [
    { userSymbol: 'ИИ', userName: 'Иванов' },
    { userSymbol: 'ПП', userName: 'Петров' },
  ];
  ok('символы тоже различают', authorsOf(bySym).length === 2);
  ok('подпись с символом', authorLabel(bySym[0]) === 'Иванов (ИИ)', authorLabel(bySym[0]));
  ok('без символа — просто имя', authorLabel({ userName: 'Иванов' }) === 'Иванов');

  // Совсем без опознавательных знаков — хотя бы по имени, а не в общую кучу
  const noIds = [{ userName: 'Иванов' }, { userName: 'Петров' }];
  ok('без id и символа различаем по имени', authorsOf(noIds).length === 2, authorsOf(noIds));

  ok('список отсортирован', authorsOf(bySym)[0].label < authorsOf(bySym)[1].label);
}

console.log('\n7. «Все сотрудники» — отдельное значение');
{
  // Раньше «все» и «автор без символа» были одной и той же пустой строкой
  ok('у «всех» свой ключ', String(ALL_AUTHORS).length > 0);
  ok('и он не совпадает ни с одним автором',
    authorKey({ userId: 'u1' }) !== ALL_AUTHORS
    && authorKey({ userSymbol: 'ИИ' }) !== ALL_AUTHORS
    && authorKey({ userName: 'Иванов' }) !== ALL_AUTHORS);
  ok('даже у автора совсем без данных', authorKey({}) !== ALL_AUTHORS, authorKey({}));
}

console.log(failed ? `\nПРОВАЛОВ: ${failed}` : '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ');
process.exit(failed ? 1 : 0);
