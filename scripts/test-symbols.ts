// Справочник условных обозначений: величину решает тройка «символ + регистр +
// единица». Проверки написаны по настоящим бланкам ВЕЗА (лист технических
// данных установки, бланк-заказ вентилятора, лист на клапаны).
import { resolveSymbol, setSymbolRules, foldSymbol, foldUnit, looksLikeSymbol, splitSymbolUnit } from '../src/import/symbols';
import { parseFormulaLine, matchLabel, unitFromLabel, FIELDS } from '../src/import/dictionary';

let f = 0;
const ok = (n: string, c: boolean, d?: any) => c ? console.log('  ✓', n) : (f++, console.error('  ✗', n, d !== undefined ? JSON.stringify(d) : ''));
const field = (sym: string, unit?: string) => resolveSymbol(sym, unit)?.field;
const label = (sym: string, unit?: string) => resolveSymbol(sym, unit)?.label;

console.log('1. Единица решает величину, а не буква');
ok('«L, м³/ч» → расход воздуха', field('L', 'м³/ч') === 'airflow', field('L', 'м³/ч'));
ok('«L, мм» → длина', field('L', 'мм') === 'length', field('L', 'мм'));
ok('«Q, кВт» → тепловая мощность', field('Q', 'кВт') === 'heatpower', field('Q', 'кВт'));
ok('«Q, м³/ч» → расход', field('Q', 'м³/ч') === 'airflow', field('Q', 'м³/ч'));
ok('«H, Па» → напор', label('H', 'Па') === 'Напор', label('H', 'Па'));
ok('«H, м» → высота', label('H', 'м') === 'Высота', label('H', 'м'));
ok('«G, кг/ч» → массовый расход', field('G', 'кг/ч') === 'massflow', field('G', 'кг/ч'));

console.log('2. Регистр важен там, где он важен');
ok('«N, кВт» → мощность', label('N', 'кВт') === 'Мощность', label('N', 'кВт'));
ok('«n, об/мин» → частота вращения', label('n', 'об/мин') === 'Частота вращения', label('n', 'об/мин'));
ok('«n» с кВт не мощность по строчной букве', field('n', 'кВт') !== 'rpm', field('n', 'кВт'));
ok('регистр «L» не важен: «l, мм» → длина', field('l', 'мм') === 'length', field('l', 'мм'));

console.log('3. Индекс у символа отбрасывается, но не теряется');
ok('«Lв, м³/ч» → расход', field('Lв', 'м³/ч') === 'airflow', field('Lв', 'м³/ч'));
ok('короткий индекс подпись не засоряет', label('Lв', 'м³/ч') === 'Расход воздуха', label('Lв', 'м³/ч'));
ok('«Ny, кВт» → мощность', field('Ny', 'кВт') === 'power');
ok('«Nтэн, кВт» → мощность', field('Nтэн', 'кВт') === 'power', field('Nтэн', 'кВт'));
ok('«Qт, кВт» → тепловая мощность', field('Qт', 'кВт') === 'heatpower', field('Qт', 'кВт'));
// dpсеть.вс и dpсеть.нг — разные потери одного вентилятора: если длинный индекс
// пропадёт из подписи, оба параметра схлопнутся в одну строку и одно значение
ok('длинный индекс остаётся в подписи', label('dpсетьвс', 'Па') === 'Потери давления (dpсетьвс)', label('dpсетьвс', 'Па'));
ok('и различает соседний параметр', label('dpсетьнг', 'Па') !== label('dpсетьвс', 'Па'));

console.log('4. Написания одного знака сходятся');
// Регистр свёртка сохраняет намеренно (N ≠ n), поэтому сравниваем ответы
ok('«ΔP» = «dP» = «DP» = «Δp»', ['ΔP', 'dP', 'DP', 'Δp'].every(x => label(x, 'Па') === 'Потери давления'), ['ΔP', 'dP', 'DP', 'Δp'].map(x => label(x, 'Па')));
ok('«ΔP, Па» → потери давления', label('ΔP', 'Па') === 'Потери давления', label('ΔP', 'Па'));
ok('кириллическая «Р» в «Рполн» = латинская', foldSymbol('Рполн') === foldSymbol('Pполн'));
// Латинские написания («m3/h») приводит к канону словарь единиц до этого места
ok('«м3/ч» = «м³/ч» = «М3/Ч » = «м3/ч.»', new Set(['м3/ч', 'м³/ч', 'М3/Ч ', 'м3/ч.'].map(foldUnit)).size === 1, ['м3/ч', 'м³/ч', 'М3/Ч ', 'м3/ч.'].map(foldUnit));

console.log('5. Незнакомое остаётся незнакомым');
ok('незнакомый символ → null', resolveSymbol('Щ', 'мм') === null);
ok('символ со знакомой буквой, но чужой единицей → null', resolveSymbol('N', 'кДж/кг') === null, field('N', 'кДж/кг'));
ok('слово обозначением не считается', looksLikeSymbol('Расход воздуха') === false);
ok('«ΔP» считается', looksLikeSymbol('ΔP') === true);
ok('«L» считается', looksLikeSymbol('L') === true);
ok('«G4» (класс фильтра) не считается', looksLikeSymbol('G4') === false);

console.log('6. Спор величин — вопрос инженеру, а не догадка');
{
  const m = resolveSymbol('L');
  ok('«L» без единицы возвращает соперников', !!m && (m.rivals || []).length > 0, m);
  ok('и помечен как решённый не единицей', !!m && m.byUnit === false);
  const one = resolveSymbol('U', 'В');
  ok('однозначный символ соперников не имеет', !!one && !one.rivals);
}

console.log('7. Правило отдела кладётся поверх стартового');
setSymbolRules([{ symbol: 'L', field: 'power', label: 'Мощность по-нашему', units: ['кВт'] }]);
ok('своя единица добавилась', label('L', 'кВт') === 'Мощность по-нашему', label('L', 'кВт'));
ok('стартовое правило не пропало', field('L', 'м³/ч') === 'airflow');
setSymbolRules([]);
ok('после сброса своё правило не действует', resolveSymbol('L', 'кВт') === null);

console.log('8. Символ с единицей в подписи');
ok('«L, м³/ч» делится', JSON.stringify(splitSymbolUnit('L, м³/ч')) === JSON.stringify({ symbol: 'L', unit: 'м³/ч' }), splitSymbolUnit('L, м³/ч'));
ok('«N (кВт)» делится', JSON.stringify(splitSymbolUnit('N (кВт)')) === JSON.stringify({ symbol: 'N', unit: 'кВт' }), splitSymbolUnit('N (кВт)'));
ok('обычная подпись не делится', splitSymbolUnit('Расход воздуха, м³/ч').unit === '', splitSymbolUnit('Расход воздуха, м³/ч'));

console.log('9. Формульная строка бланка (настоящие записи)');
{
  const p = parseFormulaLine('Lв=42860м³/ч; Pполн=250 Па, n=2130об/мин');
  ok('три параметра из строки установки', p.length === 3, p.map(x => x.label));
  ok('Pполн больше не теряется', p[1]?.label === 'Полное давление', p[1]);
  ok('n — обороты, а не мощность', p[2]?.label === 'Частота вращения' && p[2]?.fieldId === 'rpm', p[2]);
}
ok('«dpсеть=700Па» разбирается', parseFormulaLine('dpсеть=700Па').length === 1);
ok('«ΔP=200 Па» разбирается', parseFormulaLine('ΔP=200 Па')[0]?.fieldId === 'pressure');
ok('«L=80 мм» — длина', parseFormulaLine('L=80 мм')[0]?.fieldId === 'length');
ok('«Q=25 кВт» — тепловая мощность', parseFormulaLine('Q=25 кВт')[0]?.fieldId === 'heatpower');
{
  // Приток/вытяжка в одном значении: «23150/14240 м³/ч» — не «23150» и мусор
  const p = parseFormulaLine('Lв=23150/14240м3/ч')[0];
  ok('составное значение цело', p?.value === '23150/14240' && p?.unit === 'м³/ч', p);
}
{
  const p = parseFormulaLine('Iном=65,8А')[0];
  ok('запятая — разделитель дробной части, а не параметров', p?.value === '65,8' && p?.fieldId === 'current', p);
}

console.log('10. Единица из подписи');
ok('«Расход, м³/ч» отдаёт единицу', unitFromLabel('Расход, м³/ч') === 'м³/ч', unitFromLabel('Расход, м³/ч'));
ok('«Расход, м3/ч» приводится к канону', unitFromLabel('Расход, м3/ч') === 'м³/ч');

console.log('11. Величины справочника существуют в словаре');
{
  const ids = new Set(FIELDS.map(x => x.id));
  const missing = ['airflow', 'length', 'massflow', 'heatpower', 'rpm', 'power', 'pressure', 'size', 'weight', 'speed', 'noise', 'voltage', 'current', 'temp']
    .filter(id => !ids.has(id));
  ok('все величины из правил есть в FIELDS', missing.length === 0, missing);
}
ok('«L» подписью словаря не считается (это символ)', matchLabel('L') === null);

console.log(f === 0 ? '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ' : `\nПРОВАЛОВ: ${f}`);
process.exit(f === 0 ? 0 : 1);
