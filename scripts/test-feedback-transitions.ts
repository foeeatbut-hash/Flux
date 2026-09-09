/**
 * Переходы обращения: что разрешено и при каких условиях.
 *
 * Правил пятнадцать, и половина с обязательными условиями. Проверка нужна не
 * ради полноты, а ради двух вещей, которые ломаются молча.
 *
 * Первая: неописанный переход должен быть запрещён. «Отклонённое» обращение,
 * переведённое сразу в «готово», выглядит для автора решённым, хотя решением
 * никто не занимался.
 *
 * Вторая: обязательные условия должны проверяться все сразу. Пропущенный
 * исполнитель оставляет карточку «в работе», которую очередь обработчика
 * больше не покажет, — и она потеряется без единого сообщения об ошибке.
 */

import { RULES, allowedFrom, checkTransition, CLOSED, waitsAuthor, type Attempt } from '../feedback/transitions';
import { STATUSES, type Status } from '../feedback/contracts';

let f = 0;
const ok = (name: string, cond: boolean, detail?: unknown) =>
  cond
    ? console.log('  ✓', name)
    : (f++, console.error('  ✗', name, detail !== undefined ? JSON.stringify(detail).slice(0, 300) : ''));

const go = (a: Partial<Attempt> & Pick<Attempt, 'from' | 'to' | 'actor'>) =>
  checkTransition({ ...a } as Attempt);

console.log('1. Обычный путь обращения');
{
  ok('новое берут в разбор', go({ from: 'NEW', to: 'TRIAGE', actor: 'triage' }).ok);
  ok('из разбора планируют, объяснив решение',
    go({ from: 'TRIAGE', to: 'PLANNED', actor: 'triage', reason: 'сделаем в следующем выпуске' }).ok);
  ok('в работу — с исполнителем',
    go({ from: 'PLANNED', to: 'IN_PROGRESS', actor: 'triage', assigneeId: 'u1' }).ok);
  ok('на проверку — с версией',
    go({ from: 'IN_PROGRESS', to: 'VERIFY', actor: 'triage', resolvedVersion: '1.2.0' }).ok);
  ok('автор закрывает сам', go({ from: 'VERIFY', to: 'DONE', actor: 'author' }).ok);
}

console.log('\n2. Обязательные условия проверяются, а не подразумеваются');
{
  ok('в работу без исполнителя нельзя',
    !go({ from: 'PLANNED', to: 'IN_PROGRESS', actor: 'triage' }).ok);
  ok('на проверку без версии и без объяснения нельзя',
    !go({ from: 'IN_PROGRESS', to: 'VERIFY', actor: 'triage' }).ok);
  // «Выпуска не будет» — законный исход, но его надо назвать вслух
  ok('на проверку можно без выпуска, если сказать почему',
    go({ from: 'IN_PROGRESS', to: 'VERIFY', actor: 'triage', noReleaseReason: 'поправили настройку на сервере' }).ok);
  ok('отклонить молча нельзя',
    !go({ from: 'TRIAGE', to: 'REJECTED', actor: 'triage' }).ok);
  ok('отклонить с причиной можно',
    go({ from: 'TRIAGE', to: 'REJECTED', actor: 'triage', reason: 'так задумано' }).ok);
  ok('связать дубль без ссылки нельзя',
    !go({ from: 'TRIAGE', to: 'DUPLICATE', actor: 'triage' }).ok);
  ok('спросить автора без вопроса нельзя',
    !go({ from: 'TRIAGE', to: 'NEEDS_INFO', actor: 'triage' }).ok);
}

console.log('\n3. Права сторон разведены');
{
  ok('автор не берёт обращение в разбор', !go({ from: 'NEW', to: 'TRIAGE', actor: 'author' }).ok);
  ok('автор не отклоняет своё обращение',
    !go({ from: 'TRIAGE', to: 'REJECTED', actor: 'author', reason: 'передумал' }).ok);
  ok('автор отзывает своё', go({ from: 'TRIAGE', to: 'WITHDRAWN', actor: 'author' }).ok);
  ok('обработчик чужое обращение не отзывает',
    !go({ from: 'TRIAGE', to: 'WITHDRAWN', actor: 'triage' }).ok);
  // Автор дубля не видит основную карточку и не может судить, ошибка это или нет
  ok('разъединяет дубль только обработчик',
    !go({ from: 'DUPLICATE', to: 'TRIAGE', actor: 'author', reason: 'это не дубль' }).ok);
  ok('обработчик разъединяет с причиной',
    go({ from: 'DUPLICATE', to: 'TRIAGE', actor: 'triage', reason: 'разные причины' }).ok);
}

console.log('\n4. Возврат после ответа автора');
{
  ok('вопрос из работы задать можно',
    go({ from: 'IN_PROGRESS', to: 'NEEDS_INFO', actor: 'triage', reason: 'какая версия?' }).ok);
  // Работа возвращается туда, откуда её увели, а не в начало
  ok('в работу возвращается то, что в работе и было',
    go({ from: 'NEEDS_INFO', to: 'IN_PROGRESS', actor: 'author', resumeStatus: 'IN_PROGRESS' }).ok);
  ok('а то, что не было, — не возвращается',
    !go({ from: 'NEEDS_INFO', to: 'IN_PROGRESS', actor: 'author', resumeStatus: 'TRIAGE' }).ok);
  ok('в разбор ответ возвращает всегда',
    go({ from: 'NEEDS_INFO', to: 'TRIAGE', actor: 'author' }).ok);
}

console.log('\n5. Неописанного перехода не существует');
{
  // Самый опасный случай: отклонённое становится «готово» без разбора
  ok('из отклонённого сразу в готово нельзя',
    !go({ from: 'REJECTED', to: 'DONE', actor: 'triage' }).ok);
  ok('из нового сразу в готово нельзя',
    !go({ from: 'NEW', to: 'DONE', actor: 'triage' }).ok);
  ok('из готового в работу нельзя',
    !go({ from: 'DONE', to: 'IN_PROGRESS', actor: 'triage', assigneeId: 'u1' }).ok);
  ok('переход в то же состояние отвергается',
    !go({ from: 'TRIAGE', to: 'TRIAGE', actor: 'triage' }).ok);
  ok('отклонённое и отозванное можно вернуть в разбор с объяснением',
    go({ from: 'REJECTED', to: 'TRIAGE', actor: 'author', reason: 'вот шаги' }).ok
    && go({ from: 'WITHDRAWN', to: 'TRIAGE', actor: 'author', reason: 'повторилось' }).ok);

  // Полный перебор: каждая пара состояний либо описана правилом, либо запрещена
  let allowed = 0;
  const strange: string[] = [];
  for (const from of STATUSES) {
    for (const to of STATUSES) {
      for (const actor of ['author', 'triage'] as const) {
        const verdict = go({
          from: from as Status, to: to as Status, actor,
          reason: 'причина', assigneeId: 'u1', resolvedVersion: '1.0.0',
          targetReportId: 'r1', resumeStatus: 'IN_PROGRESS',
        });
        if (!verdict.ok) continue;
        allowed++;
        const described = RULES.some((r) => r.from.includes(from as Status) && r.to === to && r.who.includes(actor));
        if (!described) strange.push(`${from}→${to} (${actor})`);
      }
    }
  }
  ok(`разрешённых сочетаний ${allowed}, и все описаны правилами`, strange.length === 0, strange);
  ok('разрешено далеко не всё', allowed < STATUSES.length * STATUSES.length, allowed);
}

console.log('\n6. Кнопки в карточке берутся из тех же правил');
{
  const forAuthor = allowedFrom('VERIFY', 'author').map((r) => r.action);
  ok('автору на проверке предложено «Помогло»', forAuthor.includes('Помогло'), forAuthor);
  ok('и «Проблема осталась»', forAuthor.includes('Проблема осталась'), forAuthor);
  ok('автору не предложено отклонить', !allowedFrom('TRIAGE', 'author').some((r) => r.to === 'REJECTED'));
  ok('у каждого правила есть имя действия', RULES.every((r) => r.action.length > 2));
  ok('закрытые состояния перечислены', CLOSED.length === 4, CLOSED);
  ok('ожидание автора распознаётся', waitsAuthor('NEEDS_INFO') && waitsAuthor('VERIFY') && !waitsAuthor('TRIAGE'));
}

console.log(f === 0 ? '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ' : `\nПРОВАЛОВ: ${f}`);
process.exit(f === 0 ? 0 : 1);
