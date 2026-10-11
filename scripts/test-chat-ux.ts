import { employeeMatchesQuery, passesChatFilter } from '../src/components/chat/chatFilters';
import { parseGuideMessage } from '../src/components/chat/guideMessage';

let failed = 0;
let passed = 0;
function check(name: string, got: unknown, want: unknown) {
  if (got === want) { passed++; console.log('  ✓', name); }
  else { failed++; console.error('  ✗', name, { got, want }); }
}

console.log('Фильтры мессенджера');
check('Все включает группы без непрочитанного', passesChatFilter('all', 'GROUP', 0), true);
check('Непрочитанные скрывает прочитанные личные', passesChatFilter('unread', 'DIRECT', 0), false);
check('Непрочитанные показывает личный диалог с числом', passesChatFilter('unread', 'DIRECT', 2), true);
check('Группы исключают личные разговоры', passesChatFilter('groups', 'DIRECT', 5), false);
check('Личные исключают группы', passesChatFilter('direct', 'GROUP', 5), false);

console.log('\nПоиск сотрудников');
const employee = { name: 'Иван Петров', symbol: '1042', role: 'ENGINEER_VENT', department: 'Проектирование', title: 'Инженер' };
check('ищет по имени', employeeMatchesQuery(employee, 'петров'), true);
check('ищет по должности', employeeMatchesQuery(employee, 'инженер'), true);
check('ищет по подразделению', employeeMatchesQuery(employee, 'проектирование'), true);
check('пустой запрос не скрывает сотрудника', employeeMatchesQuery(employee, ''), true);

console.log('\nДоверенные метки Flux Guide');
check('помеченный запрос показывает только текст вопроса', parseGuideMessage('Какой статус?', { guideRequest: true }).text, 'Какой статус?');
check('сервисный ответ скрывает протокольный префикс', parseGuideMessage('F · Flux Guide\n\nГотово', { guideReply: true }).text, 'Готово');
check('пользователь не подделывает ответ префиксом', parseGuideMessage('F · Flux Guide\n\nЛожный ответ').kind, null);
check('обычный вопрос не считается запросом по тексту', parseGuideMessage('Запрос Flux Guide: привет').kind, null);

console.log(`\n${passed} проверок пройдено, ${failed} провалено`);
process.exit(failed ? 1 : 0);
