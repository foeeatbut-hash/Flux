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

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  cleanFields, newTraceId, redact, routeName, safeError, safeFrames, safeName,
} from '../diagnostics/event';
import { COMMON, EVENTS, EVENT_NAMES, specOf, type FieldKind } from '../diagnostics/contracts';
import { BoundedQueue, RateLimit, RepeatFilter, isFailure, passesMode } from '../diagnostics/policy';
import { FileWriter } from '../diagnostics/node/writer';

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

  // Кадр можно подать и полем напрямую — тогда чистит cleanFields, и чистить
  // он обязан так же. Раньше вид frame только обезличивал строку, а путь
  // установки и номер строки в ней оставались
  const direct = cleanFields('renderer.error', {
    error: 'TypeError',
    frame1: `    at saveNow (/home/${BAIT}/flux/src/screens/Doc.tsx:412:19)`,
  })!;
  ok('кадр, поданный полем, чистится так же', !JSON.stringify(direct).includes(BAIT), direct);
  ok('в поданном кадре нет номера строки', !/\d+:\d+/.test(String(direct.frame1)), direct);
  ok('в поданном кадре осталось имя функции', String(direct.frame1).includes('saveNow'), direct);
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

  // Тот же дефект с другой стороны: вид поля повторно прогонял готовый шаблон
  // через словарь, и `/api/users/:id/signature` схлопывался в `:id/:id` —
  // подпись становилась неотличима от прав
  ok('шаблон маршрута не проходит через словарь',
    cleanFields('http.end', { route: '/api/users/:id/signature' })!.route === '/api/users/:id/signature',
    cleanFields('http.end', { route: '/api/users/:id/signature' }));
  ok('а адрес от человека — проходит',
    cleanFields('fetch.headers', { route: `/api/users/${BAIT}/signature` })!.route === '/api/users/:id/:id',
    cleanFields('fetch.headers', { route: `/api/users/${BAIT}/signature` }));

  ok('общие поля разрешены каждому событию',
    cleanFields('office.snapshot', { trace: newTraceId(), outcome: 'ok' } as any)!.outcome === 'ok');
  ok('чужое значение перечисления отброшено',
    cleanFields('office.snapshot', { outcome: 'всё пропало' } as any)!.outcome === undefined);
  ok('не число в числовом поле отброшено',
    cleanFields('office.snapshot', { characters: 'много' } as any)!.characters === undefined);
}

console.log('\n5. Словарь описан целиком');
{
  const KINDS: FieldKind[] = ['id', 'name', 'route', 'pattern', 'frame', 'code', 'ms', 'bytes', 'chars', 'count', 'flag', 'phase', 'outcome'];
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

  // Вид «шаблон» доверяет тому, что ему передали: он чистит только знаки. Это
  // допустимо ровно потому, что значение берётся у самого Express, то есть из
  // нашего исходного кода. Список таких событий держим коротким и под
  // присмотром — расширять его без разбора нельзя
  const trusting = EVENT_NAMES.filter((n) => Object.values(EVENTS[n]).includes('pattern' as never));
  ok('шаблону доверяют только серверные события запроса',
    trusting.join(',') === 'http.start,http.end', trusting);

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

console.log('\n7. Что пишется в обычном режиме, а что только в подробном');
{
  ok('начало участка в обычном режиме не пишется',
    passesMode('http.start', { phase: 'start' }, false) === false);
  ok('в подробном — пишется',
    passesMode('http.start', { phase: 'start' }, true) === true);
  ok('завершение запроса пишется всегда',
    passesMode('http.end', { status: '200' }, false) === true);
  ok('событие сокета — только в подробном',
    passesMode('socket.receive', {}, false) === false);
  // Иначе получилось бы, что в обычном режиме теряется ровно то, ради чего
  // запись и ведётся
  ok('поломка пишется и в обычном режиме',
    passesMode('socket.receive', { outcome: 'error' }, false) === true);
  ok('ответ 500 считается поломкой', isFailure('http.end', { status: '500' }) === true);
  ok('отменённый запрос поломкой не считается', isFailure('http.end', { outcome: 'cancelled' }) === false);
}

console.log('\n8. Повторы сворачиваются, поломки — нет');
{
  const filter = new RepeatFilter(5000);
  const poll = { route: '/api/notifications', status: '200', durationMs: 10 };
  // Сворачивается только фоновый опрос. На живом прогоне свёртка «по маршруту»
  // схлопывала обычную работу человека: от шестидесяти запросов в файле
  // оставалось пять, а записи об операциях базы теряли свою цепочку
  const work = { route: '/api/projects/:id/tags', status: '200', durationMs: 10 };
  ok('обычная работа не сворачивается', filter.accept('http.end', work, 0) === true);
  ok('и повтор обычной работы тоже пишется', filter.accept('http.end', work, 10) === true);
  ok('первый запрос в окне пишется целиком', filter.accept('http.end', poll, 1000) === true);
  ok('второй уходит в свёртку', filter.accept('http.end', poll, 1100) === false);
  ok('третий тоже', filter.accept('http.end', { ...poll, durationMs: 30 }, 1200) === false);
  ok('окно ещё не закрылось — свёртки нет', filter.drain(2000).length === 0);
  const [agg] = filter.drain(9000);
  ok('свёртка выдана после окна', !!agg, agg);
  ok('свёртка знает число повторов', agg?.data.repeats === 2, agg?.data);
  ok('свёртка знает худший случай', agg?.data.maxMs === 30, agg?.data);
  ok('имя свёрнутого события сохранено', agg?.data.name === 'http.end', agg?.data);

  const errors = new RepeatFilter(5000);
  const bad = { route: '/api/tags', status: '500' };
  ok('первая поломка пишется', errors.accept('http.end', bad, 0) === true);
  ok('вторая поломка тоже пишется', errors.accept('http.end', bad, 10) === true);
}

console.log('\n9. Очередь и предел частоты');
{
  const q = new BoundedQueue(3, 1000);
  for (const n of ['a', 'b', 'c', 'd']) q.push(n + '\n', 2);
  ok('очередь держит объявленное число записей', q.length === 3, q.length);
  ok('вытесненное посчитано потерянным', q.dropped === 1, q.dropped);
  ok('вытесняется самое старое', q.take().batch === 'b\nc\nd\n');

  const byBytes = new BoundedQueue(100, 10);
  byBytes.push('x', 6);
  byBytes.push('y', 6);
  ok('потолок по объёму тоже работает', byBytes.length === 1 && byBytes.dropped === 1);

  const rate = new RateLimit(2);
  ok('в пределах — пропускает', rate.allow(0) && rate.allow(1));
  ok('сверх предела — нет', rate.allow(2) === false);
  ok('в следующую секунду снова пропускает', rate.allow(1100) === true);
}

async function files() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-diag-'));
  try {
    console.log('\n10. Файлы: ротация по строке, а не по пачке');
    {
      // Порог 400 байт при строке около 150: если проверять перед пачкой, а не
      // перед строкой, один сброс переваливает порог целиком и файл выходит
      // вдвое больше объявленного
      const dir = path.join(root, 'rotate');
      const w = new FileWriter(dir, 'test', 400, 10 * 1024 * 1024, 10000);
      for (let n = 0; n < 24; n++) w.record('ui.stall', { durationMs: n });
      await w.close();
      const names = (await fs.readdir(dir)).sort();
      ok(`пачка разложена по нескольким файлам (${names.length})`, names.length > 2, names);
      const sizes = await Promise.all(names.map(async (n) => (await fs.stat(path.join(dir, n))).size));
      // Одна строка сверх порога допустима: она пишется целиком, не разрезаясь
      const worst = Math.max(...sizes);
      ok(`ни один файл не вырос вдвое против порога (худший ${worst})`, worst <= 400 + 200, sizes);
      const lines = (await Promise.all(names.map((n) => fs.readFile(path.join(dir, n), 'utf8')))).join('');
      ok('ни одна запись не потеряна при ротации',
        lines.trim().split('\n').length === 24, lines.trim().split('\n').length);
      ok('каждая строка — целый JSON',
        lines.trim().split('\n').every((l) => { try { JSON.parse(l); return true; } catch { return false; } }));
    }

    console.log('\n11. Уборка: срок, объём и чужие файлы');
    {
      const dir = path.join(root, 'sweep');
      await fs.mkdir(dir, { recursive: true });
      // Чужой файл в папке: удалять его мы права не имеем
      const stranger = path.join(dir, 'важное.txt');
      await fs.writeFile(stranger, 'не трогать');
      const w = new FileWriter(dir, 'test', 300, 900, 10000);
      for (let n = 0; n < 40; n++) w.record('ui.stall', { durationMs: n });
      await w.close();
      const names = await fs.readdir(dir);
      const mine = names.filter((n) => n.endsWith('.jsonl'));
      const total = (await Promise.all(mine.map(async (n) => (await fs.stat(path.join(dir, n))).size)))
        .reduce((a, b) => a + b, 0);
      ok(`общий объём держится в пределах (${total} байт при 900)`, total <= 900 + 300, total);
      ok('чужой файл не удалён', names.includes('важное.txt'), names);
    }

    console.log('\n12. Отказ диска не роняет программу');
    {
      // Вместо папки — файл: mkdir и запись обязаны провалиться
      const blocked = path.join(root, 'не-папка');
      await fs.writeFile(blocked, 'x');
      const w = new FileWriter(blocked, 'test');
      w.record('ui.stall', { durationMs: 1 });
      await w.close();
      const st = w.status();
      ok('отказ записи посчитан', st.failures >= 1, st);
      ok('несохранённое посчитано потерянным', st.dropped >= 1, st);
      ok('очередь после отказа пуста, память не течёт', st.queued === 0, st);
    }

    console.log('\n13. Поломке всегда есть место');
    {
      const dir = path.join(root, 'reserve');
      const w = new FileWriter(dir, 'test', 10 * 1024 * 1024, 10 * 1024 * 1024, 100000);
      // Шторм должен быть настоящим: очередь обычных событий держит 20 000, и
      // пока её не переполнить, вытеснять нечего — проверка проходила бы, ничего
      // не проверяя. Цикл синхронный, сброс по таймеру в него не вклинится
      for (let n = 0; n < 25000; n++) w.record('ui.stall', { durationMs: n });
      w.record('renderer.error', { error: 'TypeError' });
      for (let n = 0; n < 25000; n++) w.record('ui.stall', { durationMs: n });
      await w.close();
      const text = (await Promise.all(
        (await fs.readdir(dir)).map((n) => fs.readFile(path.join(dir, n), 'utf8')),
      )).join('');
      ok('ошибка доехала до файла', text.includes('renderer.error'));
      const first = text.trim().split('\n').findIndex((l) => l.includes('renderer.error'));
      ok('ошибка записана раньше успешных событий своей пачки', first === 0, first);
      const st = w.status();
      ok('вытесненные успешные события объявлены потерянными', st.dropped > 0, st.dropped);
      ok('потеряны именно успешные, а не поломка',
        text.split('renderer.error').length - 1 === 1, text.split('renderer.error').length - 1);
    }

    console.log('\n14. Незнакомое событие не попадает в файл');
    {
      const dir = path.join(root, 'unknown');
      const w = new FileWriter(dir, 'test');
      (w as any).record('office.секретное', { text: BAIT });
      w.record('ui.stall', { durationMs: 1 });
      await w.close();
      const text = (await Promise.all(
        (await fs.readdir(dir)).map((n) => fs.readFile(path.join(dir, n), 'utf8')),
      )).join('');
      ok('незнакомого события в файле нет', !text.includes('секретное'), text.slice(0, 200));
      ok('приманки в файле нет', !text.includes(BAIT));
      ok('знакомое событие записалось', text.includes('ui.stall'));
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

void files()
  .catch((error) => { f++; console.error('  ✗ проверка файлов упала', error); })
  .finally(() => {
    console.log(f === 0 ? '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ' : `\nПРОВАЛОВ: ${f}`);
    process.exit(f === 0 ? 0 : 1);
  });
