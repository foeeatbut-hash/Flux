/**
 * Разметка таблицы и разбор расхождений.
 *
 * Главное здесь — четыре состояния клетки. Их легко свести к двум («сошлось /
 * не сошлось»), и тогда обновление данных проекта затирает то, что человек
 * поправил руками. Это самая дорогая ошибка в этой работе, и проверяется она
 * первой.
 *
 * Запуск: npx tsx scripts/test-table-layout.ts
 */

import {
  GRAINS, grainById, emptyLayout, bindColumn, unbindColumn, columnAt, headerText,
  diffLayout, layoutToTemplate, templateToLayout, readTemplateBody, whyNotSaveTemplate,
  type LayoutColumn,
} from '../src/lib/tableLayout';

let failed = 0;
const ok = (name: string, cond: boolean, detail?: unknown) =>
  cond
    ? console.log('  ✓', name)
    : (failed++, console.error('  ✗', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)));

console.log('1. Виды строки объявлены списком');
{
  ok('тег и позиция на месте', GRAINS.length >= 2 && !!grainById('tag') && !!grainById('element'));
  ok('неизвестный вид не роняет, а даёт первый', grainById('бланк-заказа').id === 'tag');
  ok('у каждого вида сказано, откуда брать постоянные поля',
    GRAINS.every(g => g.fieldsKey === 'tagFields' || g.fieldsKey === 'elementFields'));
}

console.log('\n2. Разметка по ячейке');
{
  let l = emptyLayout('tag', 0);
  ok('пустая разметка — ни одного столбца', l.columns.length === 0);

  l = bindColumn(l, 0, { path: 'identifier', title: 'Тег' });
  l = bindColumn(l, 1, { path: 'param:Аэродинамика|Расход', title: 'Расход', unit: 'м³/ч' });
  ok('два поля привязаны', l.columns.length === 2);
  ok('поле находится по номеру столбца', columnAt(l, 1)?.path === 'param:Аэродинамика|Расход');

  // Человек ткнул не туда и исправился — это одно действие, а не два столбца
  l = bindColumn(l, 1, { path: 'brand', title: 'Марка' });
  ok('повторный выбор заменяет, а не добавляет', l.columns.length === 2, l.columns);
  ok('в столбце стоит последнее выбранное', columnAt(l, 1)?.path === 'brand');

  // Расход в м³/ч и он же в л/с рядом — законная таблица
  l = bindColumn(l, 5, { path: 'param:Аэродинамика|Расход', title: 'Расход', unit: 'л/с' });
  ok('одно поле в двух столбцах разрешено', l.columns.length === 3);

  // Пропуск столбца — обычное дело: разметили A, B и F
  ok('столбцы идут по возрастанию номера',
    l.columns.map(c => c.col).join(',') === '0,1,5', l.columns.map(c => c.col));

  l = unbindColumn(l, 1);
  ok('поле снимается', l.columns.length === 2 && !columnAt(l, 1));
  ok('снятие чужого столбца ничего не портит', unbindColumn(l, 99).columns.length === 2);
}

console.log('\n3. Что стоит в шапке');
{
  ok('единица уходит в шапку', headerText({ path: 'p', title: 'Расход', unit: 'м³/ч' }) === 'Расход, м³/ч');
  ok('дважды единицу не дописываем',
    headerText({ path: 'p', title: 'Ширина В, мм', unit: 'мм' }) === 'Ширина В, мм');
  ok('без единицы — просто подпись', headerText({ path: 'p', title: 'Тег' }) === 'Тег');
}

console.log('\n4. Расхождения: четыре разных разговора');
{
  const columns: LayoutColumn[] = [
    { col: 0, path: 'identifier', title: 'Тег' },
    { col: 1, path: 'brand', title: 'Марка' },
  ];
  const wasKeys = ['tag:1', 'tag:2', 'tag:3'];
  // Что записали прошлой сборкой
  const written = [['AHU-1', 'ВЕРОСА-670'], ['AHU-2', 'ВЕРОСА-600'], ['AHU-3', 'ВИР-800']];
  // Что стоит в листе сейчас: во второй строке человек поправил марку
  const current = [['AHU-1', 'ВЕРОСА-670'], ['AHU-2', 'ВЕРОСА-600 (уточнить)'], ['AHU-3', 'ВИР-800']];
  // Что говорит проект: в первой строке марка изменилась, в третьей — и марка,
  // и человек уже правил (готовим конфликт отдельно)
  const fresh = new Map<string, string[]>([
    ['tag:1', ['AHU-1', 'ВЕРОСА-672']],
    ['tag:2', ['AHU-2', 'ВЕРОСА-600']],
    ['tag:3', ['AHU-3', 'ВИР-800']],
    ['tag:4', ['AHU-4', 'ОСА-Е466']],
  ]);

  const d = diffLayout({ wasKeys, written, current, fresh, columns });

  const byKey = (k: string) => d.cells.filter(c => c.key === k);
  ok('проект уехал — можно обновлять',
    byKey('tag:1')[0]?.state === 'changed' && byKey('tag:1')[0]?.fresh === 'ВЕРОСА-672', byKey('tag:1'));
  ok('правка человека не выдаётся за изменение проекта',
    byKey('tag:2')[0]?.state === 'manual', byKey('tag:2'));
  ok('совпавшее не попадает в список вовсе', byKey('tag:3').length === 0);
  ok('видно и что было, и что станет',
    byKey('tag:1')[0]?.written === 'ВЕРОСА-670' && byKey('tag:1')[0]?.current === 'ВЕРОСА-670');

  ok('появившаяся в проекте строка названа', d.added.map(a => a.key).join() === 'tag:4', d.added);
  ok('пропавших нет', d.gone.length === 0);
  ok('посчитано, сколько безопасно обновить', d.safe === 1, d.safe);
  ok('и сколько требуют решения', d.asks === 1, d.asks);
}

console.log('\n4.1. Обе стороны разошлись — решает человек');
{
  const columns: LayoutColumn[] = [{ col: 0, path: 'brand', title: 'Марка' }];
  const d = diffLayout({
    wasKeys: ['tag:1'],
    written: [['ВЕРОСА-670']],
    current: [['ВЕРОСА-670 (мой вариант)']],
    fresh: new Map([['tag:1', ['ВЕРОСА-672']]]),
    columns,
  });
  ok('это конфликт, а не «изменилось в проекте»', d.cells[0]?.state === 'conflict', d.cells[0]);
  ok('в безопасные не попал', d.safe === 0);
  ok('показаны все три величины',
    d.cells[0]?.written === 'ВЕРОСА-670'
    && d.cells[0]?.current === 'ВЕРОСА-670 (мой вариант)'
    && d.cells[0]?.fresh === 'ВЕРОСА-672');
}

console.log('\n4.2. Пропавшее из проекта не выдаётся за изменение');
{
  const columns: LayoutColumn[] = [{ col: 0, path: 'brand', title: 'Марка' }];
  const d = diffLayout({
    wasKeys: ['tag:1', 'tag:2'],
    written: [['A'], ['B']],
    current: [['A'], ['B']],
    fresh: new Map([['tag:1', ['A']]]),
    columns,
    titleOf: (k) => (k === 'tag:2' ? 'AHU-2' : k),
  });
  ok('строка названа пропавшей', d.gone.map(g => g.title).join() === 'AHU-2', d.gone);
  ok('и её значения не пошли в расхождения', d.cells.length === 0, d.cells);
}

console.log('\n5. Шаблон шапки');
{
  let l = emptyLayout('element', 3);
  l = bindColumn(l, 2, { path: 'itemCode', title: 'Код позиции' });
  l = bindColumn(l, 3, { path: 'param:Электрика|Мощность', title: 'Мощность', unit: 'кВт' });
  l.filters = [{ field: 'equipType', op: 'eq', value: 'valve' }];

  const body = layoutToTemplate(l);
  ok('в шаблоне нет номеров столбцов', !JSON.stringify(body).includes('"col"'), body);
  ok('порядок полей сохранён', body.columns.map(c => c.path).join() === 'itemCode,param:Электрика|Мощность');
  ok('вид строки сохранён', body.grain === 'element');
  ok('фильтр сохранён', body.filters.length === 1);

  // Применяем в другой книге, от другой клетки
  const back = templateToLayout(body, { row: 0, col: 0 });
  ok('поля легли подряд от выбранной клетки',
    back.columns.map(c => c.col).join() === '0,1', back.columns.map(c => c.col));
  ok('подписи и единицы доехали',
    back.columns[1].title === 'Мощность' && back.columns[1].unit === 'кВт');
  ok('шапка встала туда, куда просили', back.headerRow === 0);

  ok('чужое содержимое не роняет разбор', readTemplateBody('не json').columns.length === 0);
  ok('и пустое тоже', readTemplateBody(null).grain === 'tag');
  ok('битые столбцы отбрасываются',
    readTemplateBody('{"columns":[{"title":"без пути"},{"path":"ok","title":"Годный"}]}').columns.length === 1);

  ok('без имени не сохраняем', !!whyNotSaveTemplate('', l));
  ok('пустую шапку не сохраняем', !!whyNotSaveTemplate('Ведомость', emptyLayout()));
  ok('названную и заполненную — сохраняем', whyNotSaveTemplate('Ведомость автоматики', l) === '');
}

console.log(failed ? `\nПРОВАЛОВ: ${failed}` : '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ');
process.exit(failed ? 1 : 0);
