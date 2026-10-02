import { mapEmployeeRows, employeeImportName, validateEmployeeImportMatrix } from '../server/usersImport';

function check(ok: unknown, message: string) {
  if (!ok) throw new Error(`✗ ${message}`);
}

const headers = ['Логин', 'Фамилия', 'Имя', 'Отдел', 'Пароль'];
const mapping = { symbol: 0, lastName: 1, firstName: 2, department: 3, password: 4 } as const;
const existing = [{ id: 'u1', symbol: 'E02', role: 'ENGINEER_VENT' }, { id: 'owner', symbol: 'flux.owner', role: 'OWNER' }];
const create = mapEmployeeRows([
  headers,
  ['E01', 'Иванов', 'Иван', 'Проекты', ''],
  ['e01', 'Петров', 'Пётр', '', ''],
  ['E02', 'Сидоров', 'Сидор', '', ''],
  ['E03', '', 'Имя', '', ''],
], mapping, existing, 'ENGINEER_VENT', 'create');
check(create[0].action === 'create' && !create[0].error, 'валидная строка должна планироваться к созданию');
check(create[1].error?.includes('Повтор'), 'повтор логина в файле должен отмечаться');
check(create[2].error?.includes('уже существует'), 'существующий логин в режиме создания должен отмечаться');
check(create[3].error?.includes('ФИО'), 'неполное ФИО должно отмечаться');
check(employeeImportName(create[0]).name === 'Иванов Иван', 'ФИО должно собираться из частей');

const update = mapEmployeeRows([headers, ['E02', 'Сидоров', 'Сидор', '', 'secret']], mapping, existing, 'ENGINEER_VENT', 'update');
check(update[0].action === 'update' && update[0].existingId === 'u1', 'обновление должно сопоставляться по логину');
check(update[0].error?.includes('Пароль'), 'пароль существующего сотрудника нельзя менять импортом');
const owner = mapEmployeeRows([headers, ['flux.owner', 'Владелец', 'Flux', '', '']], mapping, existing, 'ENGINEER_VENT', 'update');
check(owner[0].error?.includes('зарезервирован') && owner[0].error?.includes('владельца'), 'профиль владельца должен быть защищён');
const partialUpdate = mapEmployeeRows([headers, ['E02', '', '', 'Сметный отдел', '']], mapping, existing, 'ENGINEER_VENT', 'update');
check(!partialUpdate[0].error, 'обновление должно принимать только выбранные поля и сохранять пустые поля');
check(validateEmployeeImportMatrix([['header'], ['value']]), 'допустимая таблица должна проходить проверку размера');
check(!validateEmployeeImportMatrix([['x'.repeat(5000)], ['value']]), 'слишком большая ячейка должна отклоняться');

console.log('✓ Проверка импорта сотрудников прошла');
