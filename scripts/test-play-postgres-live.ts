/**
 * Правила платформы держит настоящая PostgreSQL, а не наши намерения.
 *
 * Все инварианты платформы — «одна активная группа на человека», «одно живое
 * лобби на группу», «один незавершённый матч на лобби» — записаны частичными
 * уникальными индексами. На SQLite это уже проверено остальными наборами;
 * здесь проверяется рабочая база, потому что именно на ней эти индексы и
 * должны сработать, а «почти такой же SQL» у движков не бывает.
 *
 * Проверка идёт ВТОРОЙ вставкой, а не чтением схемы. Прочитать имя индекса
 * мало: индекс без условия или по другой колонке читается так же, а работает
 * иначе. Здесь база обязана отказать — и отказ считается успехом.
 *
 * Адрес базы берётся из окружения и не пишется в код: строкам подключения и
 * паролям в репозитории не место.
 *
 *   FLUX_PG_URL=postgresql://… npx tsx scripts/test-play-postgres-live.ts
 *
 * Нет адреса — проверка честно говорит «не проверено» и не притворяется
 * пройденной.
 */
import { randomUUID } from 'node:crypto';
import { setPrisma } from '../server/context';
import { setDialect } from '../server/ddl';
import { ensurePlayTables, resetPlayTables } from '../server/play/tables';

const URL_ENV = process.env.FLUX_PG_URL || '';

let f = 0;
const ok = (n: string, c: boolean, d?: any) =>
  (c ? console.log('  ✓', n) : (f++, console.error('  ✗', n, d !== undefined ? JSON.stringify(d).slice(0, 300) : '')));

/** Вставка, которая обязана не пройти. Прошла — правило не работает. */
async function refused(what: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
    ok(what, false, 'база приняла вторую запись');
  } catch (_) {
    ok(what, true);
  }
}

(async () => {
  if (!URL_ENV) {
    console.log('· НЕ ПРОВЕРЕНО: адрес PostgreSQL не задан (FLUX_PG_URL).');
    console.log('  Проверка требует живой базы и не подменяется ничем: правила');
    console.log('  держит движок, и «на SQLite работало» здесь ничего не значит.');
    process.exit(0);
  }

  const { PrismaClient } = require('@prisma/client-pg');
  const { PrismaPg } = require('@prisma/adapter-pg');
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: URL_ENV }) });

  setDialect('postgresql');
  setPrisma(prisma);
  resetPlayTables();

  console.log('1. Таблицы и индексы создаются на живой базе');
  {
    const failure = await ensurePlayTables(prisma, (m) => console.log('   ·', m));
    ok('страховка отработала без беды', failure === '', failure);
  }

  console.log('\n2. Частичные индексы существуют и с условиями');
  {
    const rows: any[] = await prisma.$queryRawUnsafe(
      `SELECT indexname, indexdef FROM pg_indexes WHERE indexname LIKE 'Play%' AND indexdef LIKE '%WHERE%'`,
    );
    const byName = new Map(rows.map((r) => [String(r.indexname), String(r.indexdef)]));
    for (const name of [
      'PlayPartyMember_one_active_key', 'PlayPartyMember_pair_key',
      'PlayInvite_pending_key', 'PlayLobby_active_key',
      'PlaySession_active_key', 'PlaySessionMember_one_active_key',
    ]) {
      ok(`${name} — частичный`, byName.has(name), [...byName.keys()]);
    }
  }

  // Своя песочница на каждый прогон: проверка не должна зависеть от того,
  // что осталось от прошлой, и не должна оставлять мусор после себя
  const mark = randomUUID().slice(0, 8);
  const userId = `проверка-${mark}`;
  const partyId = `party-${mark}`;
  const otherParty = `party2-${mark}`;
  const lobbyId = `lobby-${mark}`;
  const sessionId = `session-${mark}`;

  console.log('\n3. Человек одновременно в одной группе');
  {
    await prisma.playParty.create({ data: { id: partyId, leaderId: userId } });
    await prisma.playParty.create({ data: { id: otherParty, leaderId: userId } });
    await prisma.playPartyMember.create({ data: { id: randomUUID(), partyId, userId, role: 'LEADER' } });
    await refused('вторая живая группа не заводится', () => prisma.playPartyMember.create({
      data: { id: randomUUID(), partyId: otherParty, userId },
    }));

    // Но вышел — значит вышел: вторая игра в жизни человеку разрешена
    await prisma.playPartyMember.updateMany({ where: { partyId, userId }, data: { leftAt: new Date() } });
    const again = await prisma.playPartyMember.create({
      data: { id: randomUUID(), partyId: otherParty, userId },
    });
    ok('после выхода в другую группу можно', !!again?.id);
  }

  console.log('\n4. Одно живое приглашение на пару');
  {
    const to = `гость-${mark}`;
    await prisma.playInvite.create({
      data: { id: randomUUID(), partyId, fromUserId: userId, toUserId: to, expiresAt: new Date(Date.now() + 60000) },
    });
    await refused('второе приглашение тому же не заводится', () => prisma.playInvite.create({
      data: { id: randomUUID(), partyId, fromUserId: userId, toUserId: to, expiresAt: new Date(Date.now() + 60000) },
    }));

    // Отказался — можно позвать снова: запрет на «второе живое», а не «второе»
    await prisma.playInvite.updateMany({ where: { partyId, toUserId: to }, data: { state: 'DECLINED' } });
    const twice = await prisma.playInvite.create({
      data: { id: randomUUID(), partyId, fromUserId: userId, toUserId: to, expiresAt: new Date(Date.now() + 60000) },
    });
    ok('после отказа позвать можно снова', !!twice?.id);
  }

  console.log('\n5. Одно живое лобби на группу и один матч на лобби');
  {
    await prisma.playLobby.create({ data: { id: lobbyId, partyId, gameId: 'testgame' } });
    await refused('второе лобби не заводится', () => prisma.playLobby.create({
      data: { id: `${lobbyId}-2`, partyId, gameId: 'testgame' },
    }));

    await prisma.playSession.create({ data: { id: sessionId, lobbyId, gameId: 'testgame' } });
    await refused('второй матч по тому же лобби не заводится', () => prisma.playSession.create({
      data: { id: `${sessionId}-2`, lobbyId, gameId: 'testgame' },
    }));

    // Матч кончился — следующий по тому же лобби разрешён (это и есть Rematch)
    await prisma.playSession.update({ where: { id: sessionId }, data: { state: 'FINISHED' } });
    const rematch = await prisma.playSession.create({
      data: { id: `${sessionId}-3`, lobbyId, gameId: 'testgame' },
    });
    ok('после завершения матча возможен следующий', !!rematch?.id);
  }

  console.log('\n6. Человек не бывает в двух незавершённых матчах');
  {
    await prisma.playSessionMember.create({
      data: { id: randomUUID(), sessionId: `${sessionId}-3`, userId, state: 'ACTIVE' },
    });
    await prisma.playSession.create({ data: { id: `${sessionId}-4`, lobbyId: `${lobbyId}-чужое`, gameId: 'testgame' } });
    await refused('второе место в матче не выдаётся', () => prisma.playSessionMember.create({
      data: { id: randomUUID(), sessionId: `${sessionId}-4`, userId, state: 'ACTIVE' },
    }));
  }

  console.log('\n7. Один результат на матч');
  {
    await prisma.playResult.create({ data: { id: randomUUID(), sessionId, payloadJson: '{"score":1}' } });
    await refused('второй результат не принимается', () => prisma.playResult.create({
      data: { id: randomUUID(), sessionId, payloadJson: '{"score":2}' },
    }));
  }

  console.log('\n8. Прибираем за собой');
  {
    // Проверка не должна оставлять следов: база рабочая, и мусор в ней
    // однажды примут за настоящие данные
    await prisma.playResult.deleteMany({ where: { sessionId: { contains: mark } } });
    await prisma.playSessionMember.deleteMany({ where: { userId } });
    await prisma.playSession.deleteMany({ where: { id: { contains: mark } } });
    await prisma.playLobby.deleteMany({ where: { id: { contains: mark } } });
    await prisma.playInvite.deleteMany({ where: { partyId: { contains: mark } } });
    await prisma.playPartyMember.deleteMany({ where: { userId } });
    await prisma.playParty.deleteMany({ where: { leaderId: userId } });
    const left = await prisma.playParty.count({ where: { leaderId: userId } });
    ok('следов не осталось', left === 0, left);
  }

  await prisma.$disconnect();
  console.log(f === 0 ? '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ' : `\nПРОВАЛОВ: ${f}`);
  process.exit(f === 0 ? 0 : 1);
})();
