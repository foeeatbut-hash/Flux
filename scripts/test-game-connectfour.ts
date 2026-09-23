import { connectfour, WIDTH, HEIGHT, type FourState } from '../play/games/connectfour';

let failed = 0;
const ok = (name: string, pass: boolean) => pass
  ? console.log('  ✓', name) : (failed++, console.error('  ✗', name));
const seats = ['первый', 'второй'];
const put = (s: FourState, column: number): FourState => connectfour.apply(s, seats[s.turn], { column });

let s = connectfour.init('семя', seats);
ok('первый ходит первым', connectfour.turnOf(s) === seats[0]);
ok('чужой ход отклонён', !!connectfour.why(s, seats[1], { column: 0 }));
ok('недопустимый столбец отклонён', !!connectfour.why(s, seats[0], { column: 7 }));
for (const column of [0, 1, 0, 1, 0, 1, 0]) s = put(s, column);
ok('четыре по вертикали завершают партию', connectfour.outcome(s).winnerTeam === 1);
ok('после победы хода нет', connectfour.turnOf(s) === '');
ok('после победы ход отклонён', !!connectfour.why(s, seats[1], { column: 2 }));

s = connectfour.init('семя', seats);
for (const column of [0, 0, 1, 1, 2, 2, 3]) s = put(s, column);
ok('четыре по горизонтали завершают партию', connectfour.outcome(s).winnerTeam === 1);

s = connectfour.init('семя', seats);
for (const column of [0, 1, 1, 2, 4, 2, 2, 3, 4, 3, 5, 3, 3]) s = put(s, column);
ok('четыре по диагонали завершают партию', connectfour.outcome(s).winnerTeam === 1);

s = connectfour.init('семя', seats);
for (let i = 0; i < HEIGHT; i++) s = put(s, 0);
ok('заполненный столбец закрыт', !!connectfour.why(s, seats[s.turn], { column: 0 }));
ok('снимок не раскрывает состояние постороннему', (connectfour.viewOf(s, 'чужой') as any).watcher === true);
ok('поле имеет 42 клетки', s.board.length === WIDTH * HEIGHT);

console.log(failed ? `\nПРОВАЛЕНО: ${failed}` : '\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ');
process.exit(failed ? 1 : 0);
