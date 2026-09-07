// Тесты распознавания документов: запускаются `npx tsx scripts/test-doc-import.ts`.
// Покрывают варианты использования: карточка изделия, ведомость, матрица типоразмеров,
// опросный лист, многосекционный бланк, проза с параметрами, XML, Excel-файл,
// PDF с текстовым слоем, буфер обмена, валидация мусора, нормализация единиц и кодов.

import * as XLSX from 'xlsx';
import { recognize, classifyTable, classifyParagraph, draftToUnits } from '../src/import/recognize';
import { extractXlsx, extractXml, extractClipboard, htmlToBlocks, extractPdf } from '../src/import/extractors';
import { matchLabel, parseNumber, splitValueUnit, normalizeCode, validateValue, FIELDS } from '../src/import/dictionary';
import { ExtractedDoc, DocBlock } from '../src/import/types';

let passed = 0;
let failed = 0;
const fails: string[] = [];

function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; }
  else { failed++; fails.push(`✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

function doc(blocks: DocBlock[], source: ExtractedDoc['source'] = 'docx'): ExtractedDoc {
  return { blocks, source, warnings: [] };
}

const field = (r: any, id: string) => r.items[0]?.fields.find((f: any) => f.fieldId === id);

// ── 1. Словарь и нормализация ────────────────────────────────────────────────

check('словарь: «Расход воздуха, м³/ч» → airflow', matchLabel('Расход воздуха, м³/ч')?.field.id === 'airflow');
check('словарь: «Производительность» → airflow', matchLabel('Производительность')?.field.id === 'airflow');
check('словарь: «Марка/типоразмер» → brand', matchLabel('Марка')?.field.id === 'brand');
check('словарь: опечатка «мощнось» → power', matchLabel('мощнось')?.field.id === 'power');
check('словарь: постороннее «Примечания по монтажу и наладке» ≠ поле',
  matchLabel('Примечания по монтажу и наладке в зимний период эксплуатации') === null);
check('число: «5 000,5» → 5000.5', parseNumber('5 000,5') === 5000.5);
check('число: «5 тыс. м3/ч» → 5000', parseNumber('5 тыс.') === 5000);
check('единицы: «5000 м3/ч» → м³/ч', splitValueUnit('5000 м3/ч').unit === 'м³/ч');
// Чисто кириллическая марка сохраняется (ВЕРОСА-670, ВР-86-77 — реальные русские марки,
// превращать в латиницу нельзя); транслитерация только для явно латинских кодов со смесью
check('коды: кириллическая марка ВР-80-75 сохраняется', normalizeCode('ВР-80-75').value === 'ВР-80-75');
check('коды: латинский код со стрей кириллицей RSВ-60 → RSB-60', normalizeCode('RSВ-60').value === 'RSB-60', normalizeCode('RSВ-60').value);
const airflowField = FIELDS.find(f => f.id === 'airflow')!;
check('валидация: «ВР-80» под якорем «Расход» отклоняется', validateValue(airflowField, 'ВР-80', '') === 'reject');
check('валидация: расход 5000 — ок', validateValue(airflowField, '5000', 'м³/ч') === 'ok');
check('валидация: расход 99 000 000 — подозрительно', validateValue(airflowField, '99000000', '') === 'suspicious');

// ── 2. Классификация абзацев и таблиц ────────────────────────────────────────

check('абзац: проза', classifyParagraph('Настоящий бланк заполняется поставщиком по результатам подбора оборудования. Все поля обязательны.') === 'prose');
check('абзац: «Расход воздуха: 5000 м3/ч» → kvline', classifyParagraph('Расход воздуха: 5000 м3/ч') === 'kvline');
check('абзац: «Вентилятор осевой» → heading', classifyParagraph('Вентилятор осевой') === 'heading');
check('абзац: «Утверждаю: директор» → мусор', classifyParagraph('Утверждаю: директор Иванов И.И.') === 'garbage');

check('таблица: атрибутная', classifyTable([
  ['Наименование', 'Клапан воздушный'],
  ['Марка', 'КВУ-100'],
  ['Расход', '1200 м3/ч'],
]) === 'attribute');

check('таблица: сущностная (ведомость)', classifyTable([
  ['Наименование', 'Марка', 'Кол-во', 'Масса, кг'],
  ['Клапан воздушный', 'КВУ-100', '2', '5'],
  ['Клапан обратный', 'КО-150', '1', '3'],
  ['Вентилятор', 'ВР-80', '1', '45'],
]) === 'entity');

check('таблица: матричная (типоразмеры в колонках)', classifyTable([
  ['Параметр', 'ОСА-4,0', 'ОСА-5,6', 'ОСА-7,1'],
  ['Расход, м3/ч', '4000', '8000', '16000'],
  ['Мощность, кВт', '0.55', '1.5', '3.0'],
  ['Масса, кг', '18', '32', '61'],
]) === 'matrix');

check('таблица: оформительская (1 колонка)', classifyTable([['Просто текст в рамке']]) === 'layout');

// ── 3. Карточка изделия: атрибутная таблица ──────────────────────────────────
{
  const r = recognize(doc([
    { kind: 'para', text: 'Бланк подбора вентиляционного оборудования' },
    { kind: 'table', rows: [
      ['Наименование', 'Вентилятор радиальный'],
      ['Марка', 'ВР-86-77-4'],
      ['Расход воздуха, м3/ч', '5000'],
      ['Полное давление, Па', '450'],
      ['Мощность двигателя, кВт', '1,5'],
      ['Масса, кг', '46'],
    ] },
  ]));
  check('карточка: docType=card', r.docType === 'card');
  check('карточка: 1 позиция', r.items.length === 1);
  check('карточка: название', r.items[0]?.title === 'Вентилятор радиальный');
  check('карточка: кириллическая марка сохранена', r.items[0]?.brand === 'ВР-86-77-4', r.items[0]?.brand);
  check('карточка: тип fan', r.items[0]?.equipType === 'fan');
  check('карточка: расход high', field(r, 'airflow')?.confidence === 'high');
  check('карточка: мощность 1,5 кВт', field(r, 'power')?.value === '1,5');
}

// ── 4. Текст с абзацами сверху + параметры снизу (главный сценарий) ──────────
{
  const r = recognize(doc([
    { kind: 'para', text: 'Заполняется поставщиком по результатам подбора. Настоящий документ подтверждает выполнение подбора осевого вентилятора ОСА-ЭВО-5,6 для системы П1 согласно техническому заданию заказчика.' },
    { kind: 'para', text: 'Оборудование поставляется в полной заводской готовности. Гарантийный срок составляет 24 месяца с момента отгрузки.' },
    { kind: 'para', text: 'Расход воздуха: 8000 м3/ч' },
    { kind: 'para', text: 'Давление: 320 Па' },
    { kind: 'para', text: 'Мощность: 1,5 кВт' },
  ]));
  check('проза+параметры: 1 позиция', r.items.length === 1);
  check('проза+параметры: марка из прозы', r.items[0]?.brand?.includes('ОСА') || r.items[0]?.brand?.includes('OCA'), r.items[0]?.brand);
  check('проза+параметры: система П1', r.items[0]?.system === 'П1', r.items[0]?.system);
  check('проза+параметры: тип fan', r.items[0]?.equipType === 'fan');
  check('проза+параметры: расход 8000', field(r, 'airflow')?.value.includes('8000'));
  check('проза+параметры: марка mid (из прозы)', field(r, 'brand')?.confidence === 'mid');
}

// ── 5. Прозаический параметр «мощность составляет 3 кВт» ─────────────────────
{
  const r = recognize(doc([
    { kind: 'para', text: 'Для системы В2 принят к установке канальный вентилятор. Потребляемая мощность составляет 3 кВт, производительность достигает 12000 м3/ч при давлении 400 Па.' },
  ]));
  check('проза-параметры: мощность 3', field(r, 'power')?.value.trim().startsWith('3'), JSON.stringify(field(r, 'power')));
  check('проза-параметры: расход 12000', field(r, 'airflow')?.value.includes('12000'));
  check('проза-параметры: система В2', r.items[0]?.system === 'В2');
}

// ── 6. Ведомость: строки = позиции ──────────────────────────────────────────
{
  const r = recognize(doc([
    { kind: 'para', text: 'Ведомость оборудования системы П3' },
    { kind: 'table', rows: [
      ['Наименование', 'Марка', 'Кол-во', 'Масса, кг'],
      ['Клапан воздушный утеплённый', 'КВУ-100', '2', '5'],
      ['Клапан обратный', 'КО-150', '1', '3'],
      ['Вентилятор радиальный', 'ВР-80-75-4', '1', '45'],
      ['ИТОГО', '', '4', '53'],
    ] },
  ]));
  check('ведомость: docType=list', r.docType === 'list');
  check('ведомость: 3 позиции (итого пропущено)', r.items.length === 3, String(r.items.length));
  check('ведомость: первая — клапан', r.items[0]?.equipType === 'valve');
  check('ведомость: кол-во', r.items[0]?.qty === '2');
  check('ведомость: третья — вентилятор', r.items[2]?.equipType === 'fan');
}

// ── 7. Многосекционный бланк (приточная установка) ──────────────────────────
{
  const r = recognize(doc([
    { kind: 'para', text: 'Приточная установка П1' },
    { kind: 'para', text: 'Вентилятор' },
    { kind: 'table', rows: [
      ['Марка', 'RS 60-35'],
      ['Расход, м3/ч', '6000'],
      ['Мощность, кВт', '2,2'],
    ] },
    { kind: 'para', text: 'Калорифер' },
    { kind: 'table', rows: [
      ['Марка', 'ВНВ-243'],
      ['Тепловая мощность, кВт', '55'],
      ['Расход воды, м3/ч', '2,4'],
    ] },
    { kind: 'para', text: 'Фильтр' },
    { kind: 'table', rows: [
      ['Класс очистки', 'G4'],
      ['Сечение, мм', '600x350'],
    ] },
  ]));
  check('секции: docType=multi', r.docType === 'multi', r.docType);
  check('секции: 4 позиции (установка+3)', r.items.length === 4, String(r.items.length));
  const fan = r.items.find(i => i.equipType === 'fan');
  const heater = r.items.find(i => i.equipType === 'heater');
  const filter = r.items.find(i => i.equipType === 'filter');
  check('секции: вентилятор с маркой', !!fan && fan.brand === 'RS 60-35', fan?.brand);
  check('секции: калорифер 55 кВт', !!heater && heater.fields.some(f => f.fieldId === 'heatpower' && f.value === '55'));
  check('секции: фильтр G4', !!filter && filter.fields.some(f => f.fieldId === 'filterclass' && f.value === 'G4'));

  // Составное изделие → одна установка с секциями
  const units = draftToUnits(r.items, 'бланк.docx');
  check('секции→units: одна установка', units.length === 1);
  check('секции→units: 3 блока внутри', units[0].monoblocks[0].blocks.length === 3, String(units[0]?.monoblocks[0]?.blocks.length));
}

// ── 8. Матричная таблица: выбор колонки по марке ─────────────────────────────
{
  const r = recognize(doc([
    { kind: 'table', rows: [
      ['Марка', 'ОСА-ЭВО-5,6'],
    ] },
    { kind: 'table', rows: [
      ['Параметр', 'ОСА-ЭВО-4,0', 'ОСА-ЭВО-5,6', 'ОСА-ЭВО-7,1'],
      ['Расход, м3/ч', '4000', '8000', '16000'],
      ['Мощность, кВт', '0,55', '1,5', '3,0'],
    ] },
  ]));
  check('матрица: расход из колонки марки', field(r, 'airflow')?.value === '8000', field(r, 'airflow')?.value);
  check('матрица: мощность из колонки марки', field(r, 'power')?.value === '1,5');
}

// ── 9. Матрица без марки → выбор пользователю ────────────────────────────────
{
  const r = recognize(doc([
    { kind: 'table', rows: [
      ['Параметр', 'ВРАН-6-3,55', 'ВРАН-6-4,5', 'ВРАН-6-5,6'],
      ['Расход, м3/ч', '2000', '4500', '9000'],
      ['Масса, кг', '25', '40', '65'],
    ] },
  ]));
  check('матрица без марки: варианты колонок отданы в UI', (r.items[0]?.matrixHeaders?.length || 0) === 3, JSON.stringify(r.items[0]?.matrixHeaders));
}

// ── 10. Опросный лист: пустые подчёркивания не тащатся ───────────────────────
{
  const r = recognize(doc([
    { kind: 'para', text: 'Опросный лист на воздушную завесу' },
    { kind: 'para', text: 'Марка: КЭВ-П2121А' },
    { kind: 'para', text: 'Напряжение: 380 В' },
    { kind: 'para', text: 'Производитель: ____________' },
    { kind: 'para', text: 'Масса: ____________' },
    { kind: 'para', text: 'Примечание: ____________' },
  ]));
  check('опросный: docType=questionnaire', r.docType === 'questionnaire', r.docType);
  check('опросный: марка есть', r.items[0]?.brand?.includes('КЭВ') || r.items[0]?.brand?.includes('KEB') || (r.items[0]?.brand || '').length > 3, r.items[0]?.brand);
  check('опросный: напряжение есть', !!field(r, 'voltage'));
  check('опросный: пустая масса не попала', !field(r, 'weight'));
  check('опросный: тип завеса', r.items[0]?.equipType === 'curtain');
}

// ── 11. Оформительская таблица-рамка с данными внутри ────────────────────────
{
  const r = recognize(doc([
    { kind: 'table', rows: [
      ['Бланк заказа противопожарного клапана'],
      ['Марка: КПУ-1Н-О-Н-250х250'],
      ['Сечение: 250х250 мм'],
      ['Температура среды: 600 °C'],
    ] },
  ]));
  check('рамка: марка из строки таблицы', (r.items[0]?.brand || '').includes('250'), r.items[0]?.brand);
  check('рамка: тип клапан', r.items[0]?.equipType === 'valve');
  check('рамка: температура 600', field(r, 'temp')?.value === '600');
}

// ── 12. Excel: реальный файл через extractXlsx ───────────────────────────────
{
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ['Бланк подбора вентилятора'],
    [],
    ['Наименование', 'Вентилятор крышный'],
    ['Марка', 'ВКР-5'],
    ['Расход воздуха, м3/ч', '3500'],
    ['Мощность, кВт', '0,75'],
  ]);
  XLSX.utils.book_append_sheet(wb, ws, 'Подбор');
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  const ex = extractXlsx(buf as ArrayBuffer);
  const r = recognize(ex);
  check('xlsx: марка ВКР-5', (r.items[0]?.brand || '').replace('B', 'В').includes('КР-5') || (r.items[0]?.brand || '').includes('KP-5'), r.items[0]?.brand);
  check('xlsx: расход 3500', field(r, 'airflow')?.value === '3500');
  check('xlsx: тип fan', r.items[0]?.equipType === 'fan');
}

// ── 13. Excel-ведомость несколькими листами ──────────────────────────────────
{
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Наименование', 'Марка', 'Количество'],
    ['Клапан огнезадерживающий', 'КЛОП-1', '4'],
    ['Клапан дымоудаления', 'КДМ-2', '2'],
  ]), 'Система В1');
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  const r = recognize(extractXlsx(buf as ArrayBuffer));
  check('xlsx-ведомость: 2 позиции', r.items.length === 2, String(r.items.length));
  check('xlsx-ведомость: кол-во 4', r.items[0]?.qty === '4');
}

// ── 14. XML: параметры атрибутами и листовыми узлами ─────────────────────────
{
  const xml = `<?xml version="1.0"?>
  <оборудование>
    <система name="П2">
      <компонент name="Вентилятор ВР-300-45">
        <parameter name="Расход воздуха" value="7200" unit="м3/ч"/>
        <parameter name="Давление" value="500" unit="Па"/>
        <мощность>2.2 кВт</мощность>
      </компонент>
    </система>
  </оборудование>`;
  const r = recognize(extractXml(xml));
  check('xml: расход 7200', field(r, 'airflow')?.value.includes('7200'), JSON.stringify(field(r, 'airflow')));
  check('xml: мощность из листового узла', !!field(r, 'power'));
  check('xml: система П2', r.items[0]?.system === 'П2', r.items[0]?.system);
}

// ── 15. Буфер обмена: таблица с табуляциями ──────────────────────────────────
{
  const text = 'Наименование\tМарка\tКол-во\nВентилятор осевой\tОСА-300\t3\nКлапан\tАВК-100\t5';
  const r = recognize(extractClipboard('', text));
  check('буфер: 2 позиции', r.items.length === 2, String(r.items.length));
  check('буфер: кол-во 3', r.items[0]?.qty === '3');
}

// ── 16. Буфер обмена: HTML-таблица из Word ───────────────────────────────────
{
  const html = '<table><tr><td>Марка</td><td>КВУ-125</td></tr><tr><td>Расход, м3/ч</td><td>1400</td></tr></table>';
  const r = recognize(extractClipboard(html, ''));
  check('буфер-html: марка', (r.items[0]?.brand || '').includes('125'), r.items[0]?.brand);
  check('буфер-html: расход', field(r, 'airflow')?.value === '1400');
}

// ── 17. Word HTML: вложенная оформительская таблица ──────────────────────────
{
  const html = `
    <p>Опросный лист вентилятора</p>
    <table><tr><td>
      <table>
        <tr><td>Марка</td><td>ВЦ-14-46-2,5</td></tr>
        <tr><td>Расход, м3/ч</td><td>2500</td></tr>
        <tr><td>Обороты, об/мин</td><td>1450</td></tr>
      </table>
    </td></tr></table>`;
  const blocks = htmlToBlocks(html);
  const r = recognize(doc(blocks));
  check('docx-вложенность: марка найдена', (r.items[0]?.brand || '').includes('14-46'), r.items[0]?.brand);
  check('docx-вложенность: обороты 1450', field(r, 'rpm')?.value === '1450');
}

// ── 18. PDF с текстовым слоем (рукописный минимальный PDF) ───────────────────
async function testPdf() {
  // Минимальный валидный PDF с текстовыми строками (WinAnsi, латиница+цифры)
  const lines = [
    'Fan data sheet',
    'Model: VR-86-77-4',
    'Airflow: 5000 m3/h',
    'Power: 1.5 kW',
    'Weight: 46 kg',
    'Voltage: 380 V',
  ];
  const content = lines.map((t, i) => `BT /F1 12 Tf 50 ${700 - i * 24} Td (${t}) Tj ET`).join('\n');
  const objs: string[] = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
  objs[3] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>';
  objs[4] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  objs[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [0];
  for (let i = 1; i <= 5; i++) {
    offsets[i] = pdf.length;
    pdf += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xrefPos = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${[1,2,3,4,5].map(i => String(offsets[i]).padStart(10, '0') + ' 00000 n \n').join('')}`;
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
  const data = new TextEncoder().encode(pdf).buffer as ArrayBuffer;

  const out = await extractPdf(data);
  check('pdf: текст извлечён', out.doc.blocks.length >= 2, JSON.stringify(out.doc.blocks).slice(0, 200));
  check('pdf: сканов нет', out.scanPages.length === 0);
  const joined = JSON.stringify(out.doc.blocks);
  check('pdf: модель в тексте', joined.includes('VR-86-77-4'));

  // Скан-детект: PDF без текста
  const emptyContent = ' ';
  let pdf2 = pdf.replace(content, emptyContent).replace(`/Length ${content.length}`, `/Length ${emptyContent.length}`);
  const out2 = await extractPdf(new TextEncoder().encode(pdf2).buffer as ArrayBuffer);
  check('pdf-скан: страница определена как скан', out2.scanPages.length === 1, JSON.stringify(out2.scanPages));
}

// ── 19. Лестница отказоустойчивости: мусорный документ ──────────────────────
{
  const r = recognize(doc([
    { kind: 'para', text: 'Просто произвольный текст без какого-либо оборудования и параметров внутри него.' },
  ]));
  check('мусор: позиций нет', r.items.length === 0, String(r.items.length));
  check('мусор: предупреждение выдано', r.warnings.length > 0);
}

// ── 20. draftToUnits: обычная ведомость ──────────────────────────────────────
{
  const r = recognize(doc([
    { kind: 'table', rows: [
      ['Наименование', 'Марка', 'Кол-во'],
      ['Клапан', 'К-1', '2'],
      ['Решётка вентиляционная', 'РВ-2', '8'],
    ] },
  ]));
  const units = draftToUnits(r.items, 'ведомость.xlsx');
  check('units: одна установка-документ', units.length === 1);
  check('units: 2 блока', units[0].monoblocks[0].blocks.length === 2);
  const b0 = units[0].monoblocks[0].blocks[0];
  check('units: марка в группе Общие', b0.groups.some(g => g.title === 'Общие' && g.params.some(p => p.key === 'Марка')), JSON.stringify(b0.groups));
  check('units: кол-во в группе Общие', b0.groups.some(g => g.params.some(p => p.key === 'Количество' && p.value === '2')));
}

// ── 21. Реальные бланки: административная шапка не тащит реквизиты ────────────
{
  const r = recognize(doc([
    { kind: 'para', text: 'Вентилятор канальный Канал-ВЕНТ' },
    { kind: 'table', rows: [
      ['OWNER / ЗАКАЗЧИК:', 'ООО «ЗАПСИБНЕФТЕХИМ»'],
      ['CONTRACTOR / ПОДРЯДЧИК:', 'Wison Engineering'],
      ['VENDOR / ПОСТАВЩИК:', 'ООО ВЕЗА'],
      ['TAG N. / № Технологической позиции', '3700-C03-BL-001'],
      ['Телефон/Факс', 'Тип'],
      ['Заказчик:', ''],
    ] },
    { kind: 'table', rows: [
      ['Марка', 'Канал-ВЕНТ-125'],
      ['Производительность', '140 м3/ч'],
      ['Свободный напор', '250 Па'],
    ] },
  ]));
  const labels = r.items.flatMap(i => i.fields.map(f => f.label.toLowerCase()));
  check('админ: заказчик/подрядчик не в полях', !labels.some(l => /заказчик|подрядчик|телефон|owner|contractor/.test(l)), JSON.stringify(labels));
  check('админ: производитель извлечён', r.items.some(i => i.fields.some(f => f.fieldId === 'manufacturer')));
  check('админ: тег позиции как система', r.items.some(i => i.system === '3700-C03-BL-001'), r.items.map(i=>i.system).join());
  check('админ: расход 140 распознан', r.items.some(i => i.fields.some(f => f.fieldId === 'airflow' && f.value === '140')));
}

// ── 22. Формульная строка бланка: Lв=…м³/ч; Pполн=…Па; n=…об/мин ─────────────
{
  const r = recognize(doc([
    { kind: 'para', text: 'Вентилятор ВСК' },
    { kind: 'table', rows: [
      ['Индекс', 'ГЕРМИК-П-1770'],
      ['характеристики', 'Lв=42860м3/ч\ndpсеть0=700Па\npv=964Па'],
    ] },
  ]));
  const it = r.items[0];
  const air = it?.fields.find(f => f.fieldId === 'airflow');
  const prs = it?.fields.find(f => f.fieldId === 'pressure');
  check('формула: Lв=42860 → расход 42860 м³/ч', air?.value === '42860' && /м³\/ч/.test(air?.unit || ''), JSON.stringify(air));
  check('формула: pv=964 → давление', prs?.value === '964' || it?.fields.some(f => f.fieldId==='pressure'&&f.value==='964'));
  check('формула: марка из индекса', (it?.brand || '').includes('ГЕРМИК'), it?.brand);
}

// ── 23. «L=80 мм» — длина, не расход (единица решает) ────────────────────────
{
  const r = recognize(doc([
    { kind: 'para', text: 'Клапан КЕДР-С' },
    { kind: 'table', rows: [
      ['Марка', 'КЕДР-С-1200'],
      ['габарит', 'L=80мм; M=94кг'],
    ] },
  ]));
  const it = r.items[0];
  check('L=80мм не стало расходом воздуха', !it?.fields.some(f => f.fieldId === 'airflow' && f.value === '80'), JSON.stringify(it?.fields.filter(f=>f.value==='80')));
  check('M=94кг → масса', it?.fields.some(f => f.fieldId === 'weight' && f.value === '94'));
}

// ── 24. Климатическое исполнение У3/УХЛ3 не считается системой ────────────────
{
  const r = recognize(doc([
    { kind: 'para', text: 'Вентилятор канальный Канал-ВЕНТ' },
    { kind: 'table', rows: [
      ['Марка', 'Канал-ВЕНТ-125'],
      ['Расход', '140 м3/ч'],
      ['Климатическое исполнение', 'У3'],
    ] },
  ]));
  check('климат: У3 не в системе', r.items[0]?.system !== 'У3', r.items[0]?.system);
}

// ── 25. Двуязычный бланк: RU и EN половины схлопываются в одну позицию ────────
{
  const r = recognize(doc([
    { kind: 'para', text: 'Вентилятор канальный круглый Канал-ВЕНТ' },
    { kind: 'table', rows: [
      ['Марка', 'Канал-ВЕНТ-125'],
      ['Расход', '140 м3/ч'],
      ['Мощность', '0,07 кВт'],
    ] },
    { kind: 'para', text: 'Round duct fan Канал-ВЕНТ' },
    { kind: 'table', rows: [
      ['Type', 'Канал-ВЕНТ-125'],
      ['Airflow', '140 m3/h'],
      ['Power', '0,07 kW'],
    ] },
  ]));
  check('двуязычный: одна позиция после схлопывания', r.items.length === 1, String(r.items.length));
}

// ── 26. Словесные свойства из таблицы бланка сохраняются, примечания — нет ──
// Раньше словесные значения отбрасывались все подряд («сторона: справа»,
// «выбор: оптимальный», «ЧР: да»). На настоящих бланках так пропадали
// настоящие свойства: «ЧР: да» — это частотное регулирование вентилятора, от
// него зависит весь шкаф автоматики, а «назначение: нормально закрытый» и
// «огнестойкость: EI 90» — половина листа технических данных на клапан.
// Теперь решает источник: строка таблицы со своей подписью — данные бланка,
// абзац-примечание — по-прежнему нет.
{
  const r = recognize(doc([
    { kind: 'para', text: 'Вентилятор ВР' },
    { kind: 'para', text: 'Примечание: реле перепада давления монтируется на объекте по месту, отдельной поставкой.' },
    { kind: 'table', rows: [
      ['Марка', 'ВР-80'],
      ['Расход', '5000 м3/ч'],
      ['ЧР', 'да'],
      ['огнестойкость', 'EI 90'],
      ['Mвен', '212кг'],
    ] },
  ]));
  const labels = r.items[0]?.fields.map(f => f.label) || [];
  check('свойство бланка «ЧР» сохранено', labels.some(l => /чр/i.test(l)), JSON.stringify(labels));
  check('словесное «огнестойкость: EI 90» сохранено',
    r.items[0]?.fields.some(f => f.value === 'EI 90'), JSON.stringify(labels));
  check('примечание из абзаца в характеристики не попало',
    !labels.some(l => /примечан|реле перепада/i.test(l)), JSON.stringify(labels));
  check('Mвен=212кг сохранён (реальный параметр)', r.items[0]?.fields.some(f => f.value === '212' && /кг/.test(f.unit || '')), JSON.stringify(labels));
}

// ── 27. Позиционный тег KKS не становится маркой ──────────────────────────────
{
  const r = recognize(doc([
    { kind: 'para', text: 'Фильтр карманный ФВК для системы 3700-B09-AS-001' },
    { kind: 'table', rows: [
      ['Расход', '845 м3/ч'],
      ['Масса', '247 кг'],
    ] },
  ]));
  check('KKS: 3700-B09-AS-001 не марка', r.items[0]?.brand !== '3700-B09-AS-001', r.items[0]?.brand);
}

// ── Запуск ───────────────────────────────────────────────────────────────────

testPdf().then(() => {
  console.log(`\nПройдено: ${passed}, провалено: ${failed}`);
  if (fails.length) {
    console.log(fails.join('\n'));
    process.exit(1);
  }
}).catch(err => {
  console.error('PDF-тест упал:', err);
  console.log(`\nПройдено: ${passed}, провалено: ${failed + 1}`);
  process.exit(1);
});
