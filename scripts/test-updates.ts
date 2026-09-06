/**
 * Проверки обновления программы.
 *
 * Обновление — единственное действие, которое заменяет саму программу, и
 * ошибка здесь стоит дороже любой другой: человек остаётся без работающего
 * exe и без объяснения. Проверить это на живой машине нельзя — сборка и
 * подмена происходят на Windows у сотрудника, — поэтому всё, что можно
 * выразить правилом, проверяется здесь.
 *
 * Запуск: npx tsx scripts/test-updates.ts
 */
// Правила разложены по сторонам: окно сравнивает версии и подписывает кнопку,
// главный процесс качает файл и объясняет отказ. Проверяются вместе — сбой
// обновления одинаково плох с любой стороны границы
import { isNewer, fileUrlOf, blocker, phaseLabel, versionFromFileName, versionProblem } from '../src/lib/updates';
import {
  sameServer, installerName, badPackage, downloadError, MIN_EXE_BYTES,
  applyArgs, parseApplyArgs, retryCopy, APPLY_FLAG, WAIT_FLAG, COPY_TRIES,
} from '../electron/updates';
// Со стороны сервера — выбор релиза: предлагать можно только то, что реально
// можно скачать
import { pickRelease, chunkSizeFor, CHUNK_MAX, CHUNK_MIN } from '../server/updates';

let failed = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  if (cond) return;
  failed++;
  console.error(`  ✗ ${name}${got === undefined ? '' : ` — получили ${JSON.stringify(got)}`}`);
};

console.log('Сравнение версий');
{
  check('0.85 новее 0.84', isNewer('0.85.0', '0.84.0'));
  check('та же версия не новее', !isNewer('0.84.0', '0.84.0'));
  check('старая не новее', !isNewer('0.83.0', '0.84.0'));
  check('десятая доля не путается с сотой', isNewer('0.10.0', '0.9.0'));
  check('короткая запись сравнивается с длинной', isNewer('1.0', '0.99.99'));
  check('суффикс не ломает сравнение', isNewer('0.85.0-beta', '0.84.0'));
  check('мусор вместо версии не выдаётся за новую', !isNewer('', '0.84.0'));
}

console.log('Адрес файла');
{
  check('относительный путь достраивается сервером',
    fileUrlOf('/api/updates/download/0.85.0', 'http://localhost:3000')
      === 'http://localhost:3000/api/updates/download/0.85.0');
  check('лишняя косая черта не удваивается',
    fileUrlOf('/x', 'http://srv:3000/') === 'http://srv:3000/x');
  check('путь без косой черты тоже достраивается',
    fileUrlOf('x.exe', 'http://srv') === 'http://srv/x.exe');
  check('полный адрес остаётся как есть',
    fileUrlOf('https://github.com/x/Flux.exe', 'http://srv') === 'https://github.com/x/Flux.exe');
  check('пустой адрес остаётся пустым', fileUrlOf('', 'http://srv') === '');
}

console.log('Токен уходит только своему серверу');
{
  const base = 'http://192.168.1.10:3000';
  check('свой сервер узнаётся', sameServer(`${base}/api/updates/download/1`, base));
  check('чужой хост — не свой', !sameServer('https://github.com/x.exe', base));
  check('другой порт — не свой', !sameServer('http://192.168.1.10:4000/x', base));
  check('другая схема — не свой', !sameServer('https://192.168.1.10:3000/x', base));
  check('битый адрес не считается своим', !sameServer('не адрес', base));
}

console.log('Имя скачанного файла');
{
  check('в имени стоит версия', installerName('0.85.0') === 'Flux-0.85.0.exe');
  check('посторонние знаки в имя не попадают',
    !installerName('0.85.0/../../etc').includes('/'), installerName('0.85.0/../../etc'));
}

console.log('Проверка скачанного');
{
  const mz = [0x4d, 0x5a, 0x90, 0x00];
  check('настоящий exe проходит', badPackage(mz, MIN_EXE_BYTES + 1) === '');
  check('страница с ошибкой вместо exe не проходит',
    badPackage([0x3c, 0x21], MIN_EXE_BYTES + 1).includes('не файл программы'));
  check('оборванная загрузка не проходит',
    badPackage(mz, 1024).includes('оборвалась'), badPackage(mz, 1024));
  check('пустой файл не проходит', badPackage([], 0) !== '');
  check('отсутствие данных не роняет проверку', badPackage(null, 0) !== '');
}

console.log('Отказ сервера словами');
{
  check('401 говорит про вход', downloadError(401).includes('вход'));
  check('403 говорит про вход', downloadError(403).includes('вход'));
  check('404 говорит, что делать администратору', downloadError(404).includes('загрузить exe'));
  check('404 называет сервер, у которого спрашивали',
    downloadError(404, '', 'http://192.168.1.10:3000').includes('192.168.1.10:3000'),
    downloadError(404, '', 'http://192.168.1.10:3000'));
  check('404 подсказывает про «тот же сервер»', downloadError(404).includes('тот же сервер'));
  check('500 передаёт слова сервера', downloadError(500, 'диск переполнен').includes('диск переполнен'));
  check('неизвестный код не оставляет человека без объяснения', downloadError(418).includes('418'));
}

console.log('Что мешает обновиться');
{
  const okCase = { electron: true, packaged: true, portable: true, fileUrl: '/api/updates/download/1' };
  check('когда всё на месте — ничего не мешает', blocker(okCase) === '', blocker(okCase));
  check('в браузере обновление не ставится',
    blocker({ ...okCase, electron: false }).includes('браузере'));
  check('в разработке обновление не ставится',
    blocker({ ...okCase, packaged: false }).includes('разработки'));
  check('без файла сказано, что делать администратору',
    blocker({ ...okCase, fileUrl: '' }).toLowerCase().includes('администратору'));
  check('непортативная сборка предупреждает про установщик',
    blocker({ ...okCase, portable: false }).includes('установщик'));
}

// Проверка написана по поломке: в поле версии оказалось «90» вместо «0.90.0»,
// запись о релизе разошлась всем, а файла с таким номером на сервере не было —
// и обновиться не смог никто
console.log('Номер версии при публикации');
{
  check('номер берётся из имени собранного файла',
    versionFromFileName('Flux-0.90.0-x64.exe') === '0.90.0', versionFromFileName('Flux-0.90.0-x64.exe'));
  check('предвыпуск тоже разбирается',
    versionFromFileName('Flux-1.2.3-beta.2-x64.exe') === '1.2.3-beta.2', versionFromFileName('Flux-1.2.3-beta.2-x64.exe'));
  check('из имени без номера ничего не выдумывается', versionFromFileName('setup.exe') === '');

  check('«90» — не версия, и об этом сказано словами',
    versionProblem('90').includes('0.90.0'), versionProblem('90'));
  check('пустое поле названо пустым', versionProblem('').includes('Укажите'));
  check('правильный номер претензий не вызывает', versionProblem('0.90.0') === '', versionProblem('0.90.0'));
  check('предвыпуск проходит', versionProblem('1.2.3-beta.2') === '', versionProblem('1.2.3-beta.2'));
  check('версия не новее запущенной — предупреждение, а не тишина',
    versionProblem('0.80.0', '0.90.0').includes('не новее'), versionProblem('0.80.0', '0.90.0'));
  check('новее запущенной — всё в порядке', versionProblem('0.91.0', '0.90.0') === '');
}

// Проверка написана по той же поломке, но со стороны сервера: запись о релизе
// живёт в общей базе, а файл к ней мог не доехать. Пока сервер предлагал просто
// последнюю по дате запись, одна неудачная публикация закрывала обновления
// всему отделу
console.log('Сервер предлагает только то, что можно скачать');
{
  const has = (v: string[]) => (r: { version: string }) =>
    (v.includes(r.version) ? { ok: true, why: '' } : { ok: false, why: 'файла нет' });
  const list = [{ version: '0.92.0' }, { version: '0.91.0' }, { version: '0.90.0' }];

  const good = pickRelease(list, has(['0.92.0', '0.90.0']));
  check('целый релиз предлагается сразу', good.release?.version === '0.92.0', good.release);
  check('и жалоб на него нет', good.broken.length === 0, good.broken);

  const skipped = pickRelease(list, has(['0.90.0']));
  check('пустая публикация пропускается ради рабочей', skipped.release?.version === '0.90.0', skipped.release);
  check('но о ней сказано, а не умолчано', skipped.broken.length === 2, skipped.broken);
  check('названы и версия, и причина',
    skipped.broken[0].version === '0.92.0' && skipped.broken[0].why.length > 0, skipped.broken[0]);

  const none = pickRelease(list, has([]));
  check('когда качать нечего — обновления нет', none.release === null);
  check('и все пустые публикации перечислены', none.broken.length === 3, none.broken);
  check('пустой список никого не смущает', pickRelease([], has([])).release === null);
}

// Проверка написана по последней поломке: два мегабайта проходили во всех
// проверках, а у живого сервера отдела предел размера пакета оказался меньше.
// MariaDB на такой пакет не отвечает ошибкой — она разрывает соединение, и
// программа видит только «connection closed»
console.log('Кусок файла подгоняется под предел пакета у базы');
{
  check('предел неизвестен — берём проверенные два мегабайта', chunkSizeFor(0) === CHUNK_MAX, chunkSizeFor(0));
  check('просторная база: больше двух мегабайт не берём',
    chunkSizeFor(64 * 1024 * 1024) === CHUNK_MAX, chunkSizeFor(64 * 1024 * 1024));

  // Обычная тесная настройка MariaDB: предел в один мегабайт
  const tight = chunkSizeFor(1024 * 1024);
  check('при пределе в мегабайт кусок меньше половины предела', tight <= 512 * 1024, tight);
  check('и не опускается ниже разумного', tight >= CHUNK_MIN, tight);

  check('совсем крошечный предел не даёт нулевого куска',
    chunkSizeFor(16 * 1024) === CHUNK_MIN, chunkSizeFor(16 * 1024));
  check('кусок никогда не бывает отрицательным', chunkSizeFor(1) > 0, chunkSizeFor(1));
  // Смысл всей затеи: кусок должен помещаться в пакет вместе с запросом
  for (const limit of [1, 16 * 1024, 512 * 1024, 1024 * 1024, 4 * 1024 * 1024]) {
    check(`кусок укладывается в предел ${limit} Б`,
      chunkSizeFor(limit) <= Math.max(limit, CHUNK_MIN), { limit, кусок: chunkSizeFor(limit) });
  }
}

console.log('Ход дела одной строкой');
{
  check('этап скачивания показывает проценты', phaseLabel('downloading', 42).includes('42'));
  check('этап проверки назван', phaseLabel('verifying').includes('Проверяю'));
  check('этап установки объясняет закрытие', phaseLabel('installing').includes('Закрываюсь'));
  check('в покое строки нет', phaseLabel('idle') === '');
}

console.log('Подмена программы: доводы, ожидание и повторы');
{
  // Доводы собирает одна функция, а разбирает другая; разойдись они — человек
  // получил бы вместо обновления вторую копию программы, запущенную впустую
  const args = applyArgs('C:\\Users\\Иванов\\Рабочий стол\\Flux.exe', 4242);
  const plan = parseApplyArgs(['C:/tmp/Flux-1.0.0.exe', ...args]);
  check('разбор понимает собранное', !!plan);
  check('путь дошёл целиком', plan?.target === 'C:\\Users\\Иванов\\Рабочий стол\\Flux.exe', plan?.target);
  check('чей уход ждать — дошло', plan?.waitPid === 4242, plan?.waitPid);

  // Путь с пробелами — обычное дело: «Рабочий стол» есть у каждого. Склейка
  // через знак равенства разошлась бы с разбором на первом же пробеле
  check('путь передаётся отдельным доводом, а не через =',
    args[0] === APPLY_FLAG && args[1].includes(' ') && !args[0].includes('='), args.slice(0, 2));
  check('довод ожидания на своём месте', args[2] === WAIT_FLAG);

  check('обычный запуск подменой не считается', parseApplyArgs(['Flux.exe', '--minimized']) === null);
  check('пустой список не роняет разбор', parseApplyArgs([]) === null);
  check('довод без пути ничего не подменяет',
    parseApplyArgs([APPLY_FLAG, WAIT_FLAG, '12']) === null);
  check('без pid подмена всё равно возможна',
    parseApplyArgs([APPLY_FLAG, 'C:/Flux.exe'])?.waitPid === 0);

  // Занятый файл лечится временем, «нет такого пути» — нет. Двенадцать попыток
  // сказать одно и то же — только тянуть время у человека
  check('занятый файл — пробуем ещё', retryCopy('EBUSY', 1));
  check('отказ в доступе — тоже (программа ещё уходит)', retryCopy('EPERM', 3));
  check('нет такого пути — не пробуем', !retryCopy('ENOENT', 1));
  check('без кода ошибки не пробуем', !retryCopy(undefined, 1));
  check('после потолка попыток не пробуем', !retryCopy('EBUSY', COPY_TRIES));
}

if (failed) {
  console.error(`\nПровалено проверок: ${failed}`);
  process.exit(1);
}
console.log('\nВсе проверки обновления пройдены');
