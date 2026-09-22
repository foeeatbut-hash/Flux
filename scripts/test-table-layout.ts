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
  catalogFields, searchFields, bySection, asArray, cellAddress, nextTarget,
  withRole, layoutRole, viewToColumns, ROLE_FIELD,
  type LayoutColumn,
} from '../src/lib/tableLayout';
import { compositionOf } from '../equipment/composition';
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

console.log('\n6.1. Куда встанет следующее поле');
{
  // Курсор человека сильнее всего: он показал, куда хочет
  ok('выделенная ячейка — туда и встанет',
    JSON.stringify(nextTarget({ cursor: { row: 2, col: 4 }, last: null, headerRow: 0, fallbackCol: 0 }))
      === JSON.stringify({ row: 2, col: 4 }));

  // Вот ради чего правило: три поля подряд ложились в одну ячейку, потому что
  // от нажатия кнопки в панели курсор на листе не двигается. Якорь — та самая
  // неподвижная ячейка человека, а расти разметка должна от последней занятой
  const anchor = { row: 2, col: 4 };
  const second = nextTarget({ cursor: anchor, last: { anchor, placed: anchor }, headerRow: 0, fallbackCol: 0 });
  ok('второе поле встаёт правее', JSON.stringify(second) === JSON.stringify({ row: 2, col: 5 }), second);

  const third = nextTarget({ cursor: anchor, last: { anchor, placed: second }, headerRow: 0, fallbackCol: 0 });
  ok('и третье — ещё правее, а не обратно в первую',
    JSON.stringify(third) === JSON.stringify({ row: 2, col: 6 }), third);

  const fourth = nextTarget({ cursor: anchor, last: { anchor, placed: third }, headerRow: 0, fallbackCol: 0 });
  ok('цепочка не обрывается', JSON.stringify(fourth) === JSON.stringify({ row: 2, col: 7 }), fourth);

  // А если человек сам ткнул в другую клетку — слушаемся его, даже если она
  // левее и занята: это осознанная замена поля в столбце
  ok('человек ткнул в другую ячейку — слушаемся',
    JSON.stringify(nextTarget({ cursor: { row: 2, col: 1 }, last: { anchor, placed: third }, headerRow: 0, fallbackCol: 9 }))
      === JSON.stringify({ row: 2, col: 1 }));
  ok('другая строка — тоже слушаемся',
    JSON.stringify(nextTarget({ cursor: { row: 5, col: 4 }, last: { anchor, placed: third }, headerRow: 0, fallbackCol: 9 }))
      === JSON.stringify({ row: 5, col: 4 }));

  ok('выделения нет — встаём в свободный столбец шапки',
    JSON.stringify(nextTarget({ cursor: null, last: null, headerRow: 3, fallbackCol: 7 }))
      === JSON.stringify({ row: 3, col: 7 }));
}

console.log('\n7. Адрес ячейки — тот же, что человек видит на листе');
{
  ok('первая ячейка — A1', cellAddress(0, 0) === 'A1', cellAddress(0, 0));
  ok('строки считаются с единицы', cellAddress(4, 1) === 'B5', cellAddress(4, 1));

  // Разряды идут без нуля: после Z сразу AA. Наивное деление даёт «A@» —
  // и панель называла бы человеку ячейку, которой на листе нет
  ok('двадцать шестой столбец — Z', cellAddress(0, 25) === 'Z1', cellAddress(0, 25));
  ok('двадцать седьмой — AA, а не A@', cellAddress(0, 26) === 'AA1', cellAddress(0, 26));
  ok('пятьдесят второй — AZ', cellAddress(0, 51) === 'AZ1', cellAddress(0, 51));
  ok('пятьдесят третий — BA', cellAddress(0, 52) === 'BA1', cellAddress(0, 52));
  ok('семьсот второй — ZZ', cellAddress(0, 701) === 'ZZ1', cellAddress(0, 701));
  ok('семьсот третий — AAA', cellAddress(0, 702) === 'AAA1', cellAddress(0, 702));

  // Отрицательное и нечисловое приходит от движка на закрытом листе
  ok('отрицательный столбец адреса не даёт', cellAddress(0, -1) === '');
  ok('нечисловое адреса не даёт', cellAddress(NaN, 0) === '' && cellAddress(0, NaN) === '');
}

console.log('\nРоль строки: срез по роли — обычный отбор, а не третий вид строки');
{
  const base = emptyLayout('element', 0);
  ok('по умолчанию роль не отобрана', layoutRole(base) === '', layoutRole(base));

  const motors = withRole(base, 'ДВИГАТЕЛЬ');
  ok('роль встала отбором', layoutRole(motors) === 'ДВИГАТЕЛЬ', motors.filters);
  ok('отбор по тому полю, которое отдаёт сервер',
    motors.filters[0].field === ROLE_FIELD && motors.filters[0].op === 'eq', motors.filters);

  // Смена роли не плодит второй отбор: иначе запрос вернул бы пусто — позиция
  // не бывает одновременно двигателем и датчиком
  const sensors = withRole(motors, 'ДАТЧИК');
  ok('смена роли заменяет отбор, а не добавляет второй',
    sensors.filters.filter((f) => f.field === ROLE_FIELD).length === 1, sensors.filters);
  ok('и новая роль на месте', layoutRole(sensors) === 'ДАТЧИК', layoutRole(sensors));

  // Чужие отборы человека не трогаются: набирать их заново было бы обидно
  const withMine = { ...sensors, filters: [...sensors.filters, { field: 'system.name', op: 'eq', value: 'У1' }] };
  const off = withRole(withMine, '');
  ok('пустая роль снимает только свой отбор',
    off.filters.length === 1 && off.filters[0].field === 'system.name', off.filters);
  // Столбцы при этом остаются: «те же данные, но по датчикам» не должно
  // стоить человеку всей разметки
  const painted = bindColumn(withRole(base, 'ДВИГАТЕЛЬ'), 2, { path: 'tag', title: 'Тег' });
  ok('разметка переживает смену роли', withRole(painted, 'ДАТЧИК').columns.length === 1);
}

console.log('\nШаблон вида → столбцы: «какие поля» отдельно от «в каком порядке»');
{
  const view = {
    id: 'v1', name: 'Ведомость автоматики', scope: 'SHARED', role: 'ДВИГАТЕЛЬ',
    fields: [
      { group: 'Электродвигатель', key: 'Номинальная мощность', unit: 'кВт' },
      { group: 'Электродвигатель', key: 'Номинальный ток', unit: 'А' },
    ],
  };
  // Первый столбец тег ставят руками, дальше шаблоном ложатся данные
  const start = bindColumn(emptyLayout('element', 0), 0, { path: 'tag', title: 'Тег' });
  const out = viewToColumns(view, start, { row: 0, col: 1 });

  ok('размеченный столбец не стёрт', out.columns.some((c) => c.path === 'tag' && c.col === 0), out.columns);
  ok('поля легли подряд от указанной ячейки',
    out.columns.map((c) => c.col).join(',') === '0,1,2', out.columns.map((c) => c.col));
  ok('поле стало характеристикой со своими кодами',
    out.columns[1].path === 'param:Электродвигатель|Номинальная мощность', out.columns[1]);
  ok('единица поля сохранена', out.columns[2].unit === 'А', out.columns[2]);
  // Характеристики принадлежат позициям: строка тегом собрала бы половину
  // ячеек пустыми и ничего бы об этом не сказала
  ok('вид строки стал позицией', out.grain === 'element', out.grain);

  // Поверх занятого столбца шаблон не пишет
  const busy = bindColumn(start, 2, { path: 'name', title: 'Наименование' });
  const around = viewToColumns(view, busy, { row: 0, col: 1 });
  ok('занятый столбец обойдён', around.columns.map((c) => c.col).join(',') === '0,1,2,3',
    around.columns.map((c) => [c.col, c.path]));
  ok('и чужое поле осталось на своём месте',
    around.columns.find((c) => c.col === 2)?.path === 'name', around.columns);

  ok('пустой шаблон ничего не меняет',
    viewToColumns({ ...view, fields: [] }, start, { row: 0, col: 1 }).columns.length === 1);
}

console.log('\nСостав установки: один расчёт родителя на всю программу');
{
  const nodes = [
    { id: 'u', itemCode: '__unit__', name: 'Установка', tags: [{ identifier: 'AS-001' }] },
    { id: 'b', itemCode: '3', name: 'Блок' },
    { id: 'f', itemCode: '3/в1', name: 'Вентилятор', parentElementId: 'b', tags: [{ identifier: 'BL-001' }] },
    { id: 'm', itemCode: '3/в1/д1', name: 'Двигатель', parentElementId: 'f', tags: [{ identifier: 'M-001' }] },
    { id: 's', itemCode: '3/в1/д1/т1', name: 'Датчик ПТС', parentElementId: 'm', tags: [{ identifier: 'TE-001' }] },
  ];
  const c = compositionOf(nodes, 'AS-001');
  ok('тег установки найден', c.unitTag === 'AS-001', c.unitTag);
  ok('родитель двигателя — вентилятор', c.parentTagOf(nodes[3]) === 'BL-001', c.parentTagOf(nodes[3]));
  ok('родитель датчика — двигатель', c.parentTagOf(nodes[4]) === 'M-001');
  // Блок тега не имеет: цепочка не обрывается и тега ему не выдумывают
  ok('через нетегированный блок поднимаемся к установке', c.parentTagOf(nodes[2]) === 'AS-001');
  ok('владелец назван по имени', c.parentNameOf(nodes[3]) === 'Вентилятор', c.parentNameOf(nodes[3]));

  // Кольцо в данных не должно зацикливать обход
  const ring = [
    { id: 'a', name: 'A', parentElementId: 'b' },
    { id: 'b', name: 'B', parentElementId: 'a' },
  ];
  ok('кольцо не вешает расчёт', compositionOf(ring).parentTagOf(ring[0]) === '');
}

console.log(failed ? `\nПРОВАЛОВ: ${failed}` : '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ');
process.exit(failed ? 1 : 0);
