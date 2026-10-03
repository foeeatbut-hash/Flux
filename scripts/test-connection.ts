/** Разбор URI общей MariaDB/MySQL перед вызовом Electron IPC. */
import { readDatabaseConnection } from '../src/lib/connection';

let passed = 0, failed = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (pass) passed++; else { failed++; console.log(`✗ ${name}\n   получено: ${JSON.stringify(got)}\n   ожидалось: ${JSON.stringify(want)}`); }
};

eq('корректный URI MariaDB принимается', readDatabaseConnection('mysql://user:synthetic@db.example.test:3306/Flux'), {
  kind: 'database', uri: 'mysql://user:synthetic@db.example.test:3306/Flux',
});
eq('схема mariadb принимается', readDatabaseConnection('mariadb://user:synthetic@db.example.test:3306/Flux').kind, 'database');
eq('postgresql не принимается для общей базы Flux', readDatabaseConnection('postgresql://user:synthetic@db.example.test:5432/Flux').kind, 'error');
eq('пустое значение просит ввести URI', readDatabaseConnection('  ').kind, 'error');
eq('URI без имени пользователя отклоняется', readDatabaseConnection('mysql://db.example.test:3306/Flux').kind, 'error');
eq('URI без имени базы отклоняется', readDatabaseConnection('mysql://u:p@db.example.test:3306/').kind, 'error');
eq('URI без пароля отклоняется', readDatabaseConnection('mysql://u:@db.example.test:3306/Flux').kind, 'error');
eq('локальный файл SQLite не принимается', readDatabaseConnection('sqlite:///tmp/database.sqlite').kind, 'error');
eq('порт вне диапазона отклоняется', readDatabaseConnection('mysql://u:p@db.example.test:70000/Flux').kind, 'error');
eq('неверное percent encoding отклоняется', readDatabaseConnection('mysql://u:p%XZ@db.example.test:3306/Flux').kind, 'error');

console.log(`\n${passed} проверок пройдено, ${failed} провалено`);
process.exit(failed ? 1 : 0);
