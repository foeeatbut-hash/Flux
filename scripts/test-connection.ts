/**
 * Одно поле подключения на экране входа: база или сервер — по самой строке.
 */
import { readConnection } from '../src/lib/connection';

let ok = 0, fail = 0;
const eq = (name: string, got: any, want: any) => {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (pass) ok++; else { fail++; console.log(`✗ ${name}\n   получено: ${JSON.stringify(got)}\n   ожидалось: ${JSON.stringify(want)}`); }
};

eq('mysql-строка остается только на сервере', readConnection('mysql://user:synthetic@192.168.120.14:3306/Flux').kind, 'error');
eq('postgresql-строка не используется клиентом', readConnection('postgresql://user:synthetic@db.local/flux').kind, 'error');
eq('HTTP компании требует защищенный канал', readConnection('http://192.168.1.100:3000').kind, 'error');
eq('адрес компании без схемы получает HTTPS', readConnection('192.168.1.100:3000'), { kind: 'server', url: 'https://192.168.1.100:3000' });
eq('встроенный сервер принимает HTTP', readConnection('http://localhost:3000'), { kind: 'server', url: 'http://localhost:3000' });
eq('localhost без схемы получает HTTP', readConnection('localhost:3000'), { kind: 'server', url: 'http://localhost:3000' });
eq('пустое поле — подсказка, а не молчание', readConnection('  ').kind, 'error');
eq('строка базы без имени пользователя — объяснение', readConnection('mysql://192.168.1.10:3306/Flux').kind, 'error');
eq('строка базы без названия базы — объяснение', readConnection('mysql://u:p@192.168.1.10:3306/').kind, 'error');
eq('файл sqlite не выдаётся за сервер', readConnection('sqlite:///C:/db.sqlite').kind, 'error');
eq('адрес сервера с паролем не принимается', readConnection('http://u:p@srv:3000').kind, 'error');

console.log(`\n${ok} проверок пройдено, ${fail} провалено`);
process.exit(fail ? 1 : 0);
