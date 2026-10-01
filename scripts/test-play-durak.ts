import assert from 'node:assert/strict';
import { durak, initDurak, durakRank, durakSuit, canBeatDurak, type DurakState, type DurakMove, type DurakView } from '../play/games/durak';
import { rngOf } from '../play/games/kit';
let checks = 0;
const check = (name: string, condition: boolean) => { assert.ok(condition, name); checks++; console.log('✓', name); };
const seed = '0123456789abcdef'.repeat(4);
const seats = ['alice', 'bob', 'carol'];
const initial = initDurak(seed, seats);
check('36 карт, раздача по шесть и оставшиеся в колоде', initial.deckSize === 36 && initial.hands.every(hand => hand.length === 6) && initial.deck.length === 18);
check('Одинаковое секретное семя даёт одинаковую раздачу', JSON.stringify(initial) === JSON.stringify(initDurak(seed, seats)));
check('Козырь лежит на дне колоды', initial.deck.at(-1) === initial.trumpCard);
check('В колоде 36 нет младших двух–пятёрок', [...initial.deck, ...initial.hands.flat()].every(card => durakRank(card) >= 6));
const allTrumps = initial.hands.flatMap((hand, seat) => hand.filter(card => durakSuit(card) === initial.trumpSuit).map(card => ({ card, seat })));
const minimum = allTrumps.sort((a, b) => durakRank(a.card) - durakRank(b.card))[0];
check('Первая атака по младшему козырю', minimum ? initial.attacker === minimum.seat : initial.attacker === 0);
for (const count of [2, 3, 6, 8]) { const state = initDurak(seed, Array.from({ length: count }, (_, index) => `seat${index}`)); check(`Для ${count} игроков выбрана допустимая колода`, state.deckSize === (count > 6 ? 52 : 36)); }
for (const count of [0, 1, 9]) { assert.throws(() => initDurak(seed, Array.from({ length: count }, (_, index) => `seat${index}`))); checks++; }
assert.throws(() => initDurak(seed, Array.from({ length: 7 }, (_, index) => `seat${index}`), { deckSize: 36 })); checks++;
assert.throws(() => initDurak(seed, ['same', 'same'])); checks++;
check('52 карты допускают до восьми игроков', initDurak(seed, Array.from({ length: 8 }, (_, index) => `seat${index}`), { deckSize: 52 }).deck.length === 4);
const view = durak.viewOf(initial, seats[0]) as DurakView;
check('Игрок получает только свою руку и количества чужих карт', JSON.stringify(view.hand) === JSON.stringify(initial.hands[0]) && view.handCounts.every(count => count === 6) && !('hands' in view));
check('Порядок колоды и секретное семя не входят в DTO', !('deck' in view) && !('seed' in view) && !('discard' in view));
const watcher = durak.viewOf(initial, 'watcher') as DurakView;
check('Наблюдатель не получает ни одной руки и допустимых карт', !watcher.hand.length && watcher.seat === -1 && !watcher.allowed.attack.length && !watcher.allowed.defend.length);
view.hand.length = 0; check('Изменение DTO не меняет руку на сервере', initial.hands[0].length === 6);
check('Младшую карту бьёт старшая той же масти', canBeatDurak(4, 5, 2));
check('Равный номинал той же масти не бьёт', !canBeatDurak(4, 4, 2));
check('Некозырь бьётся козырем', canBeatDurak(12, 26, 2));
check('Козырь не бьётся обычной старшей картой', !canBeatDurak(26, 12, 2));
check('Козырь бьётся только старшим козырем', canBeatDurak(26, 27, 2));
function fixture(hands: number[][], settings: Partial<DurakState> = {}): DurakState {
  const ids = hands.map((_, index) => `p${index}`);
  return { ...initDurak(seed, ids, { deckSize: 52 }), hands: hands.map(hand => [...hand]), deck: [], discard: [], table: [], attacker: 0, roundAttacker: 0, defender: 1, attackLimit: Math.min(6, hands[1].length), trumpSuit: 3, trumpCard: 39, ...settings };
}
const fixtureInitial = fixture([[4, 19, 5], [6, 7, 40], [30, 31]]);
check('Чужая первая атака запрещена', !!durak.why(fixtureInitial, 'p2', { type: 'attack', card: 30 }));
check('Карта из чужой руки запрещена', !!durak.why(fixtureInitial, 'p0', { type: 'attack', card: 6 }));
const beforeInvalid = JSON.stringify(fixtureInitial);
assert.throws(() => durak.apply(fixtureInitial, 'p0', { type: 'attack', card: 500 }));
check('Неверный ход не меняет состояние даже при прямом apply', JSON.stringify(fixtureInitial) === beforeInvalid);
let state = durak.apply(fixtureInitial, 'p0', { type: 'attack', card: 4 });
check('После атаки защитник ждёт хода', durak.turnOf(state) === 'p1');
check('Подкинуть иной номинал нельзя', !!durak.why(state, 'p2', { type: 'attack', card: 31 }));
check('Другому игроку можно подкинуть совпадающий номинал', !durak.why(state, 'p2', { type: 'attack', card: 30 }));
check('Подкидной не разрешает перевод', !!durak.why(state, 'p1', { type: 'transfer', card: 6 }));
state = durak.apply(state, 'p1', { type: 'defend', card: 6, target: 0 });
check('Защита открывает новый допустимый номинал', (durak.viewOf(state, 'p0') as DurakView).allowed.attack.includes(19));
check('Защищённую карту нельзя бить повторно', !!durak.why(state, 'p1', { type: 'defend', card: 7, target: 0 }));
check('Неверный индекс защиты отклоняется', !!durak.why(state, 'p1', { type: 'defend', card: 7, target: NaN }));
state = durak.apply(state, 'p0', { type: 'pass' }); state = durak.apply(state, 'p2', { type: 'pass' });
check('После «Бито» следующий кон начинает защитник', state.attacker === 1 && state.defender === 2 && !state.table.length && state.discard.length === 2);
let taking = fixture([[4, 17], [10, 11], [30, 43]]);
taking = durak.apply(taking, 'p0', { type: 'attack', card: 4 }); taking = durak.apply(taking, 'p1', { type: 'take' });
check('После «Беру» можно подкинуть совпадающий номинал', !durak.why(taking, 'p2', { type: 'attack', card: 30 }));
check('После «Беру» защитник не отбивает карты', !!durak.why(taking, 'p1', { type: 'defend', card: 10, target: 0 }));
taking = durak.apply(taking, 'p2', { type: 'attack', card: 30 });
check('Взятие завершилось автоматически при пределе начальной руки', taking.hands[1].includes(4) && taking.hands[1].includes(30) && taking.attacker === 2);
const transferBase = fixture([[4, 17], [30, 43], [5, 18, 31]], { variant: 'transfer' });
let transferred = durak.apply(transferBase, 'p0', { type: 'attack', card: 4 });
check('Перевод разрешён совпадающим номиналом до защиты', !durak.why(transferred, 'p1', { type: 'transfer', card: 30 }));
transferred = durak.apply(transferred, 'p1', { type: 'transfer', card: 30 });
check('Перевод меняет защитника и предел его начальной руки', transferred.defender === 2 && transferred.attacker === 1 && transferred.attackLimit === 3 && transferred.table.length === 2);
let transferDraw = fixture([[4, 17], [30, 43], [5, 18, 31]], { variant: 'transfer', deck: [6, 7, 8] });
transferDraw = durak.apply(transferDraw, 'p0', { type: 'attack', card: 4 }); transferDraw = durak.apply(transferDraw, 'p1', { type: 'transfer', card: 30 });
transferDraw = durak.apply(transferDraw, 'p2', { type: 'defend', card: 5, target: 0 }); transferDraw = durak.apply(transferDraw, 'p2', { type: 'defend', card: 31, target: 1 });
transferDraw = durak.apply(transferDraw, 'p0', { type: 'pass' }); transferDraw = durak.apply(transferDraw, 'p1', { type: 'pass' });
check('Добор после перевода начинает первоначальный атакующий', transferDraw.hands[0].includes(6) && transferDraw.hands[0].includes(7) && transferDraw.hands[0].includes(8) && !transferDraw.hands[1].includes(6));
const drawAfterDefense = fixture([[4, 17], [5, 18], [30, 43]], { deck: [6, 7, 8, 9, 10, 11, 12, 19] });
let refill = durak.apply(drawAfterDefense, 'p0', { type: 'attack', card: 4 }); refill = durak.apply(refill, 'p1', { type: 'defend', card: 5, target: 0 });
refill = durak.apply(refill, 'p0', { type: 'pass' }); refill = durak.apply(refill, 'p2', { type: 'pass' });
check('Добор идёт атакующий, остальные по кругу, защитник последним', [6, 7, 8, 9, 10].every(card => refill.hands[0].includes(card)) && [11, 12, 19].every(card => refill.hands[2].includes(card)) && refill.hands[1].length === 1);
const shortTarget = fixture([[4, 17], [30, 43], [5]], { variant: 'transfer' });
check('Перевод запрещён, если следующему игроку не хватает карт', !!durak.why(durak.apply(shortTarget, 'p0', { type: 'attack', card: 4 }), 'p1', { type: 'transfer', card: 30 }));
const configured = durak.apply(initial, seats[0], { type: 'configure', variant: 'transfer', deckSize: 52 });
check('Создатель настраивает правила до первого хода', configured.variant === 'transfer' && configured.deckSize === 52);
check('Другой игрок не меняет правила', !!durak.why(initial, seats[1], { type: 'configure', variant: 'transfer', deckSize: 52 }));
check('После первой атаки правила изменить нельзя', !!durak.why(state, 'p0', { type: 'configure', variant: 'transfer', deckSize: 52 }));
let drawState = fixture([[4], [5]]);
drawState = durak.apply(drawState, 'p0', { type: 'attack', card: 4 }); drawState = durak.apply(drawState, 'p1', { type: 'defend', card: 5, target: 0 });
check('Одновременное окончание последних рук — ничья', drawState.done && drawState.loser === null && durak.outcome(drawState).winnerTeam === 0);
let loseState = fixture([[4], [10]]); loseState = durak.apply(loseState, 'p0', { type: 'attack', card: 4 }); loseState = durak.apply(loseState, 'p1', { type: 'take' });
check('С колодой без карт выходит атакующий, взявший остаётся дураком', loseState.done && loseState.loser === 1 && durak.outcome(loseState).winnerTeam === 1);
const resigned = durak.apply(initDurak(seed, ['a', 'b']), 'a', { type: 'resign' });
check('Сдача на двоих завершает игру победой другого', resigned.done && resigned.quitters.includes(0) && durak.outcome(resigned).winnerTeam === 2);
const multiResigned = durak.apply(initial, seats[initial.defender], { type: 'resign' });
check('Сдача в группе оставляет остальных в партии', !multiResigned.done && multiResigned.quitters.includes(initial.defender) && multiResigned.hands[initial.defender].length === 0);
function conserve(s: DurakState) {
  const cards = [...s.hands.flat(), ...s.deck, ...s.discard, ...s.table.flatMap(pair => pair.defense === null ? [pair.attack] : [pair.attack, pair.defense])];
  assert.equal(cards.length, s.deckSize); assert.equal(new Set(cards).size, s.deckSize);
}
function playComplete(players: number, variant: 'throw-in' | 'transfer', run: number) {
  let s = initDurak((run.toString(16).padStart(2, '0')).repeat(32), Array.from({ length: players }, (_, index) => `u${index}`), { variant });
  const random = rngOf(`bot:${players}:${variant}:${run}`); let moves = 0;
  while (!s.done && moves < 30000) {
    conserve(s); let seat = s.seats.indexOf(durak.turnOf(s)); assert.ok(seat >= 0);
    const view = durak.viewOf(s, s.seats[seat]) as DurakView;
    let move: DurakMove;
    if (view.allowed.defend.length) { const defenses = [...view.allowed.defend].sort((a, b) => (durakSuit(a.card) === s.trumpSuit ? 100 : 0) + durakRank(a.card) - ((durakSuit(b.card) === s.trumpSuit ? 100 : 0) + durakRank(b.card))); move = { type: 'defend', ...defenses[0] }; }
    else if (view.allowed.transfer.length) move = { type: 'transfer', card: view.allowed.transfer[0] };
    else if (view.allowed.take) move = { type: 'take' };
    else if (view.allowed.attack.length && (!view.allowed.pass || random() < 0.8)) { const options = view.allowed.attack; move = { type: 'attack', card: options[Math.floor(random() * options.length)] }; }
    else if (view.allowed.pass) move = { type: 'pass' };
    else throw new Error(`Зависший кон ${players}:${variant}:${moves} ${JSON.stringify(view)}`);
    assert.equal(durak.why(s, s.seats[seat], move), '');
    const original = JSON.stringify(s); const next = durak.apply(s, s.seats[seat], move); assert.equal(JSON.stringify(s), original); s = next; moves++;
  }
  conserve(s); check(`Полная партия ${players} игроков ${variant}, семя ${run}, ${moves} ходов`, s.done && moves > 1 && (s.loser === null || s.hands[s.loser].length > 0));
  if (s.loser !== null) { const outcome = durak.outcome(s); assert.equal((outcome.details.winners as string[]).length, players - 1); assert.equal(outcome.details.loser, s.seats[s.loser]); }
}
const afterQuitInitial = initDurak('ef'.repeat(32), ['q0', 'q1', 'q2', 'q3']);
let afterQuit = durak.apply(afterQuitInitial, afterQuitInitial.seats[afterQuitInitial.attacker], { type: 'attack', card: afterQuitInitial.hands[afterQuitInitial.attacker][0] });
const quitterSeat = afterQuit.defender;
afterQuit = durak.apply(afterQuit, afterQuit.seats[quitterSeat], { type: 'resign' });
conserve(afterQuit);
check('Уход защитника сохраняет все карты и отдаёт очередь следующему активному', !afterQuit.done && !afterQuit.table.length && !afterQuit.hands[quitterSeat].length && afterQuit.attacker !== quitterSeat && afterQuit.defender !== quitterSeat);
check('Вышедший игрок больше не делает ходов', !!durak.why(afterQuit, afterQuit.seats[quitterSeat], { type: 'resign' }));
const eightState = initDurak(seed, Array.from({ length: 8 }, (_, index) => `eight${index}`));
check('Создатель не переключает восемь игроков на колоду 36', !!durak.why(eightState, 'eight0', { type: 'configure', deckSize: 36, variant: 'throw-in' }));
let capped = fixture([[4, 17, 30, 43, 5], [6, 7], [18, 31]]);
capped = durak.apply(capped, 'p0', { type: 'attack', card: 4 }); capped = durak.apply(capped, 'p0', { type: 'attack', card: 17 });
check('Предел подкидывания равен исходной короткой руке защитника', !!durak.why(capped, 'p0', { type: 'attack', card: 30 }) && capped.attackLimit === 2);
for (const players of [2, 3, 6, 8]) for (const variant of ['throw-in', 'transfer'] as const) for (const run of [1, 2, 3]) playComplete(players, variant, run);
console.log(`Дурак: ${checks} проверок пройдено`);
