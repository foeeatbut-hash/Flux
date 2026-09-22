/**
 * Главная кнопка: в каждом состоянии написано то, что и правда произойдёт.
 *
 * Состояний у неё девять (ТЗ §13.2), и выбирается из них ровно одно. Проверка
 * стоит затем, что ошибиться здесь глазом легко, а цена ошибки высока: кнопка
 * «Начать матч» при неустановленной игре — это обещание, которое некому
 * исполнить, а «Установить» во время идущего матча уводит человека из матча.
 *
 * Запуск: npx tsx scripts/test-play-action.ts
 */
import { mainAction, type ActionInput, type InstallState } from '../src/play/mainAction';

let f = 0;
const ok = (n: string, c: boolean, d?: any) =>
  (c ? console.log('  ✓', n) : (f++, console.error('  ✗', n, d !== undefined ? JSON.stringify(d).slice(0, 200) : '')));

const base: ActionInput = {
  link: 'live',
  maintenance: false,
  install: 'ready',
  session: null,
  lobby: null,
  party: { leaderId: 'me' },
  meId: 'me',
  iAmReady: false,
  allReady: false,
  stale: false,
};

const at = (patch: Partial<ActionInput>) => mainAction({ ...base, ...patch });

console.log('1. Срочное побеждает несрочное');
{
  // Связи нет — качать и начинать бессмысленно: действие уйдёт в никуда
  ok('потерянная связь важнее незавершённой закачки',
    at({ link: 'reconnecting', install: 'downloading' }).id === 'reconnect');
  // Идущий матч важнее всего: человеку нужно в него, а не в меню
  ok('идущий матч важнее установки',
    at({ session: { state: 'RUNNING' }, install: 'absent' }).id === 'return');
  ok('выделение сервера показывается ожиданием',
    at({ session: { state: 'ALLOCATING' } }).id === 'connecting');
  ok('во время выделения нажимать нечего',
    at({ session: { state: 'ALLOCATING' } }).disabled === true);
}

console.log('\n2. Состояние игры на машине');
{
  const cases: Array<[InstallState, string]> = [
    ['unavailable', 'unavailable'],
    ['absent', 'install'],
    ['downloading', 'pause'],
    ['paused', 'resume'],
    ['outdated', 'update'],
    ['broken', 'restore'],
  ];
  for (const [install, id] of cases) {
    ok(`${install} → ${id}`, at({ install }).id === id, at({ install }));
  }
  ok('неопубликованную сборку нажать нельзя', at({ install: 'unavailable' }).disabled === true);
  // Играть в неустановленное нельзя, и «Начать матч» тут было бы обещанием,
  // которое некому исполнить
  ok('при неустановленной игре матч не предлагается',
    at({ install: 'absent', lobby: { state: 'READY' }, iAmReady: true, allReady: true }).id === 'install');
}

console.log('\n3. Подготовка и готовность');
{
  ok('без лобби — подготовиться', at({}).id === 'prepare');
  ok('в лобби и не отмечен — «Готов»', at({ lobby: { state: 'FORMING' } }).id === 'ready');
  ok('отмечен, но не все — можно передумать',
    at({ lobby: { state: 'FORMING' }, iAmReady: true }).id === 'unready');
  ok('все готовы и я ведущий — начать',
    at({ lobby: { state: 'READY' }, iAmReady: true, allReady: true }).id === 'start');
  ok('все готовы и я не ведущий — ждём',
    at({ lobby: { state: 'READY' }, iAmReady: true, allReady: true, party: { leaderId: 'другой' } }).id === 'waitLeader');
  ok('и нажимать нечего',
    at({ lobby: { state: 'READY' }, iAmReady: true, allReady: true, party: { leaderId: 'другой' } }).disabled === true);
}

console.log('\n4. Обслуживание останавливает новое, но не идущее');
{
  ok('новый матч не начинается', at({ maintenance: true }).id === 'maintenance');
  ok('и это сказано словами', /обслужив/i.test(at({ maintenance: true }).label));
  // Уже идущий матч обслуживание не отменяет: человека нельзя выкинуть из игры
  ok('идущий матч не трогается',
    at({ maintenance: true, session: { state: 'RUNNING' } }).id === 'return');
}

console.log('\n5. Устаревшему состоянию не дают действовать');
{
  const stale = at({ stale: true });
  ok('кнопка гаснет', stale.disabled === true, stale);
  ok('но надпись не подменяется', stale.id === 'prepare', stale.id);
  ok('и причина названа', /устарел/i.test(stale.hint), stale.hint);
  // Переподключение гасить нельзя: это единственный выход из положения
  ok('переподключение остаётся доступным',
    at({ stale: true, link: 'reconnecting' }).disabled === false);
  // И уже выключенное не «выключается дважды» с другой причиной
  ok('уже выключенное не меняет причины',
    at({ stale: true, install: 'unavailable' }).id === 'unavailable');
}

console.log('\n6. У каждого состояния есть внятная подпись');
{
  const seen = new Set<string>();
  const all: ActionInput[] = [
    { ...base, link: 'reconnecting' },
    { ...base, session: { state: 'RUNNING' } },
    { ...base, session: { state: 'ALLOCATING' } },
    ...(['unavailable', 'absent', 'downloading', 'paused', 'outdated', 'broken'] as InstallState[])
      .map((install) => ({ ...base, install })),
    { ...base, maintenance: true },
    { ...base },
    { ...base, lobby: { state: 'FORMING' } },
    { ...base, lobby: { state: 'FORMING' }, iAmReady: true },
    { ...base, lobby: { state: 'READY' }, iAmReady: true, allReady: true },
    { ...base, lobby: { state: 'READY' }, iAmReady: true, allReady: true, party: { leaderId: 'другой' } },
  ];
  for (const input of all) {
    const v = mainAction(input);
    seen.add(v.id);
    ok(`${v.id}: подпись не пустая`, v.label.length > 2 && v.hint.length > 10, v);
  }
  ok(`состояний разобрано: ${seen.size}`, seen.size >= 13, [...seen]);
}

console.log(f === 0 ? '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ' : `\nПРОВАЛОВ: ${f}`);
process.exit(f === 0 ? 0 : 1);
