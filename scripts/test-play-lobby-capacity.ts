/** Реальные таблицы: места, наблюдатели и безопасное переключение игры без удаления коллег. */
import assert from 'node:assert/strict';
import { openHarness } from './playHarness';
import { createParty, joinParty, leaveParty } from '../server/play/parties';
import { openLobby, setReady, setSeatLimit, syncSlots } from '../server/play/lobbies';
import { claimSession } from '../server/play/sessions';
async function main() {
  const harness = await openHarness();
  try {
    const prisma = harness.prisma;
    const party = await prisma.$transaction((tx: any) => createParty(tx, 'member-0', 'cards'));
    for (let i = 1; i < 10; i++) await prisma.$transaction((tx: any) => joinParty(tx, party.id, `member-${i}`));
    const count = async (role: string) => prisma.playPartyMember.count({ where: { partyId: party.id, leftAt: null, role } });
    assert.equal(await count('SPECTATOR'), 4); console.log('✓ Седьмой–десятый участники Дурака становятся наблюдателями');
    const first = await prisma.$transaction((tx: any) => openLobby(tx, party.id, 'member-0', 'cards'));
    assert.equal(first.seats, 2); assert.equal(first.slots.length, 2); assert.equal(await count('SPECTATOR'), 8); console.log('✓ Новая партия начинается с двух мест и лишние участники наблюдают');
    let configurable = first;
    for (const seats of [2, 3, 4, 5, 6]) {
      configurable = await prisma.$transaction((tx: any) => setSeatLimit(tx, first.id, 'member-0', seats, configurable.revision));
      assert.equal(configurable.seats, seats);
      assert.equal(configurable.slots.length, seats);
      assert.equal(await count('SPECTATOR'), 10 - seats);
      assert.equal(new Set(configurable.slots.map((slot: any) => slot.team)).size, seats);
      console.log(`✓ Выбор ${seats} мест пересчитывает игроков и зрителей`);
    }
    await assert.rejects(prisma.$transaction((tx: any) => setSeatLimit(tx, first.id, 'stranger', 4, configurable.revision))); console.log('✓ Чужой пользователь не меняет места в комнате');
    const pool = await prisma.$transaction((tx: any) => openLobby(tx, party.id, 'member-0', 'billiards'));
    assert.equal(pool.slots.length, 2); assert.equal(await count('SPECTATOR'), 8); assert.equal(await count('LEADER'), 1); console.log('✓ Переключение в бильярд сохраняет группу и оставляет два игровых места');
    const cards = await prisma.$transaction((tx: any) => openLobby(tx, party.id, 'member-0', 'cards'));
    assert.equal(cards.seats, 2); assert.equal(cards.slots.length, 2); assert.equal(await count('SPECTATOR'), 8); assert.ok(cards.slots.every((slot: any) => !slot.ready)); console.log('✓ Возвращение в Дурака начинает с двух мест и сбрасывает готовность');
    await prisma.$transaction(async (tx: any) => { await leaveParty(tx, party.id, 'member-1'); await syncSlots(tx, cards.id); });
    await prisma.$transaction(async (tx: any) => { await joinParty(tx, party.id, 'new-player'); await syncSlots(tx, cards.id); });
    const newPlayer = await prisma.playPartyMember.findFirst({ where: { partyId: party.id, userId: 'new-player', leftAt: null } });
    assert.equal(newPlayer.role, 'SPECTATOR'); assert.equal((await prisma.playLobbySlot.count({ where: { lobbyId: cards.id } })), 2); console.log('✓ Новое приглашение сохраняет членство, но не превышает выбранные места');
    for (const participants of [2, 3, 4, 5, 6]) {
      const isolated = await prisma.$transaction((tx: any) => createParty(tx, `sizer-${participants}-0`, 'cards'));
      for (let i = 1; i < participants; i++) await prisma.$transaction((tx: any) => joinParty(tx, isolated.id, `sizer-${participants}-${i}`));
      const room = await prisma.$transaction((tx: any) => openLobby(tx, isolated.id, `sizer-${participants}-0`, 'cards', participants));
      assert.equal(room.seats, participants); assert.equal(room.slots.length, participants);
    }
    console.log('✓ Комнаты с 2–6 реальными участниками создаются с выбранным числом мест');
    const incompleteParty = await prisma.$transaction((tx: any) => createParty(tx, 'partial-0', 'cards'));
    await prisma.$transaction((tx: any) => joinParty(tx, incompleteParty.id, 'partial-1'));
    const incompleteRoom = await prisma.$transaction((tx: any) => openLobby(tx, incompleteParty.id, 'partial-0', 'cards', 3));
    let readyRoom = incompleteRoom;
    for (const userId of ['partial-0', 'partial-1']) readyRoom = await prisma.$transaction((tx: any) => setReady(tx, incompleteRoom.id, userId, true, readyRoom.revision));
    await assert.rejects(prisma.$transaction((tx: any) => claimSession(tx, incompleteRoom.id, 'partial-0', readyRoom.revision)));
    assert.equal(await prisma.playSession.count({ where: { lobbyId: incompleteRoom.id } }), 0);
    console.log('✓ Готовые два игрока не запускают комнату, где выбрано три места');
    assert.equal(await prisma.playPartyMember.count({ where: { partyId: party.id } }), 11); console.log('✓ История вступления и выхода сохранена, записи участников не удаляются');
  } finally { await harness.close(); }
}
main().catch(error => { console.error(error); process.exit(1); });
