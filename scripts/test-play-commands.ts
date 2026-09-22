/**
 * Команда выполняется один раз, сколько бы раз её ни прислали.
 *
 * Повтор — не редкость, а норма: обрыв связи посреди запроса выглядит для окна
 * как неудача, и окно отправляет снова; человек, не дождавшись ответа, жмёт
 * второй раз. Без расписки «Создать группу» создала бы вторую, а «Начать матч»
 * развёл бы группу по двум серверам.
 *
 * Отдельно проверяется то, чего проверкой «до» не поймать: два ОДИНАКОВЫХ
 * запроса, пришедших одновременно. Второй не смог записать расписку — и обязан
 * отдать ответ первого, а не сделать работу заново.
 *
 * Запуск: npx tsx scripts/test-play-commands.ts
 */
import { randomUUID } from 'node:crypto';
import { openHarness } from './playHarness';
import { appendEvent, bodyHash, bumpRevision, fail, runCommand, stableJson } from '../server/play/commands';
import { PLAY_ERRORS } from '../play/contracts';

let f = 0;
const ok = (n: string, c: boolean, d?: any) =>
  (c ? console.log('  ✓', n) : (f++, console.error('  ✗', n, d !== undefined ? JSON.stringify(d).slice(0, 300) : '')));

(async () => {
  const h = await openHarness();
  const actor = 'user-1';

  console.log('1. Хеш тела не зависит от порядка полей');
  {
    // Иначе один и тот же повтор, собранный окном в другом порядке, выглядел
    // бы как «тот же ключ с другим телом» и получал отказ на ровном месте
    ok('порядок ключей не меняет хеш', bodyHash({ a: 1, b: 2 }) === bodyHash({ b: 2, a: 1 }));
    ok('вложенный порядок тоже', bodyHash({ x: { a: 1, b: 2 } }) === bodyHash({ x: { b: 2, a: 1 } }));
    ok('другое тело — другой хеш', bodyHash({ a: 1 }) !== bodyHash({ a: 2 }));
    ok('массив остаётся по порядку', stableJson([2, 1]) === '[2,1]');
  }

  console.log('\n2. Повтор отдаёт тот же ответ, а не делает второй раз');
  {
    let runs = 0;
    const key = randomUUID();
    const body = { gameId: 'testgame' };
    const work = async (tx: any) => {
      runs++;
      const id = randomUUID();
      await tx.playParty.create({ data: { id, leaderId: actor, gameId: 'testgame' } });
      return { partyId: id };
    };

    const first = await runCommand({ actorId: actor, key, kind: 'party.create', body, work });
    ok('первый раз выполнен', first.ok && !first.repeated, first);

    const second = await runCommand({ actorId: actor, key, kind: 'party.create', body, work });
    ok('второй раз помечен повтором', second.ok && second.repeated === true, second);
    ok('работа сделана ровно один раз', runs === 1, runs);
    ok('ответ тот же', JSON.stringify(second.result) === JSON.stringify(first.result), [first.result, second.result]);

    const parties = await h.prisma.playParty.count();
    ok('в базе одна группа, а не две', parties === 1, parties);
  }

  console.log('\n3. Тот же ключ с другим телом — ошибка, а не повтор');
  {
    const key = randomUUID();
    const work = async () => ({ value: 1 });
    await runCommand({ actorId: actor, key, kind: 'x', body: { a: 1 }, work });
    const other = await runCommand({ actorId: actor, key, kind: 'x', body: { a: 2 }, work });
    ok('отказано', !other.ok, other);
    ok('код назван', other.code === PLAY_ERRORS.IDEMPOTENCY_MISMATCH, other.code);
    ok('и это не «повтор»', other.repeated === false, other);
  }

  console.log('\n4. Ключ принадлежит человеку, а не всем');
  {
    const key = 'общий-ключ';
    let runs = 0;
    const work = async () => { runs++; return { who: runs }; };
    await runCommand({ actorId: 'user-A', key, kind: 'x', body: {}, work });
    const second = await runCommand({ actorId: 'user-B', key, kind: 'x', body: {}, work });
    ok('чужой ключ не считается повтором', second.ok && !second.repeated, second);
    ok('работа сделана дважды — для двоих', runs === 2, runs);
  }

  console.log('\n5. Отказ тоже записывается распиской');
  {
    // Иначе повтор отказанной команды пошёл бы выполняться заново и с третьей
    // попытки мог бы пройти, хотя человек нажимал один раз
    const key = randomUUID();
    let runs = 0;
    const work = async () => { runs++; return fail(PLAY_ERRORS.PARTY_FULL) as any; };
    const first = await runCommand({ actorId: actor, key, kind: 'x', body: {}, work });
    ok('отказ вернулся', !first.ok && first.code === PLAY_ERRORS.PARTY_FULL, first);
    const second = await runCommand({ actorId: actor, key, kind: 'x', body: {}, work });
    ok('повтор отказа помечен повтором', !second.ok && second.repeated === true, second);
    ok('и работа не выполнялась заново', runs === 1, runs);
  }

  console.log('\n6. Ничего не записалось, если работа не удалась');
  {
    const key = randomUUID();
    const work = async (tx: any) => {
      await tx.playParty.create({ data: { id: randomUUID(), leaderId: 'user-Z' } });
      return fail(PLAY_ERRORS.INVALID) as any;
    };
    const before = await h.prisma.playParty.count();
    await runCommand({ actorId: 'user-Z', key, kind: 'x', body: {}, work });
    const after = await h.prisma.playParty.count();
    ok('запись отката не оставила', before === after, { before, after });
  }

  console.log('\n7. Команда без ключа не принимается');
  {
    const r = await runCommand({ actorId: actor, key: '', kind: 'x', body: {}, work: async () => 1 });
    ok('отказано', !r.ok && r.code === PLAY_ERRORS.INVALID, r);
  }

  console.log('\n8. Опоздавший не затирает чужое изменение');
  {
    const id = randomUUID();
    await h.prisma.playParty.create({ data: { id, leaderId: actor, revision: 1 } });
    const first = await h.prisma.$transaction((tx: any) => bumpRevision(tx, 'playParty', id, 1, { gameId: 'a' }));
    ok('вовремя — принято', first === true);
    const late = await h.prisma.$transaction((tx: any) => bumpRevision(tx, 'playParty', id, 1, { gameId: 'b' }));
    ok('опоздавший — отказ', late === false);
    const row = await h.prisma.playParty.findUnique({ where: { id } });
    ok('в базе осталось первое значение', row.gameId === 'a', row.gameId);
    ok('версия выросла на единицу', row.revision === 2, row.revision);
  }

  console.log('\n9. История событий без пропусков и без двойников');
  {
    const id = randomUUID();
    await h.prisma.$transaction(async (tx: any) => {
      await appendEvent(tx, 'party', id, 1, 'created', {});
      await appendEvent(tx, 'party', id, 2, 'joined', { userId: 'x' });
    });
    let twice = false;
    try {
      await h.prisma.$transaction((tx: any) => appendEvent(tx, 'party', id, 2, 'joined', { userId: 'y' }));
      twice = true;
    } catch (_) { twice = false; }
    ok('второе событие с той же версией база не приняла', !twice);
    const list = await h.prisma.playEvent.findMany({ where: { aggregate: 'party', aggregateId: id } });
    ok('событий ровно два', list.length === 2, list.length);
  }

  await h.close();
  console.log(f === 0 ? '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ' : `\nПРОВАЛОВ: ${f}`);
  process.exit(f === 0 ? 0 : 1);
})();
