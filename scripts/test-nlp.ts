// Тесты понимания речи ИИ-чата: npx tsx scripts/test-nlp.ts
import { stem, fuzzyEqual, parse, hasIntent, fieldMatchesStems } from '../src/guide/support/nlp';

let ok = 0, fail = 0; const fails: string[] = [];
const check = (n: string, c: boolean) => { if (c) ok++; else { fail++; fails.push('✗ ' + n); } };

// Стеммер: словоформы → общая основа
check('вентиляторов≈вентилятор', stem('вентиляторов') === stem('вентилятор'));
check('вентилятору≈вентилятор', stem('вентилятору') === stem('вентилятор'));
check('клапаны≈клапан', stem('клапаны') === stem('клапан'));
check('оборудования≈оборудование', stem('оборудования') === stem('оборудование'));
check('заметки≈заметка', stem('заметки') === stem('заметка'));
check('критичные≈критичный', stem('критичные') === stem('критичный'));

// Опечатки
check('опечатка спецификацыя', fuzzyEqual(stem('спецификацыя'), stem('спецификация')));
check('опечатка менеджмнт', fuzzyEqual('менеджмнт', 'менеджмент'));
check('опечатка оборудвание', fuzzyEqual(stem('оборудвание'), stem('оборудование')));
check('не путает разное', !fuzzyEqual('клапан', 'вентилятор'));

// Коды
check('код 3700-K02-HV-209', parse('где 3700-K02-HV-209').codes.length === 1);
check('код ВР-80-75', parse('покажи ВР-80-75-4').codes[0] === 'ВР-80-75-4');
check('простое число не код', parse('сколько 5 штук').codes.length === 0);

// Намерение через синонимы
check('коробки→установки', hasIntent(parse('покажи коробки'), ['установк', 'аху']));
check('просрочка→закупки', hasIntent(parse('что в просрочке'), ['закупк', 'этап']));
check('повторы→дубли', hasIntent(parse('покажи повторы'), ['дубл']));
check('косяки→проблемы', hasIntent(parse('какие косяки'), ['критичн', 'дубл']));
check('готовность→сводка', hasIntent(parse('готовность проекта'), ['сводк', 'статус']));

// Поиск по полю со склонениями
check('поле: вентиляторами найдено по вентилятор', fieldMatchesStems('приточный вентилятор SF-1', parse('вентиляторов').stems));
check('поле: не находит лишнее', !fieldMatchesStems('клапан обратный', parse('насос').stems));

console.log(`\nNLP: пройдено ${ok}, провалено ${fail}`);
if (fails.length) { console.log(fails.join('\n')); process.exit(1); }
