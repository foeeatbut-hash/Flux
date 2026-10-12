/**
 * Журнал действий: фраза вместо адреса, и ничего лишнего.
 *
 * Владелец попросил сделать журнал подробным — «чтобы записывалось каждое
 * действие сотрудника». Подробный журнал бесполезен, если читать его нельзя:
 * «POST /api/files» не отвечает на вопрос, кто удалил ведомость, а разбираются
 * по журналу именно люди.
 *
 * Здесь проверяется превращение запроса в человеческую фразу и то, что в
 * журнал не попадает шум: опрос уведомлений и присутствия идёт постоянно и
 * забил бы собой всё остальное за час.
 *
 * Запуск: npx tsx scripts/test-action-log.ts
 */
import { describeAction, isNoise } from '../server/actionWords';

let failed = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  if (cond) return;
  failed++;
  console.error(`  ✗ ${name}${got === undefined ? '' : ` — получили ${JSON.stringify(got)}`}`);
};

console.log('Запрос превращается во фразу');
{
  check('создание тега', describeAction('POST', '/api/tags')?.what === 'Создал тег',
    describeAction('POST', '/api/tags'));
  check('удаление файла', describeAction('DELETE', '/api/files/abc')?.what === 'Удалил файл');
  check('правка оборудования', describeAction('PATCH', '/api/equipment/1')?.what === 'Изменил оборудование');
  check('вход назван входом', describeAction('POST', '/api/login')?.what === 'Вошёл в программу');

  // Глагол по методу иногда врёт: публикация релиза — не «создание обновления»
  check('публикация релиза', describeAction('POST', '/api/updates')?.what === 'Опубликовал релиз',
    describeAction('POST', '/api/updates'));
  check('отзыв релиза', describeAction('DELETE', '/api/updates/0.92.0')?.what === 'Отозвал релиз');
  check('загрузка файла обновления',
    describeAction('POST', '/api/updates/upload?version=0.92.0')?.what === 'Загрузил файл обновления',
    describeAction('POST', '/api/updates/upload?version=0.92.0'));
  check('изменение прав названо прямо',
    describeAction('POST', '/api/users/1/permissions')?.what === 'Изменил права сотрудника');
}

console.log('Куда идти смотреть и над чем действие');
{
  check('у тега адрес реестра', describeAction('POST', '/api/tags')?.route === '/registry');
  check('у файла адрес Проводника', describeAction('DELETE', '/api/files/x')?.route === '/explorer');
  const t = describeAction('DELETE', '/api/files/2f1c9a3b-1111-4444-8888-abcdefabcdef');
  check('идентификатор из адреса запомнен', t?.target.startsWith('2f1c9a3b'), t);
  check('версия тоже считается за цель',
    describeAction('DELETE', '/api/updates/0.92.0')?.target === '0.92.0',
    describeAction('DELETE', '/api/updates/0.92.0'));
  check('без идентификатора цель пустая', describeAction('POST', '/api/tags')?.target === '');
}

console.log('Чего в журнале быть не должно');
{
  check('чтение не записывается', describeAction('GET', '/api/files') === null);
  check('опрос уведомлений — шум', isNoise('/api/notifications?userId=1'));
  check('присутствие — шум', isNoise('/api/presence'));
  check('сам журнал — шум', isNoise('/api/logs'));
  check('проверка здоровья — шум', isNoise('/api/health'));
  check('история Guide в журнал не пишется', isNoise('/api/guide/chats'));
  check('а работа с файлами — не шум', !isNoise('/api/files'));
  check('и с тегами тоже', !isNoise('/api/tags'));
}

console.log('Незнакомый адрес не выдумывается');
{
  const odd = describeAction('POST', '/api/чего-то-новое');
  check('фраза всё равно есть', !!odd?.what, odd);
  check('и в ней виден настоящий адрес', odd!.what.includes('чего-то-новое'), odd);
  check('пустой адрес не роняет разбор', describeAction('POST', '') === null);
}

if (failed) {
  console.error(`\nПровалено проверок: ${failed}`);
  process.exit(1);
}
console.log('\nВсе проверки журнала действий пройдены');
