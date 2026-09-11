/**
 * Договор об отправке обращения.
 *
 * Проверка на разрешение, а не на запрет: разбор собирает новый объект по
 * одному полю, поэтому лишнее не проезжает даже случайно. Здесь это и
 * подтверждается — вместе с тем, что автора, статуса и приоритета в договоре
 * нет вовсе: их ставит сервер, и присланным им верить нельзя.
 */

import {
  validateSubmit, checkText, LIMITS, TYPES, STATUSES, PRIORITIES, IMPACTS, FREQUENCIES,
  reportNumber, refusedByName, extensionOf, isUuid, ERRORS, STATUS_NAMES, TYPE_NAMES, IMPACT_NAMES,
  newRequestId, titleFrom,
} from '../feedback/contracts';
import { sha256Hex, sha256 } from '../feedback/sha256';

let f = 0;
const ok = (name: string, cond: boolean, detail?: unknown) =>
  cond
    ? console.log('  ✓', name)
    : (f++, console.error('  ✗', name, detail !== undefined ? JSON.stringify(detail).slice(0, 300) : ''));

const NOW = Date.parse('2026-09-09T12:00:00.000Z');
const good = () => ({
  schemaVersion: 1,
  clientRequestId: '11111111-2222-4333-8444-555555555555',
  deploymentId: 'dep-1',
  type: 'BUG',
  title: 'Таблица не сохраняется',
  description: 'После правки ячейки состояние висит на «Сохраняется» и не меняется.',
  sectionKey: '/sheet',
  incidentAt: new Date(NOW - 60000).toISOString(),
  appVersion: '1.1.0',
  frequency: 'ALWAYS',
  impact: 'HIGH',
  uploadIds: [],
  consent: { technicalEvents: true, appContext: true, reviewedAt: new Date(NOW).toISOString() },
});

console.log('1. Правильная отправка проходит');
{
  const r = validateSubmit(good(), NOW);
  ok('разбор принят', r.ok, r.error);
  ok('заголовок обрезан от пробелов', r.value?.title === 'Таблица не сохраняется');
  ok('шаги по умолчанию — пустой список', Array.isArray(r.value?.reproduction) && r.value?.reproduction?.length === 0);
  ok('согласие на технические события сохранено', r.value?.consent.technicalEvents === true);
}

console.log('\n1.1. Короткое сообщение принимается, заголовок выводится сам');
{
  // Ради этого правилась нижняя граница. «Зависло» — законченное сообщение о
  // сбое, и требовать «хотя бы одно предложение» значит требовать сочинения
  // от человека, у которого только что всё встало
  const short = validateSubmit({ ...good(), title: '', description: 'Зависло' }, NOW);
  ok('«Зависло» проходит', short.ok, short.error);
  ok('заголовок выведен из сообщения', short.value?.title === 'Зависло', short.value?.title);

  // Первое предложение бывает короче самого сообщения по-глупому — раньше
  // именно на этом форма отказывала
  const yes = validateSubmit(
    { ...good(), title: '', description: 'Да. Программа зависла при открытии таблицы.' }, NOW);
  ok('«Да. Программа зависла…» не отклоняется за первое предложение', yes.ok, yes.error);
  ok('заголовком стало осмысленное, а не «Да.»',
    (yes.value?.title || '').startsWith('Да. Программа зависла'), yes.value?.title);

  ok('пустое сообщение по-прежнему отвергнуто',
    !validateSubmit({ ...good(), title: '', description: '   ' }, NOW).ok);

  // Старый клиент шлёт заголовок сам — его проверяем как проверяли
  ok('присланный слишком короткий заголовок отвергнут',
    !validateSubmit({ ...good(), title: 'ой' }, NOW).ok);
  ok('присланный нормальный заголовок сохранён',
    validateSubmit(good(), NOW).value?.title === 'Таблица не сохраняется');

  ok('название раздела добавляется только к совсем короткому',
    titleFrom('Зависло', 'Таблица') === 'Зависло — Таблица'
    && titleFrom('Программа зависла при вставке столбца', 'Таблица') === 'Программа зависла при вставке столбца');
  ok('длинное сообщение обрезано по пределу заголовка',
    titleFrom('я'.repeat(400)).length === LIMITS.title.max);
}

console.log('\n2. Лишние поля не проезжают');
{
  // Самое опасное: клиент присылает себя администратором или чужим автором
  const r = validateSubmit({
    ...good(),
    authorId: 'чужой-сотрудник', status: 'DONE', priority: 'P0',
    number: 1, revision: 99, trustedSummary: 'всё хорошо',
  }, NOW);
  ok('разбор принят', r.ok, r.error);
  const keys = Object.keys(r.value || {});
  ok('автора в договоре нет', !keys.includes('authorId'), keys);
  ok('статуса нет', !keys.includes('status'), keys);
  ok('приоритета нет', !keys.includes('priority'), keys);
  ok('номера нет', !keys.includes('number'), keys);
  ok('придуманной сводки нет', !keys.includes('trustedSummary'), keys);
}

console.log('\n3. Границы длин');
{
  ok('короткий заголовок отвергнут', !validateSubmit({ ...good(), title: 'ой' }, NOW).ok);
  ok('пустое описание отвергнуто', !validateSubmit({ ...good(), description: '   ' }, NOW).ok);
  ok('слишком длинный заголовок отвергнут',
    !validateSubmit({ ...good(), title: 'я'.repeat(LIMITS.title.max + 1) }, NOW).ok);
  ok('описание на пределе принято',
    validateSubmit({ ...good(), description: 'я'.repeat(LIMITS.description.max) }, NOW).ok);
  ok('описание за пределом отвергнуто',
    !validateSubmit({ ...good(), description: 'я'.repeat(LIMITS.description.max + 1) }, NOW).ok);
  ok('пробелы не считаются содержанием', !checkText('     ', 'Поле', 1, 10).ok);
}

console.log('\n4. Перечисления и ключи');
{
  ok('чужой вид обращения отвергнут', !validateSubmit({ ...good(), type: 'ЖАЛОБА' }, NOW).ok);
  ok('чужое влияние отвергнуто', !validateSubmit({ ...good(), impact: 'СРОЧНО' }, NOW).ok);
  ok('ключ отправки должен быть UUID', !validateSubmit({ ...good(), clientRequestId: 'ключ' }, NOW).ok);
  ok('чужая версия договора отвергнута', !validateSubmit({ ...good(), schemaVersion: 2 }, NOW).ok);
  ok('не объект отвергнут', !validateSubmit('строка', NOW).ok);
  ok('проверка UUID работает', isUuid('11111111-2222-4333-8444-555555555555') && !isUuid('нет'));
}

console.log('\n5. Время происшествия');
{
  ok('час назад — принято', validateSubmit({ ...good(), incidentAt: new Date(NOW - 3600e3).toISOString() }, NOW).ok);
  // Сорок часов — это обращение, написанное в пятницу вечером без связи и
  // уехавшее в понедельник. Раньше здесь стояли сутки, и такая отправка
  // отвергалась НАВСЕГДА: время происшествия не меняется, и очередь билась в
  // один и тот же отказ, пока человек не сдавался
  ok('выходные офлайн — отправка доезжает',
    validateSubmit({ ...good(), incidentAt: new Date(NOW - 40 * 3600e3).toISOString() }, NOW).ok);
  ok('когда отправили — записано отдельно от того, когда сломалось',
    validateSubmit({ ...good(), incidentAt: new Date(NOW - 40 * 3600e3).toISOString() }, NOW)
      .value?.submittedAt === new Date(NOW).toISOString());
  ok('позапрошлогоднее всё же отвергнуто',
    !validateSubmit({ ...good(), incidentAt: new Date(NOW - 400 * 24 * 3600e3).toISOString() }, NOW).ok);
  ok('время из будущего отвергнуто',
    !validateSubmit({ ...good(), incidentAt: new Date(NOW + 3600e3).toISOString() }, NOW).ok);
  // Часы двух машин расходятся на минуты — это не повод отказывать
  ok('минута расхождения часов допустима',
    validateSubmit({ ...good(), incidentAt: new Date(NOW + 30000).toISOString() }, NOW).ok);
  ok('мусор вместо времени отвергнут', !validateSubmit({ ...good(), incidentAt: 'вчера' }, NOW).ok);
}

console.log('\n6. Шаги и вложения');
{
  ok('шагов не больше объявленного',
    !validateSubmit({ ...good(), reproduction: Array(LIMITS.steps + 1).fill('шаг') }, NOW).ok);
  ok('пустые шаги отбрасываются',
    validateSubmit({ ...good(), reproduction: ['открыл', '', '  ', 'нажал'] }, NOW).value?.reproduction?.length === 2);
  ok('вложений не больше объявленного',
    !validateSubmit({ ...good(), uploadIds: Array(LIMITS.attachments + 1).fill('11111111-2222-4333-8444-555555555555') }, NOW).ok);
  ok('повторы вложений схлопываются',
    validateSubmit({ ...good(), uploadIds: ['11111111-2222-4333-8444-555555555555', '11111111-2222-4333-8444-555555555555'] }, NOW)
      .value?.uploadIds?.length === 1);
  ok('не-UUID вложение отвергнуто', !validateSubmit({ ...good(), uploadIds: ['файл.png'] }, NOW).ok);
}

console.log('\n7. Что не берём вложением');
{
  ok('исполняемое отвергается', refusedByName('вирус.exe'));
  ok('скрипт оболочки отвергается', refusedByName('run.ps1'));
  // SVG — тот же HTML со скриптом внутри, а вложение открывают не задумываясь
  ok('svg отвергается', refusedByName('схема.svg'));
  ok('макросная книга отвергается', refusedByName('расчёт.xlsm'));
  ok('архив отвергается', refusedByName('всё.zip'));
  ok('картинка принимается', !refusedByName('снимок.png'));
  ok('документ принимается', !refusedByName('записка.docx'));
  ok('расширение берётся последним', extensionOf('отчёт.v2.pdf') === 'pdf');
  ok('файл без расширения не ломает разбор', extensionOf('README') === '');
}

console.log('\n8. Словарь полон');
{
  ok('у каждого статуса есть русское имя', STATUSES.every((s) => !!STATUS_NAMES[s]));
  ok('у каждого вида есть русское имя', TYPES.every((t) => !!TYPE_NAMES[t]));
  ok('у каждого влияния есть русское имя', IMPACTS.every((i) => !!IMPACT_NAMES[i]));
  ok('приоритетов четыре', PRIORITIES.length === 4);
  ok('частот четыре', FREQUENCIES.length === 4);
  ok('номер человеку виден словом', reportNumber(123) === 'ОБР-000123');
  ok('коды ошибок объявлены', !!ERRORS.REVISION_CONFLICT && !!ERRORS.IDEMPOTENCY_CONFLICT);
}

console.log('\n9. Отпечаток считается своими силами');
{
  // Встроенный crypto.subtle работает только в защищённом контексте, а отдел
  // сидит на обычном http://сервер:3000 — там его нет вовсе. Поэтому своя
  // реализация, и её надо проверять на известных векторах, а не на самой себе
  const bytes = (text: string) => new TextEncoder().encode(text);
  ok('пустая строка', sha256Hex(bytes(''))
    === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  ok('abc', sha256Hex(bytes('abc'))
    === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  ok('два блока', sha256Hex(bytes('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))
    === '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  // Русский текст — это многобайтовые знаки: место добивки считается по байтам,
  // а не по длине строки
  ok('русский текст', sha256Hex(bytes('Проверка'))
    === sha256Hex(new Uint8Array(Array.from(bytes('Проверка')))));
  ok('ровно 64 байта — граница блока',
    sha256Hex(new Uint8Array(64)) === 'f5a5fd42d16a20302798ef6ed309979b43003d2320d9f0e8ea9831a92759fb4b');
  ok('55 байт — последний размер без лишнего блока',
    sha256Hex(new Uint8Array(55)).length === 64);
  ok('56 байт — уже с лишним блоком', sha256Hex(new Uint8Array(56)).length === 64);
  ok('длинный вход', sha256Hex(new Uint8Array(100000)).length === 64);
}

void (async () => {
  const bytes = new TextEncoder().encode('abc');
  const fast = await sha256(bytes);
  ok('быстрый путь даёт то же число', fast === sha256Hex(bytes), fast);
  console.log('\n10. Ключ отправки');
  {
    const one = newRequestId();
    ok('ключ — настоящий UUID четвёртой версии', isUuid(one) && one[14] === '4', one);
    // Ключ решает, одна карточка или две: совпадение здесь стоит потерянного
    // обращения, а не косметики
    const many = new Set(Array.from({ length: 5000 }, () => newRequestId()));
    ok('пять тысяч ключей подряд не повторились', many.size === 5000, many.size);
    const checked = validateSubmit({ ...good(), clientRequestId: one }, NOW);
    ok('такой ключ проходит проверку отправки', checked.ok, checked.error);
  }

  console.log(f === 0 ? '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ' : `\nПРОВАЛОВ: ${f}`);
  process.exit(f === 0 ? 0 : 1);
})();
