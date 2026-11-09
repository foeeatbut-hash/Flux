/**
 * Поиск почтового сервера по адресу.
 *
 * Проверка написана по жалобе: «почта не подключается, пишет неправильный
 * адрес». Адрес человек писал верно — свой. Неправильным был адрес СЕРВЕРА:
 * подсказка по домену угадывает «imap.<домен>», а у почты предприятия сервер
 * почти всегда называется иначе. Отказ при этом звучал так, будто человек
 * ошибся сам.
 *
 * Здесь проверяется перебор кандидатов: порядок (каждая неудачная попытка
 * стоит человеку секунд ожидания), полнота (незашифрованный порт нужен, но
 * последним) и то, что мусор не превращается в список имён.
 *
 * Запуск: npx tsx scripts/test-mail-discover.ts
 */
import { imapCandidates, smtpCandidates, domainOf, isForbiddenProbeAddress, probe } from '../server/mail/discover';

let failed = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  if (cond) return;
  failed++;
  console.error(`  ✗ ${name}${got === undefined ? '' : ` — получили ${JSON.stringify(got)}`}`);
};

console.log('Домен из адреса');
{
  check('обычный адрес', domainOf('ivanov@company.ru') === 'company.ru');
  check('регистр не важен', domainOf('Ivanov@Company.RU') === 'company.ru');
  // Собака внутри имени встречается: берём последнюю
  check('последняя собака и есть разделитель', domainOf('a@b@company.ru') === 'company.ru');
  check('без собаки домена нет', domainOf('ivanov') === '');
}

console.log('Кандидаты для входящей почты');
{
  const c = imapCandidates('company.ru');
  check('список не пуст', c.length >= 3, c.length);
  check('первым — самое частое имя', c[0].host === 'imap.company.ru', c[0]);
  check('вторым — mail.<домен>', c[1].host === 'mail.company.ru', c[1]);
  check('сам домен тоже пробуется', c.some((x) => x.host === 'company.ru'));
  check('шифрованный порт идёт первым', c[0].port === 993 && c[0].secure);
  // Незашифрованный порт нужен: у почты предприятия внутри сети он до сих пор
  // встречается. Но только последним — иначе пароль уйдёт открытым там, где
  // была возможность шифрования
  const plain = c.findIndex((x) => !x.secure);
  const secure = c.map((x) => x.secure).lastIndexOf(true);
  check('незашифрованные — после всех шифрованных', plain > secure, { plain, secure });
}

console.log('Кандидаты для отправки');
{
  const c = smtpCandidates('company.ru');
  check('первым — smtp.<домен>', c[0].host === 'smtp.company.ru', c[0]);
  check('465 идёт раньше 587', c.findIndex((x) => x.port === 465) < c.findIndex((x) => x.port === 587));
  check('587 в списке есть', c.some((x) => x.port === 587));
  check('порты входящей почты сюда не попали', !c.some((x) => x.port === 993));
}

console.log('Мусор не превращается в список');
{
  check('пустой домен', imapCandidates('').length === 0);
  check('домен без точки — не домен', imapCandidates('localhost').length === 0);
  check('собака в начале отбрасывается', imapCandidates('@company.ru')[0].host === 'imap.company.ru');
  check('то же для отправки', smtpCandidates('').length === 0);
}

(async () => {
console.log('Перебор не ходит на служебные адреса');
{
  check('127.0.0.1 запрещён', isForbiddenProbeAddress('127.0.0.1'));
  check('::1 запрещён', isForbiddenProbeAddress('::1'));
  check('169.254.169.254 запрещён', isForbiddenProbeAddress('169.254.169.254'));
  check('::ffff:127.0.0.1 запрещён', isForbiddenProbeAddress('::ffff:127.0.0.1'));
  check('частная сеть предприятия разрешена', !isForbiddenProbeAddress('10.1.2.3') && !isForbiddenProbeAddress('192.168.0.5'));
  check('обычный адрес разрешён', !isForbiddenProbeAddress('93.184.216.34'));
  check('probe на localhost не соединяется', (await probe({ host: 'localhost', port: 22, secure: false } as any, 1000)) === false);
}

if (failed) {
  console.error(`\nПровалено проверок: ${failed}`);
  process.exit(1);
}
console.log('\nВсе проверки поиска почтового сервера пройдены');
})();
