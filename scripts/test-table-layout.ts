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
  catalogFields, searchFields, bySection, asArray,
  type LayoutColumn,
} from '../src/lib/tableLayout';
import {
  paintHeader, clearHeaderCell, readColumnValues, writeColumnValues, clearColumnValues,
  nextFreeColumn,
} from '../src/lib/tableBlock';

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

  // Дефект из настоящего пакета диагностики: POST /api/table-templates трижды
  // отвечал 400, и человек видел «шаблон не сохраняется». Разбор списка был
  // написан для строки из базы, а применялся к уже разобранному телу запроса:
  // String(массив) даёт «[object Object]», разбор падал, список становился
  // пустым, и сервер отвечал «В шапке нет ни одного поля» на заполненную шапку
  ok('разобранный массив из запроса не теряется',
    asArray([{ path: 'identifier', title: 'Тег' }]).length === 1, asArray([{ path: 'a', title: 'b' }]));
  ok('строка из базы по-прежнему читается',
    asArray('[{"path":"identifier","title":"Тег"}]').length === 1);
  ok('чужое содержимое даёт пустой список, а не падение', asArray('не json').length === 0);
  ok('пустое тоже', asArray(null).length === 0 && asArray(undefined).length === 0);

  ok('без имени не сохраняем', !!whyNotSaveTemplate('', l));
  ok('пустую шапку не сохраняем', !!whyNotSaveTemplate('Ведомость', emptyLayout()));
  ok('названную и заполненную — сохраняем', whyNotSaveTemplate('Ведомость автоматики', l) === '');
}

console.log('\n5.1. Каталог: собрать можно каждое значение проекта');
{
  const catalog = {
    counts: { tags: 41, elements: 120 },
    tagFields: [{ path: 'identifier', title: 'Тег' }, { path: 'brand', title: 'Марка' }],
    elementFields: [{ path: 'itemCode', title: 'Код позиции' }],
    // Характеристики НЕ объявлены в программе — они пришли из бланков проекта
    params: [
      { group: 'Аэродинамика', key: 'Расход воздуха', unit: 'м³/ч', count: 38, sample: '23150' },
      { group: 'Электрика', key: 'Мощность', unit: 'кВт', count: 12, sample: '22' },
    ],
    metaKeys: [{ path: 'meta:зона', key: 'зона', count: 9 }],
    aliases: [{ path: 'param:@Расход', title: 'Расход', unit: 'м³/ч', members: [], count: 40 }],
  };

  const forTag = catalogFields(catalog, 'tag');
  ok('характеристики из бланков попали в список',
    forTag.some(f => f.path === 'param:Аэродинамика|Расход воздуха'), forTag.map(f => f.path));
  ok('и постоянные поля тоже', forTag.some(f => f.path === 'identifier'));
  ok('своё поле идёт первым', forTag[0].section === 'Свои поля', forTag[0]);
  ok('видно, у скольких заполнено',
    forTag.find(f => f.path === 'param:Электрика|Мощность')?.filled === 12);
  ok('и образец значения', forTag.find(f => f.path === 'param:Аэродинамика|Расход воздуха')?.sample === '23150');
  ok('метаданные только у тегов', catalogFields(catalog, 'element').every(f => f.section !== 'Метаданные'));
  ok('у позиции — свои постоянные поля',
    catalogFields(catalog, 'element').some(f => f.path === 'itemCode'));

  ok('поиск по названию', searchFields(forTag, 'мощн').length === 1);
  ok('поиск по разделу находит всю группу',
    searchFields(forTag, 'аэродинамика').some(f => f.path === 'param:Аэродинамика|Расход воздуха'));
  ok('поиск по единице', searchFields(forTag, 'квт').length === 1);
  ok('пустой запрос ничего не отсекает', searchFields(forTag, '  ').length === forTag.length);

  const groups = bySection(forTag);
  ok('разделы идут в порядке появления',
    groups[0].section === 'Свои поля' && groups.some(g => g.section === 'Аэродинамика'), groups.map(g => g.section));
  ok('пустой каталог не роняет', catalogFields(null, 'tag').length === 0);
}

console.log('\n6. Геометрия на листе: пропущенные столбцы принадлежат человеку');
{
  // Поддельный лист: помнит, что в какую клетку записали
  const cells = new Map<string, string>();
  const at = (r: number, c: number) => `${r}:${c}`;
  const ws = {
    getRange: (row: number, col: number, rows = 1, cols = 1) => ({
      setValue: (v: unknown) => cells.set(at(row, col), String(v ?? '')),
      setValues: (m: unknown[][]) => {
        for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) {
          cells.set(at(row + i, col + j), String(m?.[i]?.[j] ?? ''));
        }
      },
      getValues: () => Array.from({ length: rows }, (_, i) =>
        Array.from({ length: cols }, (_, j) => cells.get(at(row + i, col + j)) ?? '')),
      setFontWeight: () => {}, setBackgroundColor: () => {}, setHorizontalAlignment: () => {},
    }),
  };

  // Человек написал своё в столбце C, а разметил A, B и F
  cells.set(at(1, 2), 'моя заметка');
  cells.set(at(2, 2), 'и ещё одна');

  let l = emptyLayout('tag', 0);
  l = bindColumn(l, 0, { path: 'identifier', title: 'Тег' });
  l = bindColumn(l, 1, { path: 'brand', title: 'Марка' });
  l = bindColumn(l, 5, { path: 'system.name', title: 'Система' });

  paintHeader(ws, l, false);
  ok('в шапке стоят названия полей',
    cells.get(at(0, 0)) === 'Тег' && cells.get(at(0, 5)) === 'Система');
  ok('пустой столбец шапки между ними не тронут', !cells.has(at(0, 2)));

  writeColumnValues(ws, l, 1, [['AHU-1', 'ВЕРОСА', 'П1'], ['AHU-2', 'ВИР', 'П2']]);
  ok('значения легли в размеченные столбцы',
    cells.get(at(1, 0)) === 'AHU-1' && cells.get(at(2, 5)) === 'П2');
  ok('написанное человеком в чужом столбце уцелело',
    cells.get(at(1, 2)) === 'моя заметка' && cells.get(at(2, 2)) === 'и ещё одна');

  const back = readColumnValues(ws, l, 1, 2);
  ok('читается в том же порядке, что разметка',
    back[0].join('|') === 'AHU-1|ВЕРОСА|П1' && back[1].join('|') === 'AHU-2|ВИР|П2', back);

  clearColumnValues(ws, l, 1, 2);
  ok('очистка убирает только свои столбцы',
    cells.get(at(1, 0)) === '' && cells.get(at(1, 2)) === 'моя заметка');

  clearHeaderCell(ws, 0, 5);
  ok('снятое поле не оставляет призрака в шапке', cells.get(at(0, 5)) === '');

  ok('следующее поле встаёт правее последнего', nextFreeColumn(l) === 6, nextFreeColumn(l));
  ok('на пустой разметке — первый столбец', nextFreeColumn(emptyLayout()) === 0);
}

console.log(failed ? `\nПРОВАЛОВ: ${failed}` : '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ');
process.exit(failed ? 1 : 0);
