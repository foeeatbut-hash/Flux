/** Реальные таблицы: места, наблюдатели и безопасное переключение игры без удаления коллег. */
import assert from 'node:assert/strict';
import { openHarness } from './playHarness';
import { createParty, joinParty, leaveParty } from '../server/play/parties';
import { openLobby, syncSlots } from '../server/play/lobbies';
async function main() {
  const harness = await openHarness();
  try {
    const prisma = harness.prisma;
    const party = await prisma.$transaction((tx: any) => createParty(tx, 'member-0', 'cards'));
    for (let i = 1; i < 10; i++) await prisma.$transaction((tx: any) => joinParty(tx, party.id, `member-${i}`));
    const count = async (role: string) => prisma.playPartyMember.count({ where: { partyId: party.id, leftAt: null, role } });
    assert.equal(await count('SPECTATOR'), 2); console.log('✓ Девятый и десятый участники Дурака становятся наблюдателями');
    const first = await prisma.$transaction((tx: any) => openLobby(tx, party.id, 'member-0', 'cards'));
    assert.equal(first.slots.length, 8); assert.equal(new Set(first.slots.map((slot: any) => slot.team)).size, 8); console.log('✓ Восемь самостоятельных мест, наблюдатели не занимают игровое место');
    const pool = await prisma.$transaction((tx: any) => openLobby(tx, party.id, 'member-0', 'billiards'));
    assert.equal(pool.slots.length, 2); assert.equal(await count('SPECTATOR'), 8); assert.equal(await count('LEADER'), 1); console.log('✓ Переключение в бильярд сохраняет группу и оставляет два игровых места');
    const cards = await prisma.$transaction((tx: any) => openLobby(tx, party.id, 'member-0', 'cards'));
    assert.equal(cards.slots.length, 8); assert.equal(await count('SPECTATOR'), 2); assert.ok(cards.slots.every((slot: any) => !slot.ready)); console.log('✓ Возвращение в Дурака восстанавливает восемь мест и сбрасывает готовность');
    await prisma.$transaction(async (tx: any) => { await leaveParty(tx, party.id, 'member-1'); await syncSlots(tx, cards.id); });
    await prisma.$transaction(async (tx: any) => { await joinParty(tx, party.id, 'new-player'); await syncSlots(tx, cards.id); });
    const newPlayer = await prisma.playPartyMember.findFirst({ where: { partyId: party.id, userId: 'new-player', leftAt: null } });
    assert.equal(newPlayer.role, 'MEMBER'); console.log('✓ Новое приглашение занимает свободное место, даже когда есть наблюдатели');
    assert.equal(await prisma.playPartyMember.count({ where: { partyId: party.id } }), 11); console.log('✓ История вступления и выхода сохранена, записи участников не удаляются');
  } finally { await harness.close(); }
}
main().catch(error => { console.error(error); process.exit(1); });
