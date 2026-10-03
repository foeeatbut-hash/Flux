/**
 * Проверки строки подключения к базе.
 *
 * Синтетический fixture проверяет пароль со знаками `$`, `!`, `@`, `+` и `=`.
 * Без экранирования часть таких знаков может изменить разбор адреса базы.
 *
 * Запуск: npx tsx scripts/test-db-url.ts
 */
import {
  buildDbUrl, parseDbUrl, missing, dbLabel, labelOfUrl, emptyParts, DEFAULT_PORT, type DbParts,
} from '../src/lib/dbUrl';

let failed = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  if (cond) return;
  failed++;
  console.error(`  ✗ ${name}${got === undefined ? '' : ` — получили ${JSON.stringify(got)}`}`);
};

const maria: DbParts = {
  engine: 'MARIADB', host: 'db.example.test', port: '3306',
  database: 'flux_test', user: 'fixture_user', password: 'fixture!@+:=$test',
};

console.log('Сборка строки подключения');
{
  const url = buildDbUrl(maria);
  check('схема mysql у MariaDB', url.startsWith('mysql://'), url);
  check('PostgreSQL получает свою схему',
    buildDbUrl({ ...maria, engine: 'POSTGRES', port: '5432' }).startsWith('postgresql://'));
  check('на этом компьютере строки нет', buildDbUrl(emptyParts('LOCAL')) === '');

  // Главное: собранная строка обязана разбираться обратно ровно в то же
  const back = parseDbUrl(url);
  check('сервер разобрался обратно', back.host === maria.host, back.host);
  check('порт разобрался обратно', back.port === maria.port, back.port);
  check('база разобралась обратно', back.database === maria.database, back.database);
  check('имя разобралось обратно', back.user === maria.user, back.user);
  check('пароль со спецзнаками цел', back.password === maria.password, back.password);
  check('движок узнан', back.engine === 'MARIADB', back.engine);
}

console.log('Пароль со знаками, которые ломают адрес');
{
  const nasty = { ...maria, password: 'a@b:c/d?e#f&g' };
  const url = buildDbUrl(nasty);
  check('решётка и вопрос не рвут адрес', parseDbUrl(url).password === nasty.password, parseDbUrl(url).password);
  check('сервер не подменился куском пароля', parseDbUrl(url).host === 'db.example.test', parseDbUrl(url).host);

  const spaced = { ...maria, user: 'учётка отдела', password: 'про бел' };
  check('пробелы в имени и пароле переживают сборку',
    parseDbUrl(buildDbUrl(spaced)).user === 'учётка отдела'
    && parseDbUrl(buildDbUrl(spaced)).password === 'про бел');
}

console.log('Чего не хватает');
{
  check('всё на месте — молчим', missing(maria) === '', missing(maria));
  check('без сервера не подключиться', missing({ ...maria, host: '' }).includes('сервер'));
  check('без базы не подключиться', missing({ ...maria, database: '' }).includes('базы'));
  check('без имени не подключиться', missing({ ...maria, user: '' }).includes('имя'));
  check('порт буквами не проходит', missing({ ...maria, port: 'триста' }).includes('число'));
  check('на этом компьютере ничего не требуется', missing(emptyParts('LOCAL')) === '');
  check('порт по умолчанию подставлен', emptyParts('MARIADB').port === DEFAULT_PORT.MARIADB);
}

console.log('Строка на экране входа');
{
  const label = dbLabel(maria);
  check('назван движок', label.includes('MariaDB'), label);
  check('назван сервер и порт', label.includes('db.example.test:3306'), label);
  check('названа база', label.includes('flux_test'), label);
  check('ПАРОЛЯ В СТРОКЕ НЕТ', !label.includes(maria.password), label);
  check('имени пользователя в строке нет', !label.includes('fixture_user:'), label);
  check('локальная база названа просто', dbLabel(emptyParts('LOCAL')) === 'База: на этом компьютере');
  check('строка собирается и по настройке сервера',
    labelOfUrl('REMOTE', buildDbUrl(maria)).includes('db.example.test'),
    labelOfUrl('REMOTE', buildDbUrl(maria)));
  check('локальный тип не показывает чужой адрес',
    labelOfUrl('LOCAL', buildDbUrl(maria)) === 'База: на этом компьютере');
}

console.log('Разбор чужой и битой строки');
{
  check('битая строка не роняет разбор', parseDbUrl('не адрес').engine === 'POSTGRES');
  check('пустая строка — это локальная база', parseDbUrl('').engine === 'LOCAL');
  const old = parseDbUrl('postgresql://fixture_user@db.example.test/flux_test');
  check('строка без пароля разбирается', old.user === 'fixture_user' && old.password === '' && old.host === 'db.example.test');
  check('порт по умолчанию подставляется при разборе', old.port === '5432', old.port);
}

if (failed) {
  console.error(`\nПровалено проверок: ${failed}`);
  process.exit(1);
}
console.log('\nВсе проверки строки подключения пройдены');
