/**
 * Тест распознавания вопросов Flux Guide (ТЗ §9.3, §24.2).
 *
 * Для каждого намерения — литеральная, разговорная и «неудобная» формулировки.
 * Проверяются намерение, извлечение кода тега (регистр!), класса оборудования и
 * характеристики. Запуск: npx tsx scripts/test-guide-parser.ts
 */
import { parseQuestion } from '../src/guide/questionParser';

interface Expectation {
  q: string;
  intent: string;
  code?: string;
  type?: string;
  field?: string;
}

const CASES: Expectation[] = [
  // Точный тег: регистр и похожие коды не искажаются
  { q: 'найди тег 3700-B08-DW-002B', intent: 'tag_lookup', code: '3700-B08-DW-002B' },
  { q: '3700-B08-DW-0028', intent: 'tag_lookup', code: '3700-B08-DW-0028' },
  { q: 'где стоит тег 3700-B08-КЛ-0001?', intent: 'tag_lookup', code: '3700-B08-КЛ-0001' },
  // Дубли
  { q: 'есть ли дубли тегов?', intent: 'tag_duplicates' },
  { q: 'покажи дубликаты', intent: 'tag_duplicates' },
  // Оборудование без тега и с пустым полем
  { q: 'покажи оборудование без тега', intent: 'equipment_no_tag' },
  { q: 'какие позиции без тегов', intent: 'equipment_no_tag' },
  { q: 'у каких клапанов не указано питание?', intent: 'equipment_missing_field', field: 'Питание' },
  { q: 'где расход не заполнен', intent: 'equipment_missing_field', field: 'Расход воздуха' },
  // Характеристики: значение по тегу и по проекту
  { q: 'какой расход воздуха у 3700-B08-DW-002B', intent: 'equipment_characteristic', code: '3700-B08-DW-002B', field: 'Расход воздуха' },
  { q: 'какой расход у П1?', intent: 'equipment_characteristic', field: 'Расход воздуха' },
  { q: 'какое давление у вентилятора?', intent: 'equipment_characteristic', field: 'Полное давление' },
  // Счёт по классам: разговорные формы
  { q: 'сколько приточных установок в проекте?', intent: 'project_count', type: 'ПРИТОЧНАЯ УСТАНОВКА' },
  { q: 'сколько приточек?', intent: 'project_count', type: 'ПРИТОЧНАЯ УСТАНОВКА' },
  { q: 'сколько вентиляторов', intent: 'project_count', type: 'ВЕНТИЛЯТОР' },
  { q: 'сколько тегов в проекте', intent: 'project_count' },
  { q: 'сколько систем', intent: 'project_count' },
  // Закупки
  { q: 'сколько осталось незаказанного?', intent: 'procurement_state' },
  { q: 'что на этапе заказан', intent: 'procurement_state' },
  // Списки и сводка
  { q: 'покажи все клапаны', intent: 'equipment_list', type: 'КЛАПАН' },
  { q: 'покажи сводку проекта', intent: 'project_summary' },
  // Справка без ИИ
  { q: 'как загрузить xml оборудования?', intent: 'knowledge_howto' },
  { q: 'где выгрузить характеристики?', intent: 'knowledge_where' },
  { q: 'что такое ревизия?', intent: 'glossary' },
  { q: 'почему импорт xml не прошёл?', intent: 'troubleshoot' },
  // Навигация и демонстрация
  { q: 'открой менеджмент', intent: 'open_section' },
  { q: 'покажи как создать тег', intent: 'start_tour' },
  // Ревизии и документы (ТЗ v3 §12.6, §12.7)
  { q: 'какая ревизия у 3700-B08-DW-002B?', intent: 'equipment_revision', code: '3700-B08-DW-002B' },
  { q: 'что изменилось в последней ревизии?', intent: 'equipment_revision' },
  { q: 'есть ли конфликт ревизий?', intent: 'equipment_revision' },
  { q: 'есть ли файлы у тега 3700-B08-DW-002B?', intent: 'document_search', code: '3700-B08-DW-002B' },
  { q: 'найди документы по вентилятору', intent: 'document_search' },
  // Штатная выгрузка
  { q: 'сделай таблицу тегов и расходов', intent: 'open_export' },
  { q: 'открой выгрузку по клапанам', intent: 'open_export' },
  // Числовой фильтр и единицы
  { q: 'расход больше 1000', intent: 'equipment_characteristic', field: 'Расход воздуха' },
  // Глоссарий и диагностика
  { q: 'что такое ревизия?', intent: 'glossary' },
  { q: 'что такое тег?', intent: 'glossary' },
  { q: 'почему импорт xml не прошёл?', intent: 'troubleshoot' },
  { q: 'тег уже занят, что делать?', intent: 'troubleshoot' },
  // Неизвестное — не должно превращаться в выдуманный ответ
  { q: 'который час', intent: 'unknown' },
];

let failed = 0;
for (const c of CASES) {
  const p = parseQuestion(c.q);
  const errs: string[] = [];
  if (p.intent !== c.intent) errs.push(`intent: ждали ${c.intent}, получили ${p.intent}`);
  if (c.code && p.codes[0] !== c.code) errs.push(`code: ждали ${c.code}, получили ${p.codes[0] || '—'}`);
  if (c.type && p.equipmentTypes[0]?.canonical !== c.type) errs.push(`type: ждали ${c.type}, получили ${p.equipmentTypes[0]?.canonical || '—'}`);
  if (c.field && p.fields[0]?.canonical !== c.field) errs.push(`field: ждали ${c.field}, получили ${p.fields[0]?.canonical || '—'}`);
  if (errs.length) {
    failed++;
    console.log(`FAIL «${c.q}» — ${errs.join('; ')}`);
  } else {
    console.log(`ok   «${c.q}» → ${p.intent}`);
  }
}

// Критично (ТЗ §9.3): похожие коды не путаются
const b = parseQuestion('найди тег 3700-B08-DW-002B').codes[0];
const v = parseQuestion('найди тег 3700-B08-DW-0028').codes[0];
if (b === v) { failed++; console.log('FAIL похожие коды слились в один'); } else console.log('ok   похожие коды различаются');

console.log(failed ? `\nИТОГ: ${failed} провалов` : '\nИТОГ: все проверки пройдены');
process.exit(failed ? 1 : 0);
