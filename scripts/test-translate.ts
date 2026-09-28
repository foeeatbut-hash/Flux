/**
 * Проверки переводчика.
 *
 * Здесь ошибка не видна глазом: перевод выглядит правдоподобно и в тот же миг
 * уходит заказчику. Дороже всего стоят три вещи — тронутый код (`Ø108×4` стал
 * `O108x4`), развалившийся на обрывки сегмент (память после этого не совпадает
 * никогда) и адрес движка, оказавшийся чужим. Их проверяем в первую очередь.
 *
 * Запуск: npx tsx scripts/test-translate.ts
 */
import { detectLang, worthTranslating, defaultTarget } from '../src/translate/lang';
import { splitSegments, splitSentences, normKey, similarity, fingerprint } from '../src/translate/segment';
import { protect, restore, nothingToTranslate, isSlot } from '../src/translate/protect';
import { buildIndex, lookupAt, tokenize, applyCase, stemRu, mergeIndexes } from '../src/translate/glossary';
import { byPhrase, phraseCount } from '../src/translate/phrases';
import { buildTm, exactHit, fuzzyHit } from '../src/translate/tm';
import { glossZh, splitZh, zhWordCount } from '../src/translate/zh';
import { parseTmx, buildTmx } from '../src/translate/tmx';
import { checkEndpoint, endpointUrl, askModel } from '../src/translate/model';
import { translateSegment, translateText, joinSegments, readiness, builtinTerms, composeTerms } from '../src/translate/engine';
import { parsePack } from '../src/translate/pack';
import { existsSync, readFileSync } from 'fs';
import { gunzipSync } from 'zlib';
import { findDates, deadlineOf, asksIn, codesIn, digestOf, dueLabel } from '../src/translate/mailDigest';
import type { TermPair, TmEntry } from '../src/translate/types';

let failed = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  if (cond) return;
  failed++;
  console.error(`  ✗ ${name}${got === undefined ? '' : ` — получили ${JSON.stringify(got)}`}`);
};

console.log('Язык');
{
  check('русское предложение', detectLang('Расход воздуха в приточной установке') === 'ru');
  check('английское письмо', detectLang('Please find attached the data sheet') === 'en');
  check('китайское письмо', detectLang('请确认收到附件，谢谢') === 'zh');
  check('латиницы больше, но строка русская',
    detectLang('Расход 1200 m3/h AHU-01') === 'ru', detectLang('Расход 1200 m3/h AHU-01'));
  check('иероглиф в английском письме перевешивает', detectLang('Dear Sirs, 请确认 the drawing') === 'zh');
  check('одни цифры — язык не определён', detectLang('12 500,5') === 'und');
  check('пусто — не определён', detectLang('') === 'und');
  check('русский переводим на английский', defaultTarget('ru') === 'en');
  check('английский переводим на русский', defaultTarget('en') === 'ru');
  check('китайский переводим на русский', defaultTarget('zh') === 'ru');
  check('код переводить нечего', !worthTranslating('AHU-01'));
  check('название переводить стоит', worthTranslating('Опросный лист'));
}

console.log('Сегменты');
{
  const s = splitSentences('Расход 1250,5 м3/ч. См. п. 5.2 приложения. Готово.');
  check('дробное число не рвёт предложение', s.length === 3, s);
  check('сокращение «п.» не рвёт', s[1].includes('п. 5.2'), s[1]);
  const segs = splitSegments('Первая строка.\nВторая строка.');
  check('перевод строки — отдельный сегмент', segs.includes('\n'), segs);
  check('текст собирается обратно без потерь',
    segs.join('') === 'Первая строка.\nВторая строка.', segs.join(''));
  check('ключ памяти не различает регистр и хвост',
    normKey('Расход  воздуха.') === normKey('расход воздуха'));
  check('ё и е — одно и то же', normKey('Приём') === normKey('прием'));
  check('похожие строки', similarity('расход воздуха на притоке', 'расход воздуха на вытяжке') > 0.5);
  check('разные строки', similarity('опросный лист', 'график поставки') < 0.2);
  check('отпечаток меняется от правки',
    fingerprint(['а', 'б']) !== fingerprint(['а', 'в']));
  check('отпечаток не меняется от регистра',
    fingerprint(['Расход воздуха']) === fingerprint(['расход  воздуха']));
}

console.log('Защита кодов и чисел');
{
  const cases = [
    'Ø108×4', 'AHU-01', '22062-PEQ-0371-E02', 'DN50', 'IP54', '1 250,5',
    '12.09.2026', 'ivanov@veza.ru', 'https://example.local/doc', 'ГОСТ 21.408',
  ];
  for (const c of cases) {
    const p = protect(`Позиция ${c} по проекту`);
    check(`${c} вынут целиком`, p.slots.includes(c), p.slots);
    check(`${c} вернулся как был`, restore(p.masked, p.slots) === `Позиция ${c} по проекту`);
  }
  const many = protect('Расход 1200 м3/ч, напор 350 Па, вес 120 кг');
  check('несколько чисел подряд', many.slots.length === 3, many.slots);
  check('и все вернулись', restore(many.masked, many.slots) === 'Расход 1200 м3/ч, напор 350 Па, вес 120 кг');
  check('метка — одиночный символ', isSlot(String.fromCharCode(0xe010)));
  check('слово — не метка', !isSlot('расход'));
  check('ячейка из одних кодов не переводится', nothingToTranslate('AHU-01'));
  check('ячейка с датой не переводится', nothingToTranslate('12.09.2026'));
  check('ячейка с текстом переводится', !nothingToTranslate('Опросный лист AHU-01'));
}

console.log('Глоссарий');
{
  const pairs: TermPair[] = [
    { ru: 'расход воздуха', en: 'air flow rate' },
    { ru: 'расход', en: 'flow rate' },
    { ru: 'опросный лист', en: 'data sheet' },
  ];
  const idx = buildIndex(pairs, 'ru', 'en');
  const toks = tokenize('Расход воздуха на входе');
  const hit = lookupAt(idx, toks, 0);
  check('побеждает самое длинное совпадение', hit?.dst === 'air flow rate', hit);
  const one = lookupAt(idx, tokenize('Расход по проекту'), 0);
  check('короткий термин тоже находится', one?.dst === 'flow rate', one);
  const loose = lookupAt(idx, tokenize('Расхода воздуха не хватает'), 0);
  check('падеж не мешает', loose?.dst === 'air flow rate', loose);
  check('огрубление режет окончание', stemRu('расхода') === stemRu('расходом'));
  check('короткое слово не режется', stemRu('вал') === 'вал');
  check('прописные переносятся', applyCase('РАСХОД', 'flow rate') === 'FLOW RATE');
  check('заглавная переносится', applyCase('Расход', 'flow rate') === 'Flow rate');
  check('строчная остаётся', applyCase('расход', 'flow rate') === 'flow rate');
  const back = buildIndex(pairs, 'en', 'ru');
  check('обратное направление строится', back.exact.get('data sheet') === 'опросный лист');
  const merged = mergeIndexes([buildIndex([{ ru: 'расход', en: 'consumption' }], 'ru', 'en'), idx]);
  check('свой словарь старше встроенного', merged.exact.get('расход') === 'consumption');
  check('встроенный словарь непустой', builtinTerms('ru', 'en').size > 300, builtinTerms('ru', 'en').size);
  check('встроенный читается и назад', builtinTerms('en', 'ru').size > 300, builtinTerms('en', 'ru').size);
}

console.log('Узоры писем');
{
  check('вложение', byPhrase('Please find attached the data sheet', 'en', 'ru') === 'Во вложении data sheet');
  check('подтверждение', byPhrase('Please confirm receipt', 'en', 'ru') === 'Просим подтвердить получение');
  check('точка в конце не мешает', byPhrase('Best regards.', 'en', 'ru') === 'С уважением');
  check('регистр не мешает', byPhrase('PLEASE CONFIRM', 'en', 'ru') === 'Просим подтвердить');
  check('обратно тоже', byPhrase('Просим подтвердить получение', 'ru', 'en') === 'Please confirm receipt');
  check('чужая строка не подходит', byPhrase('Расход воздуха 1200', 'ru', 'en') === null);
  check('узоров достаточно', phraseCount() > 60, phraseCount());
}

console.log('Память переводов');
{
  const entries: TmEntry[] = [
    { src: 'Опросный лист на вентиляционную установку', dst: 'Data sheet for air handling unit', from: 'ru', to: 'en' },
    { src: 'График изготовления оборудования', dst: 'Equipment fabrication schedule', from: 'ru', to: 'en' },
    { src: 'Расход воздуха на притоке', dst: 'Supply air flow rate', from: 'ru', to: 'en' },
  ];
  const tm = buildTm(entries, 'ru', 'en');
  check('точное совпадение',
    exactHit(tm, 'опросный лист на вентиляционную установку ') === 'Data sheet for air handling unit');
  check('чужая строка не находится', exactHit(tm, 'Технический паспорт') === undefined);
  const near = fuzzyHit(tm, 'Расход воздуха на вытяжке');
  check('похожая строка находится', near?.dst === 'Supply air flow rate', near);
  check('и честно говорит, насколько похожа', (near?.score || 0) < 1, near?.score);
  check('непохожая не находится', fuzzyHit(tm, 'Сертификат соответствия') === null);
  check('чужое направление в память не попадает',
    buildTm(entries, 'en', 'ru').entries.length === 0);
}

console.log('Китайский');
{
  check('словарь непустой', zhWordCount() > 100, zhWordCount());
  const parts = splitZh('空调机组');
  check('режется по самому длинному', parts.length === 1 && parts[0].ru === 'вентиляционная установка', parts);
  const g = glossZh('请确认收到附件');
  check('подстрочник собирается', g.text.includes('просим') && g.text.includes('вложение'), g.text);
  check('разобрано целиком', g.known === g.total, g);
  const partial = glossZh('请确认龘龘');
  check('незнакомое остаётся иероглифом', partial.text.includes('龘'), partial.text);
  check('и это видно по доле', partial.known < partial.total, partial);
  check('латиница внутри сохраняется', glossZh('设备 AHU-01 安装').text.includes('AHU-01'));
}

console.log('Обмен памятью (TMX)');
{
  const entries: TmEntry[] = [
    { src: 'Опросный лист', dst: 'Data sheet', from: 'ru', to: 'en' },
    { src: 'Габаритный чертёж «А»', dst: 'General arrangement drawing "A"', from: 'ru', to: 'en' },
  ];
  const xml = buildTmx(entries);
  const back = parseTmx(xml);
  const ruEn = back.filter((e) => e.from === 'ru' && e.to === 'en');
  check('записали и прочитали', ruEn.length === 2, ruEn.length);
  check('кавычки не потерялись',
    ruEn[1].dst === 'General arrangement drawing "A"', ruEn[1]);
  check('обратная пара тоже есть', back.some((e) => e.from === 'en' && e.to === 'ru'));
  const foreign = parseTmx(`<tmx><body><tu>
    <tuv xml:lang="ru-RU"><seg>Насос</seg></tuv>
    <tuv xml:lang="en-US"><seg>Pump</seg></tuv>
    <tuv xml:lang="de"><seg>Pumpe</seg></tuv>
  </tu></body></tmx>`);
  check('чужие метки языка понимаются',
    foreign.some((e) => e.from === 'ru' && e.to === 'en' && e.dst === 'Pump'), foreign);
  check('неизвестный язык пропускается', !foreign.some((e) => e.from === 'und' || e.to === 'und'));
}

console.log('Слот локального движка');
{
  check('свой адрес годится', checkEndpoint('http://127.0.0.1:5000').ok);
  check('localhost годится', checkEndpoint('http://localhost:5000/translate').ok);
  check('своя сеть годится', checkEndpoint('http://192.168.1.10:5000').ok);
  check('сеть предприятия годится', checkEndpoint('http://10.20.0.5:8080').ok);
  check('чужой адрес не годится', !checkEndpoint('https://translate.googleapis.com').ok);
  check('и объясняет почему', checkEndpoint('https://api.example.com').reason.includes('не свой'));
  check('пустой адрес — просто не подключён', checkEndpoint('').reason === 'Адрес не указан');
  check('мусор не годится', !checkEndpoint('переводчик').ok);
  check('путь не теряется', endpointUrl('http://127.0.0.1:5000/') === 'http://127.0.0.1:5000/translate');
  check('и не удваивается', endpointUrl('http://127.0.0.1:5000/translate') === 'http://127.0.0.1:5000/translate');
}

console.log('Движок целиком');
{
  const seg = translateSegment('Опросный лист', { from: 'ru', to: 'en' });
  check('термин переводится по словарю', seg.dst === 'Data sheet', seg);
  check('и помечается происхождением', seg.origin === 'glossary', seg.origin);
  const kept = translateSegment('AHU-01', { from: 'ru', to: 'en' });
  check('код проходит насквозь', kept.origin === 'kept' && kept.dst === 'AHU-01', kept);
  const tm = buildTm([{ src: 'Опросный лист', dst: 'Equipment data sheet', from: 'ru', to: 'en' }], 'ru', 'en');
  const fromTm = translateSegment('Опросный лист', { from: 'ru', to: 'en', tm });
  check('память старше словаря', fromTm.dst === 'Equipment data sheet' && fromTm.origin === 'tm', fromTm);
  const phrase = translateSegment('Please confirm receipt', { from: 'en', to: 'ru' });
  check('узор старше словаря', phrase.origin === 'phrase', phrase);
  const none = translateSegment('Жжёный шмурдяк', { from: 'ru', to: 'en' });
  check('незнакомое честно не переведено', none.origin === 'none' && none.dst === '', none);
  const numbers = translateSegment('Расход воздуха 1 200 м3/ч', { from: 'ru', to: 'en' });
  check('число не тронуто', numbers.dst.includes('1 200'), numbers.dst);
  check('единица переведена', numbers.dst.includes('m3/h'), numbers.dst);

  const segs = translateText('Опросный лист.\nГрафик изготовления.', { from: 'ru', to: 'en' });
  check('строки не потеряны', joinSegments(segs).includes('\n'), joinSegments(segs));
  const r = readiness(segs);
  check('готовность считается по настоящим сегментам', r.total === 2, r);
  check('по словарю — не готово к отправке', r.ready === 0, r);
}

// Английская версия файла (.docx/.xlsx) — отдельный набор test-translate-file

console.log('Разбор письма');
{
  // Четверг, 27 августа 2026
  const NOW = new Date(2026, 7, 27, 12, 0, 0, 0);
  const letter = [
    'Dear Mr. Raupov,',
    'Please find attached the data sheet 22062-PEQ-0371-E02 rev. B.',
    'We kindly ask you to provide your comments by 12 September 2026.',
    'Best regards, Wison',
  ].join('\n');

  const dates = findDates(letter, NOW);
  check('дата письма найдена', dates.length === 1, dates.map((d) => d.said));
  check('и она про сентябрь', dates[0]?.at.getMonth() === 8 && dates[0]?.at.getDate() === 12, dates[0]?.at);
  check('и помечена сроком', dates[0]?.due === true, dates[0]);
  const due = deadlineOf(letter, NOW);
  check('срок письма — она же', due?.at.getDate() === 12, due);

  const asks = asksIn(letter, 'en');
  check('просьбы найдены', asks.length === 2, asks);
  check('подпись просьбой не считается', !asks.some((a) => /Best regards/.test(a)), asks);

  const codes = codesIn(letter);
  check('номер документа найден', codes.includes('22062-PEQ-0371-E02'), codes);
  check('ревизия найдена', codes.includes('рев. B'), codes);

  check('срок словами', dueLabel(new Date(2026, 8, 12), NOW).includes('через'), dueLabel(new Date(2026, 8, 12), NOW));
  check('завтра так и называется', dueLabel(new Date(2026, 7, 28), NOW) === 'завтра');
  check('прошедший срок виден', dueLabel(new Date(2026, 7, 20), NOW).includes('прошёл'));

  const ru = 'Просим выслать опросные листы не позднее 12.09.2026.';
  check('русское письмо: просьба', asksIn(ru, 'ru').length === 1, asksIn(ru, 'ru'));
  check('русское письмо: срок', deadlineOf(ru, NOW)?.at.getMonth() === 8, deadlineOf(ru, NOW));

  const zh = '请在2026年9月12日之前确认收到附件。';
  check('китайское письмо: просьба', asksIn(zh, 'zh').length === 1, asksIn(zh, 'zh'));
  check('китайское письмо: срок', deadlineOf(zh, NOW)?.at.getDate() === 12, deadlineOf(zh, NOW));

  const d = digestOf(letter, 'en', NOW);
  check('разбор собирается целиком', d.asks.length === 2 && !!d.deadline && d.codes.length >= 2, d);
  check('год без указания не уводит в прошлое',
    (deadlineOf('Please reply by 5 January.', NOW)?.at.getFullYear() || 0) === 2027,
    deadlineOf('Please reply by 5 January.', NOW)?.at.toISOString());
}

console.log('Словарный пакет');
{
  const info = parsePack([
    '# комментарий не строка словаря',
    'насос\tpump\tor',
    'теплообменник\theat exchanger\twd',
    'пустое\t\tor',
    'без табуляции',
  ].join('\n'));
  check('разобраны только полные строки', info.pairs.length === 2, info.pairs);
  check('источники сосчитаны', info.fromDict === 1 && info.fromWiki === 1, info);

  // Старшинство. Пакет добирает общую лексику и не смеет переименовывать
  // термины: «расход» в ведомости — это flow rate, а не consumption
  const pack = buildIndex([{ ru: 'расход', en: 'consumption' }], 'ru', 'en');
  const project = buildIndex([{ ru: 'насос', en: 'circulation pump' }], 'ru', 'en');
  check('встроенный словарь старше пакета',
    composeTerms({ from: 'ru', to: 'en', pack }).exact.get('расход') === 'flow rate',
    composeTerms({ from: 'ru', to: 'en', pack }).exact.get('расход'));
  check('словарь проекта старше всех',
    composeTerms({ from: 'ru', to: 'en', terms: project, pack }).exact.get('насос') === 'circulation pump');

  // Слияние считается один раз на набор словарей: на ведомости в четыреста
  // строк оно шло четыреста раз, а пакет весит семьдесят тысяч пар
  const a = composeTerms({ from: 'ru', to: 'en', terms: project, pack });
  const b = composeTerms({ from: 'ru', to: 'en', terms: project, pack });
  check('слияние словарей не пересчитывается на каждый сегмент', a === b);

  // Настоящий файл: он и уезжает в сборку, и по нему видно, собрался ли пакет
  const packPath = new URL('../public/dict/ru-en.tsv.gz', import.meta.url).pathname;
  if (!existsSync(packPath)) {
    console.log('  · файла пакета нет — пересоберите scripts/build-dict.ts');
  } else {
    const real = parsePack(gunzipSync(readFileSync(packPath)).toString('utf8'));
    check('в пакете больше пятидесяти тысяч пар', real.pairs.length > 50000, real.pairs.length);
    const realIdx = buildIndex(real.pairs, 'ru', 'en');
    check('слово из Викиданных на месте',
      realIdx.exact.get('теплообменник') === 'heat exchanger', realIdx.exact.get('теплообменник'));
    check('пакет не переименовывает термины программы',
      translateSegment('Расход воздуха', { from: 'ru', to: 'en', pack: realIdx }).dst === 'Air flow rate',
      translateSegment('Расход воздуха', { from: 'ru', to: 'en', pack: realIdx }).dst);
  }
}

console.log('Движок по адресу владельца');
{
  const fake = async (_url: any, init: any) => {
    const body = JSON.parse(String(init.body));
    return { ok: true, json: async () => ({ translations: body.q.map((x: string) => `[${x}]`) }) } as any;
  };
  askModel({ url: 'http://127.0.0.1:5000' }, ['Насос'], 'ru', 'en', fake as any).then((r) => {
    check('ответ движка принят', r?.[0] === '[Насос]', r);
    askModel({ url: 'https://api.example.com' }, ['Насос'], 'ru', 'en', fake as any).then((bad) => {
      check('на чужой адрес не ходим', bad === null, bad);
      finish();
    });
  });
}

function finish() {
  if (failed) {
    console.error(`\n${failed} проверок не прошли`);
    process.exit(1);
  }
  console.log('\nВсе проверки переводчика прошли');
}
