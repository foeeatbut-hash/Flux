import { drawpoker, handValue, compareHands, type PokerState } from '../play/games/drawpoker';
import { chachaBlock } from '../play/games/secureDeck';
import { rulesOf } from '../play/games/all';
import { gameById, gameEntitlement } from '../play/features';

let failed = 0;
const ok = (name: string, pass: boolean) => pass
  ? console.log('  ✓', name) : (failed++, console.error('  ✗', name));
const seats = ['первый', 'второй'];
const play = (s: PokerState, move: any) => drawpoker.apply(s, seats[s.turn], move);

const c = (rank: number, suit: number) => suit * 13 + rank - 2;
ok('покер подключён к каталогу, правам и серверному реестру',
  gameById('drawpoker')?.kind === 'builtin' && !!gameEntitlement('drawpoker') && rulesOf('drawpoker') === drawpoker);
ok('четыре в ряд подключена к каталогу и серверному реестру',
  gameById('connectfour')?.kind === 'builtin' && !!rulesOf('connectfour'));
const hex = (bytes: Uint8Array) => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
ok('поток колоды совпадает с проверочным вектором ChaCha20', hex(chachaBlock(
  Uint8Array.from({ length: 32 }, (_, i) => i), 1,
  Uint8Array.from([0, 0, 0, 9, 0, 0, 0, 0x4a, 0, 0, 0, 0]),
)) === '10f1e7e4d13b5915500fdd1fa32071c4c7d1f4c733c068030422aa9ac3d46c4e'
  + 'd2826446079faa0914c2d705d98b02a2b5129cd1de164eb9cbd083e8a2503c4e');
ok('стрит-флеш сильнее каре', compareHands(
  [c(10, 0), c(11, 0), c(12, 0), c(13, 0), c(14, 0)],
  [c(9, 0), c(9, 1), c(9, 2), c(9, 3), c(2, 0)],
) > 0);
ok('туз-два-три-четыре-пять — младший стрит', handValue(
  [c(14, 0), c(2, 1), c(3, 2), c(4, 3), c(5, 0)],
)[1] === 5);
ok('старшая пара побеждает младшую', compareHands(
  [c(10, 0), c(10, 1), c(2, 0), c(3, 0), c(4, 0)],
  [c(9, 0), c(9, 1), c(2, 1), c(3, 1), c(4, 1)],
) > 0);
ok('одинаковые комбинации дают ничью', compareHands(
  [c(10, 0), c(10, 1), c(2, 0), c(3, 0), c(4, 0)],
  [c(10, 2), c(10, 3), c(2, 1), c(3, 1), c(4, 1)],
) === 0);

const seed = '0123456789abcdef'.repeat(4);
let s = drawpoker.init(seed, seats);
const again = drawpoker.init(seed, seats);
ok('перемешивание повторяется по семени', JSON.stringify(s.hands) === JSON.stringify(again.hands));
ok('руки не пересекаются', new Set([...s.hands[0], ...s.hands[1]]).size === 10);
const rawView = drawpoker.viewOf(s, seats[0]);
const view = JSON.stringify(rawView);
ok('чужой руки и колоды нет в снимке', !view.includes('deck') && !view.includes('opponentHand":[') &&
  s.hands[1].every(card => !(rawView as any).hand.includes(card)));
ok('семя не уходит в снимок', !view.includes(seed));
ok('посторонний видит только запрет', (drawpoker.viewOf(s, 'чужой') as any).watcher === true);
ok('первый ходит первым', drawpoker.turnOf(s) === seats[0]);
ok('ход соперника запрещён', !!drawpoker.why(s, seats[1], { action: 'check' }));
s = play(s, { action: 'raise' });
ok('ставка списана и добавлена в банк', s.pot === 20 && s.stacks[0] === 85);
ok('чек против ставки запрещён', !!drawpoker.why(s, seats[1], { action: 'check' }));
s = play(s, { action: 'call' });
ok('после уравнивания начинается обмен', s.phase === 'draw' && s.pot === 30);
ok('обмен четырёх карт отклонён', !!drawpoker.why(s, seats[0], { action: 'draw', cards: [0, 1, 2, 3] }));
ok('повтор карты отклонён', !!drawpoker.why(s, seats[0], { action: 'draw', cards: [0, 0] }));
const oldCard = s.hands[0][0];
s = play(s, { action: 'draw', cards: [0] });
ok('заменена только выбранная карта', s.hands[0][0] !== oldCard && s.hands[0].slice(1).every((v, i) => v === again.hands[0][i + 1]));
s = play(s, { action: 'draw', cards: [] });
ok('после обоих обменов второй круг ставок', s.phase === 'final' && s.turn === 0);
s = play(s, { action: 'check' });
s = play(s, { action: 'check' });
ok('два чека открывают руки и завершают раздачу', drawpoker.outcome(s).done &&
  (drawpoker.viewOf(s, seats[0]) as any).opponentHand.length === 5);
ok('банк выплачен целиком', s.stacks[0] + s.stacks[1] === 200);
ok('после конца ставки запрещены', !!drawpoker.why(s, seats[0], { action: 'raise' }));

s = drawpoker.init('fedcba9876543210'.repeat(4), seats);
s = play(s, { action: 'fold' });
ok('сброс карт отдаёт банк сопернику', drawpoker.outcome(s).winnerTeam === 2 && s.stacks[1] === 105);

console.log(failed ? `\nПРОВАЛЕНО: ${failed}` : '\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ');
process.exit(failed ? 1 : 0);
