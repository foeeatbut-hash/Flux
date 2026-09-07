/**
 * Разбор бланков целиком: от документа до дерева оборудования.
 *
 * Проверки написаны по обезличенным образцам настоящих листов
 * (scripts/fixtures/blanks.ts) и держат ровно то, на чём разбор ломался:
 *  • разделы бланка нумерованные, а не словарные — иначе данные одного блока
 *    приклеивались к другому;
 *  • номер раздела задаёт дерево «установка → моноблок → блок»;
 *  • тегов в ячейке бывает несколько, и подпись «TAG N.» стоит посреди строки;
 *  • перечень позиций даёт столько позиций, сколько строк, а не одну;
 *  • общие свойства вида клапана достаются его строкам — и только им.
 */
import { recognize, draftToUnits } from '../src/import/recognize';
import { AHU_SHEET, FAN_ORDER, VALVE_SHEET } from './fixtures/blanks';

let f = 0;
const ok = (n: string, c: boolean, d?: any) =>
  c ? console.log('  ✓', n) : (f++, console.error('  ✗', n, d !== undefined ? JSON.stringify(d).slice(0, 300) : ''));

const params = (b: any) => b.groups.flatMap((g: any) => g.params);
const value = (b: any, key: string) => params(b).find((p: any) => p.key === key)?.value;

console.log('1. Лист технических данных установки');
{
  const r = recognize(AHU_SHEET);
  ok('бланк многосекционный', r.docType === 'multi', r.docType);
  ok('разделы не слиплись: установка и четыре блока', r.items.length === 5, r.items.map(i => i.section || i.title.slice(0, 20)));
  const sections = r.items.map(i => i.section).filter(Boolean);
  ok('номера разделов прочитаны', JSON.stringify(sections) === JSON.stringify(['1.1', '1.2', '2', '2.1']), sections);
  ok('тег установки найден', JSON.stringify(r.items[0].tags) === JSON.stringify(['1000-A01-HU-001A']), r.items[0].tags);

  const fan = r.items.find(i => i.section === '2')!;
  ok('маркой вентилятора стал вентилятор, а не его двигатель',
    fan.brand === 'ВЕНТ-063-00550-04-1-Г-УХЛ2', fan.brand);
  const rpm = fan.fields.find(x => x.fieldId === 'rpm');
  ok('«nдв» — частота вращения', !!rpm && rpm.value === '1435', rpm);
  const power = fan.fields.find(x => x.fieldId === 'power');
  ok('«Ny» — мощность', !!power && power.value === '5.5', power);
  ok('обороты не подписаны мощностью', !fan.fields.some(x => x.label === 'Мощность' && x.unit === 'об/мин'));
  const air = fan.fields.find(x => x.fieldId === 'airflow');
  ok('«Q» с м³/ч — расход', !!air && air.value === '20000', air);
  ok('«dpсетьвс» и «dpсетьнг» различимы',
    new Set(fan.fields.filter(x => x.fieldId === 'pressure').map(x => x.label)).size >= 2,
    fan.fields.filter(x => x.fieldId === 'pressure').map(x => x.label));

  const panel = r.items.find(i => i.section === '1.1')!;
  ok('«L=80мм» — длина, а не расход', panel.fields.some(x => x.fieldId === 'length' && x.value === '80'),
    panel.fields.map(x => `${x.label}=${x.value}`));
  ok('«Nтэн» стала мощностью', panel.fields.some(x => x.fieldId === 'power' && x.value === '0.18'),
    panel.fields.filter(x => x.fieldId === 'power'));

  const units = draftToUnits(r.items, 'установка');
  ok('одна установка', units.length === 1);
  ok('имя установки — её тег', units[0].name === '1000-A01-HU-001A', units[0].name);
  ok('два моноблока по номерам разделов', units[0].monoblocks.length === 2, units[0].monoblocks.map(m => m.name));
  ok('в первом моноблоке два блока', units[0].monoblocks[0].blocks.length === 2);
  ok('во втором моноблоке два блока', units[0].monoblocks[1].blocks.length === 2);
}

console.log('2. Бланк-заказ вентилятора');
{
  const r = recognize(FAN_ORDER);
  const it = r.items[0];
  ok('позиция одна', r.items.length === 1, r.items.length);
  ok('пять тегов из одной ячейки', (it.tags || []).length === 5, it.tags);
  ok('кириллическая «Е» в конце тега приведена к латинской',
    (it.tags || []).includes('1000-C01-BL-001E'), it.tags);
  ok('точка в конце списка тегов не прилипла',
    (it.tags || []).every(t => !t.endsWith('.')), it.tags);
  ok('мощность двигателя прочитана', it.fields.some(x => x.fieldId === 'power' && x.value === '30'),
    it.fields.filter(x => x.fieldId === 'power'));
  ok('обороты прочитаны', it.fields.some(x => x.fieldId === 'rpm' && x.value === '735'));
  ok('запятая осталась дробной частью', it.fields.some(x => x.fieldId === 'current' && x.value === '65,8'),
    it.fields.filter(x => x.fieldId === 'current'));
  ok('реквизиты документа в характеристики не попали',
    !it.fields.some(x => /подрядчик|заказчик|поставщик|ревизия/i.test(x.label)), it.fields.map(x => x.label));
}

console.log('3. Лист технических данных на клапаны');
{
  const r = recognize(VALVE_SHEET);
  ok('бланк — перечень позиций', r.docType === 'list', r.docType);
  ok('четыре позиции, а не одна', r.items.length === 4, r.items.map(i => i.title));
  ok('у каждой позиции свои теги', r.items.every(i => (i.tags || []).length >= 1), r.items.map(i => i.tags));
  ok('два тега из одной ячейки через перевод строки',
    JSON.stringify(r.items[0].tags) === JSON.stringify(['1000-D01-DS-002', '1000-D01-DS-003']), r.items[0].tags);
  ok('три тега через пробел', (r.items[3].tags || []).length === 3, r.items[3].tags);
  ok('одинаковая марка позиции не схлопнула', new Set(r.items.map(i => i.title)).size === 4);

  const units = draftToUnits(r.items, 'клапаны');
  const blocks = units[0].monoblocks[0].blocks;
  ok('в дереве четыре блока', blocks.length === 4, blocks.length);
  ok('код блока — его тег', blocks[0].name === '1000-D01-DS-002', blocks[0].name);
  ok('ширина из шапки «Ширина В, мм» прочитана', value(blocks[0], 'Ширина В, мм') === '1000',
    params(blocks[0]).map((p: any) => p.key));
  // Общие свойства вида клапана достаются его строкам — и только им
  ok('общее свойство своего вида дошло до строки', value(blocks[0], 'огнестойкость по ГОСТ') === 'EI 90',
    value(blocks[0], 'огнестойкость по ГОСТ'));
  ok('у второго вида своё значение того же свойства', value(blocks[2], 'огнестойкость по ГОСТ') === 'EI 60',
    value(blocks[2], 'огнестойкость по ГОСТ'));
  ok('единица из отдельной колонки подхвачена',
    params(blocks[0]).some((p: any) => p.key === 'рабочее давление' && p.unit === 'Па'),
    params(blocks[0]).find((p: any) => p.key === 'рабочее давление'));
}

console.log(f === 0 ? '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ' : `\nПРОВАЛОВ: ${f}`);
process.exit(f === 0 ? 0 : 1);
