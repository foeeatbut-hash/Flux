/**
 * Правило тегов проекта: алфавит, идентичность, извлечение из текста.
 *
 * Проверяется прежде всего ПОРЯДОК действий. Старая `normalizeTag` заменяла
 * кириллическую «В» латинской «B» до всякой проверки — и запрет кириллицы был
 * невыполним: запрещённое написание превращалось в разрешённое само собой.
 * Здесь это ловится первым же набором.
 *
 * Запуск: npx tsx scripts/test-tag-policy.ts
 */

import {
  DEFAULT_TAG_POLICY, TAG_MAX, extractCandidates, hasProjectPrefix, identityKeyOf,
  matchesMask, similarityKeyOf, tagPolicyOf, validateTag,
} from '../equipment/tagPolicy';

let f = 0;
const ok = (name: string, cond: boolean, detail?: unknown) =>
  (cond ? console.log('  ✓', name) : (f++, console.error('  ✗', name, detail === undefined ? '' : JSON.stringify(detail))));

const strict = tagPolicyOf({ prefixes: ['3700'], allowCyrillic: false });
const loose = tagPolicyOf({ prefixes: ['3700'], allowCyrillic: true });

console.log('1. Алфавит проверяется ДО любых замен');
{
  const cyr = validateTag('3700-B01-001В', strict);
  ok('кириллическая «В» отклонена', !cyr.ok && cyr.code === 'cyrillic-off', cyr);
  ok('названа буква и её место', cyr.at === 12 && cyr.problem.includes('«В»'), cyr);
  ok('предложена латинская замена', cyr.fix === '3700-B01-001B', cyr.fix);
  ok('но исходник не подменён', cyr.identifier === '3700-B01-001В', cyr.identifier);

  const zh = validateTag('3700-B01-001Ж', strict);
  ok('для «Ж» замена не выдумывается', !zh.ok && zh.fix === '', zh);

  ok('при разрешении кириллица проходит', validateTag('3700-B01-001В', loose).ok);
  ok('латинский тег проходит всегда', validateTag('3700-B01-001B', strict).ok);
}

console.log('\n2. Формат: пробелы, невидимое, тире, дефисы');
{
  ok('внешние пробелы обрезаются', validateTag('  3700-B01-001  ', strict).identifier === '3700-B01-001');
  ok('внутренний пробел — отказ', validateTag('3700 B01', strict).code === 'space');
  ok('невидимый знак — отказ', validateTag('3700-B01​', strict).code === 'invisible');
  const dash = validateTag('3700—B01', strict);
  ok('длинное тире — отказ с исправлением', dash.code === 'dash' && dash.fix === '3700-B01', dash);
  ok('дефис по краям — отказ', validateTag('-3700-B01', strict).code === 'hyphen-edge');
  ok('два дефиса подряд — отказ', validateTag('3700--B01', strict).code === 'hyphen-double');
  ok('греческая буква — отказ', validateTag('3700-Βeta', strict).code === 'foreign');
  ok('точка не разрешена', validateTag('3700.B01', strict).code === 'char');
  ok('пустая строка — отказ', validateTag('   ', strict).code === 'empty');
  ok(`длиннее ${TAG_MAX} — отказ`, validateTag('a1'.repeat(TAG_MAX), strict).code === 'long');
}

console.log('\n3. Идентичность и похожесть — разные ключи');
{
  ok('регистр не различает', identityKeyOf('AHU-1') === identityKeyOf('ahu-1'));
  ok('алфавит различает', identityKeyOf('3700-001B') !== identityKeyOf('3700-001В'));
  ok('похожесть сводит двойников', similarityKeyOf('3700-001В') === similarityKeyOf('3700-001B'));
  ok('похожесть убирает разделители', similarityKeyOf('3700-001-B') === similarityKeyOf('3700001B'));
  ok('идентичность разделители сохраняет', identityKeyOf('3700-001') !== identityKeyOf('3700001'));
}

console.log('\n4. Из текста берутся целые слова');
{
  const one = extractCandidates('Материал такой-то. Тег 3700-B01-001', strict);
  ok('нашёлся один кандидат', one.length === 1 && one[0].identifier === '3700-B01-001', one);
  ok('он предложен, а не назначен', one[0].verdict === 'review', one[0]);
  ok('смещения указывают на текст', one[0].start > 0 && one[0].end === one[0].start + one[0].raw.length);

  const inner = extractCandidates('см. 13700-B01-001', strict);
  ok('из 13700-… не выкусывается 3700', inner.every((c) => c.identifier !== '3700-B01-001'), inner);
  ok('и целое слово тегом проекта не считается', inner[0]?.verdict === 'reference', inner[0]);

  const zh = extractCandidates('тег 3700-B01-001Ж', strict);
  ok('запрещённый суффикс не даёт обрезанного тега',
    zh.length === 1 && zh[0].identifier === '3700-B01-001Ж' && zh[0].verdict === 'invalid', zh);

  const quoted = extractCandidates('подключить к «3700-B01-002».', strict);
  ok('кавычки и точка в тег не попадают',
    quoted.some((c) => c.identifier === '3700-B01-002'), quoted);

  const models = extractCandidates('клапан ТРВ-68-R410A по ГОСТ 12.2, поз. 1.1', strict);
  ok('модель тегом не объявляется', models.every((c) => c.verdict === 'reference'), models);
  ok('позиция 1.1 кандидатом не становится',
    models.every((c) => c.identifier !== '1' && c.identifier !== '1.1'), models);

  const twice = extractCandidates('3700-B01-001 и ещё раз 3700-B01-001', strict);
  ok('повтор даёт два свидетельства одного тега',
    twice.length === 2 && twice[0].identifier === twice[1].identifier, twice);

  const known = extractCandidates('см. AHU-7 в проекте', strict, { registry: ['AHU-7'] });
  ok('точное совпадение с реестром принимается без приставки',
    known[0]?.verdict === 'accepted', known);
}

console.log('\n5. Приставки и маски');
{
  ok('приставка сверяется по границе части', hasProjectPrefix('3700-B01', strict));
  ok('«37001-B01» приставкой 3700 не считается', !hasProjectPrefix('37001-B01', strict));
  ok('маска по числу частей', matchesMask('3700-B01-001', { segments: 3 }));
  ok('маска отвергает лишнюю часть', !matchesMask('3700-B01-AS-001', { segments: 3 }));
  ok('маска с приставкой', matchesMask('3700-B01', { prefix: '3700' }) && !matchesMask('3800-B01', { prefix: '3700' }));
}

console.log('\n6. Политика читается безопасно');
{
  ok('пусто — кириллица запрещена', tagPolicyOf(null).allowCyrillic === false);
  ok('мусор — значения по умолчанию', tagPolicyOf('не json').prefixes.length === 0);
  ok('строкой JSON тоже читается', tagPolicyOf('{"allowCyrillic":true}').allowCyrillic === true);
  ok('умолчание в модуле — запрет', DEFAULT_TAG_POLICY.allowCyrillic === false);
}

console.log(f ? `\nПРОВАЛОВ: ${f}` : '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ');
process.exit(f ? 1 : 0);
