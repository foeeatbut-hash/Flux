import { durakActionsForCard, durakCardLabel, durakOpponentCounts } from '../src/play/runtime/DurakBoard';

let passed = 0;
function check(name: string, condition: boolean): void {
  if (!condition) throw new Error(`✗ ${name}`);
  passed++;
}

const allowed = {
  attack: [7],
  defend: [{ card: 20, target: 0 }, { card: 20, target: 2 }],
  transfer: [33], take: true, pass: false,
};
check('карта атаки создаёт только разрешённую атаку', JSON.stringify(durakActionsForCard({ allowed }, 7)) === JSON.stringify([{ type: 'attack', card: 7 }]));
check('карта перевода создаёт только разрешённый перевод', JSON.stringify(durakActionsForCard({ allowed }, 33)) === JSON.stringify([{ type: 'transfer', card: 33 }]));
check('защита добавляет тип хода к реальному DTO и сохраняет целевые индексы сервера', JSON.stringify(durakActionsForCard({ allowed }, 20)) === JSON.stringify(allowed.defend.map(move => ({ ...move, type: 'defend' }))));
check('запрещённая карта не создаёт хода', durakActionsForCard({ allowed }, 1).length === 0);
check('метки карт соответствуют масти и достоинству движка', durakCardLabel(0) === '2♣' && durakCardLabel(51) === 'A♠');

const privateView = { seat: 1, handCounts: [6, 5, 4], hands: [[0, 1], [20], [30]] };
const publicOpponentCounts = durakOpponentCounts(privateView);
check('игрок видит только счётчики соперников и не получает их значения карт', JSON.stringify(publicOpponentCounts) === JSON.stringify([{ seat: 0, count: 6 }, { seat: 2, count: 4 }]) && !('cards' in publicOpponentCounts[0]));
check('наблюдатель видит только публичные счётчики всех мест', JSON.stringify(durakOpponentCounts({ seat: -1, handCounts: [6, 5, 4] })) === JSON.stringify([{ seat: 0, count: 6 }, { seat: 1, count: 5 }, { seat: 2, count: 4 }]));

console.log(`✓ ${passed} проверок интерфейса и приватности Дурака`);
