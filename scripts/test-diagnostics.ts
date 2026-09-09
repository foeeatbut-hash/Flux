/**
 * Диагностика: что она имеет право записать и что обязана выбросить.
 *
 * Проверка нужна ровно потому, что дефект здесь незаметен. Запись работает,
 * файлы растут, программа не падает — а внутри лежит имя проекта, поисковая
 * строка или пароль из сообщения драйвера. Увидеть это можно только так:
 * подсунуть заведомо секретную строку каждым известным путём и убедиться, что
 * до файла она не доехала.
 *
 * Строка-приманка одна на весь набор: NEVER_LOG_THIS. Если она нашлась в
 * записи — проверка провалена, и неважно, каким путём она туда попала.
 */

import {
  cleanFields, newTraceId, redact, routeName, safeError, safeFrames, safeName,
} from '../diagnostics/event';
import { COMMON, EVENTS, EVENT_NAMES, specOf, type FieldKind } from '../diagnostics/contracts';

let f = 0;
const ok = (name: string, cond: boolean, detail?: unknown) =>
  cond
    ? console.log('  ✓', name)
    : (f++, console.error('  ✗', name, detail !== undefined ? JSON.stringify(detail).slice(0, 300) : ''));

const BAIT = 'NEVER_LOG_THIS';

console.log('1. Секреты не доезжают до записи');
{
  ok('строка подключения теряет пароль',
    !redact(`mysql://admin:${BAIT}@db:3306/flux`).includes(BAIT));
  ok('заголовок авторизации теряет токен',
    !redact(`Authorization: Bearer ${BAIT}`).includes(BAIT));
  ok('пара «пароль = значение» теряет значение',
    !redact(`password="${BAIT}"`).includes(BAIT));
  ok('пара через двоеточие тоже',
    !redact(`{ "token": "${BAIT}" }`).includes(BAIT));
  // Настоящий токен, а не похожая строка: короткая приманка проходила мимо
  // правила, и проверка объявляла защиту рабочей там, где её не было
  ok('токен веб-подписи не остаётся целиком',
    !redact(`eyJhbGciOiJIUzI1NiJ9.${BAIT}payload.signature`).includes(BAIT));
  // Пароль в адресе приезжает закодированным: правило по знаку «=» его не
  // видит, пока percent-кодирование не раскрыто
  ok('percent-кодирование раскрывается до очистки',
    !redact(`/api/login?password%3D${BAIT}`).includes(BAIT));
  ok('личная папка Windows теряет имя сотрудника',
    !redact(`C:\\Users\\${BAIT}\\Desktop`).includes(BAIT));
  ok('личная папка Linux тоже',
    !redact(`/home/${BAIT}/flux`).includes(BAIT));
  ok('поисковая строка не сохраняется',
    !redact(`http://server:3000/api/search?q=${BAIT}`).includes(BAIT));
  ok('безобидная строка не портится', redact('обычное сообщение') === 'обычное сообщение');
}

console.log('\n2. Имя маршрута не выдаёт данные проекта');
{
  // Ровно тот дефект, ради которого правило переписано: раньше «слово из
  // букв» считалось названием маршрута, и название проекта уезжало в файл
  ok('строковый идентификатор из букв не считается маршрутом',
    routeName('/api/projects/секретныйпроект') === '/api/projects/:id',
    routeName('/api/projects/секретныйпроект'));
  ok('латинский идентификатор из букв — тоже',
    routeName('/api/documents/mysecretdoc') === '/api/documents/:id',
    routeName('/api/documents/mysecretdoc'));
  ok('числовой идентификатор скрыт, параметры отброшены',
    routeName(`/api/documents/123?password=${BAIT}`) === '/api/documents/:id');
  ok('известная часть пути сохраняется',
    routeName('/api/projects/7c9e/trash') === '/api/projects/:id/trash',
    routeName('/api/projects/7c9e/trash'));
  ok('две известные части подряд сохраняются',
    routeName('/api/chat/groups') === '/api/chat/groups');
  ok('имя файла вне API не сохраняется',
    routeName(`/chat_files/${BAIT}.docx`) === '/[ресурс]',
    routeName(`/chat_files/${BAIT}.docx`));
  ok('корень остаётся корнем', routeName('/') === '/');
  ok('битый адрес не роняет разбор', typeof routeName('http://[') === 'string');
}

console.log('\n3. Ошибка отдаёт код, а не рассказ');
{
  const error = Object.assign(new Error(`SELECT * FROM users WHERE pass='${BAIT}'`), { code: 'P2002' });
  const safe = safeError(error);
  ok('сообщение ошибки не берётся вовсе', !JSON.stringify(safe).includes(BAIT), safe);
  ok('код ошибки сохраняется', safe.code === 'P2002', safe);
  ok('имя ошибки сохраняется', safe.error === 'Error', safe);
  // Имя ошибки чужая библиотека задаёт как хочет — обезличивать надо и его
  const named = safeError(Object.assign(new Error('x'), { name: `Error: password="${BAIT}"` }));
  ok('секрет в имени ошибки не проходит', !JSON.stringify(named).includes(BAIT), named);

  const stack = `Error: x\n    at saveNow (/home/${BAIT}/flux/src/screens/Doc.tsx:412:19)\n    at tick (/a/b/timer.ts:9:3)`;
  const frames = safeFrames(stack);
  ok('в кадре стека нет пути', !frames.join('|').includes(BAIT), frames);
  ok('в кадре стека нет номера строки', !/\d+:\d+/.test(frames.join('|')), frames);
  ok('имя функции в кадре сохраняется', frames[0]?.includes('saveNow'), frames);
}

console.log('\n4. Словарь событий: записать можно только объявленное');
{
  ok('незнакомое событие не записывается вовсе', cleanFields('office.секрет', { x: 1 }) === null);
  const data = cleanFields('office.snapshot', {
    section: 'sheet', characters: 1200, stringifyMs: 4.567,
    // Поля, которых в словаре нет: подсовываем нарочно
    text: BAIT, password: BAIT, snapshot: BAIT,
  } as any)!;
  ok('объявленные поля сохраняются', data.section === 'sheet' && data.characters === 1200, data);
  ok('необъявленные поля выброшены', !JSON.stringify(data).includes(BAIT), data);
  ok('миллисекунды округляются до сотых', data.stringifyMs === 4.57, data);

  // «Знаки» и «байты» — разные виды, и подписать одно другим нельзя:
  // в словаре у office.snapshot нет поля bytes вообще
  ok('длину текста нельзя записать как размер',
    cleanFields('office.snapshot', { bytes: 1200 } as any)!.bytes === undefined);

  ok('общие поля разрешены каждому событию',
    cleanFields('office.snapshot', { trace: newTraceId(), outcome: 'ok' } as any)!.outcome === 'ok');
  ok('чужое значение перечисления отброшено',
    cleanFields('office.snapshot', { outcome: 'всё пропало' } as any)!.outcome === undefined);
  ok('не число в числовом поле отброшено',
    cleanFields('office.snapshot', { characters: 'много' } as any)!.characters === undefined);
}

console.log('\n5. Словарь описан целиком');
{
  const KINDS: FieldKind[] = ['id', 'name', 'route', 'frame', 'code', 'ms', 'bytes', 'chars', 'count', 'flag', 'phase', 'outcome'];
  const strange: string[] = [];
  for (const name of EVENT_NAMES) {
    const spec = specOf(name);
    if (!spec) { strange.push(`${name}: нет описания`); continue; }
    for (const [field, kind] of Object.entries(spec)) {
      if (!KINDS.includes(kind)) strange.push(`${name}.${field} → ${kind}`);
    }
  }
  ok(`у каждого события объявлены поля (${EVENT_NAMES.length} событий)`, strange.length === 0, strange);

  // Вида «свободный текст» в списке нет намеренно: пока его нет, записать
  // сообщение целиком технически нечем
  ok('среди видов нет свободного текста', !KINDS.includes('text' as FieldKind));

  const commonClash = EVENT_NAMES.filter((n) => Object.keys(EVENTS[n]).some((k) => k in COMMON));
  ok('поля события не перекрывают общие', commonClash.length === 0, commonClash);

  ok('имя события короткое и без пробелов',
    EVENT_NAMES.every((n) => /^[a-z][a-z0-9.-]{2,39}$/.test(n)),
    EVENT_NAMES.filter((n) => !/^[a-z][a-z0-9.-]{2,39}$/.test(n)));
}

console.log('\n6. Идентификаторы');
{
  ok('трасса имеет вид UUID', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(newTraceId()));
  const many = new Set(Array.from({ length: 500 }, () => newTraceId()));
  ok('трассы не повторяются', many.size === 500);
  ok('чужой идентификатор чистится', safeName('../../etc/passwd') === '....etcpasswd', safeName('../../etc/passwd'));
}

console.log(f === 0 ? '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ' : `\nПРОВАЛОВ: ${f}`);
process.exit(f === 0 ? 0 : 1);
