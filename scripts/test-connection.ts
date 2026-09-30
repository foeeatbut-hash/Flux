/**
 * Одно поле подключения на экране входа: база или сервер — по самой строке.
 */
import { readConnection } from '../src/lib/connection';
import { parseDbUrl } from '../src/lib/dbUrl';

let ok = 0, fail = 0;
const eq = (name: string, got: any, want: any) => {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (pass) ok++; else { fail++; console.log(`✗ ${name}\n   получено: ${JSON.stringify(got)}\n   ожидалось: ${JSON.stringify(want)}`); }
};

const a = readConnection('mysql://Flux:pa$$@w0rd]x@192.168.120.14:3306/Flux');
eq('mysql-строка распознаётся как база', a.kind, 'database');
if (a.kind === 'database') {
  eq('MariaDB/MySQL', a.parts.engine, 'MARIADB');
  eq('хост — после последнего @', a.parts.host, '192.168.120.14');
  eq('пароль со спецзнаками целиком', a.parts.password, 'pa$$@w0rd]x');
  eq('собранная строка разбирается обратно в тот же пароль', parseDbUrl(a.url).password, 'pa$$@w0rd]x');
  eq('и в тот же хост', parseDbUrl(a.url).host, '192.168.120.14');
  eq('база', a.parts.database, 'Flux');
}

const p = readConnection('postgresql://user:p%40ss@db.local/flux?schema=public');
eq('postgresql распознаётся', p.kind, 'database');
if (p.kind === 'database') {
  eq('PostgreSQL', p.parts.engine, 'POSTGRES');
  eq('порт по умолчанию 5432', p.parts.port, '5432');
  eq('уже закодированный пароль не кодируется дважды', p.parts.password, 'p@ss');
}

eq('адрес сервера с http распознаётся', readConnection('http://192.168.1.100:3000'), { kind: 'server', url: 'http://192.168.1.100:3000' });
eq('адрес без схемы дополняется', readConnection('192.168.1.100:3000'), { kind: 'server', url: 'http://192.168.1.100:3000' });
eq('пустое поле — подсказка, а не молчание', readConnection('  ').kind, 'error');
eq('строка базы без имени пользователя — объяснение', readConnection('mysql://192.168.1.10:3306/Flux').kind, 'error');
eq('строка базы без названия базы — объяснение', readConnection('mysql://u:p@192.168.1.10:3306/').kind, 'error');
eq('файл sqlite не выдаётся за сервер', readConnection('sqlite:///C:/db.sqlite').kind, 'error');
eq('адрес сервера с паролем не принимается', readConnection('http://u:p@srv:3000').kind, 'error');

console.log(`\n${ok} проверок пройдено, ${fail} провалено`);
process.exit(fail ? 1 : 0);
