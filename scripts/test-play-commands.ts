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

  console.log('\n10. Временный конфликт транзакции безопасно повторяется целиком');
  {
    const key = randomUUID();
    const body = { gameId: 'retry-test' };
    let runs = 0, attempts = 0;
    const originalTransaction = h.prisma.$transaction.bind(h.prisma);
    const transient = () => Object.assign(new Error('simulated write conflict'), { code: 'P2034' });
    h.prisma.$transaction = async (work: any, ...args: any[]) => {
      attempts++;
      return originalTransaction(async (tx: any) => {
        const result = await work(tx);
        if (attempts === 1) throw transient(); // Must roll back work and its receipt.
        return result;
      }, ...args);
    };
    const beforeParties = await h.prisma.playParty.count();
    let first: any;
    try {
      first = await runCommand({ actorId: actor, key, kind: 'party.create', body, work: async (tx: any) => {
        runs++;
        const partyId = randomUUID();
        await tx.playParty.create({ data: { id: partyId, leaderId: actor, gameId: 'retry-test' } });
        return { partyId };
      } });
    } finally {
      h.prisma.$transaction = originalTransaction;
    }
    const receiptRows = await h.prisma.playCommand.findMany({ where: { actorId: actor, key } });
    const afterParties = await h.prisma.playParty.count();
    ok('одна ошибка P2034 привела к успешному повтору', first?.ok && !first.repeated, first);
    ok('работа вызвана для двух попыток транзакции', runs === 2 && attempts === 2, { runs, attempts });
    ok('первая попытка откатилась, вторая оставила одну группу', afterParties === beforeParties + 1, { beforeParties, afterParties });
    ok('сохранена одна успешная расписка', receiptRows.length === 1 && receiptRows[0].status === 'OK', receiptRows.length);
    const replay = await runCommand({ actorId: actor, key, kind: 'party.create', body, work: async () => { runs++; return {}; } });
    ok('повтор ключа отдаёт расписку, не вызывая работу', replay.ok && replay.repeated && runs === 2, { replay, runs });
  }

  console.log('\n11. Повтор P2034 ограничен четырьмя попытками');
  {
    const key = randomUUID();
    let runs = 0, attempts = 0;
    const originalTransaction = h.prisma.$transaction.bind(h.prisma);
    h.prisma.$transaction = async (work: any, ...args: any[]) => {
      attempts++;
      return originalTransaction(async (tx: any) => {
        await work(tx);
        throw Object.assign(new Error('simulated persistent write conflict'), { code: 'P2034' });
      }, ...args);
    };
    const beforeParties = await h.prisma.playParty.count();
    let thrown: any;
    try {
      await runCommand({ actorId: actor, key, kind: 'party.create', body: { bounded: true }, work: async (tx: any) => {
        runs++;
        await tx.playParty.create({ data: { id: randomUUID(), leaderId: actor, gameId: 'bounded-retry' } });
        return { ok: true };
      } });
    } catch (error) { thrown = error; }
    finally { h.prisma.$transaction = originalTransaction; }
    const receipt = await h.prisma.playCommand.findFirst({ where: { actorId: actor, key } });
    ok('постоянный конфликт выбрасывает последнюю ошибку', thrown?.code === 'P2034', thrown?.code);
    ok('выполнено не больше четырёх попыток', attempts === 4 && runs === 4, { attempts, runs });
    ok('все откатившиеся попытки не оставили группу или расписку', await h.prisma.playParty.count() === beforeParties && !receipt);
  }

  console.log('\n12. Посторонняя ошибка не повторяется');
  {
    let attempts = 0, runs = 0;
    const originalTransaction = h.prisma.$transaction.bind(h.prisma);
    h.prisma.$transaction = async (work: any, ...args: any[]) => {
      attempts++;
      return originalTransaction(async (_tx: any) => {
        await work(_tx);
        throw Object.assign(new Error('simulated unrelated database failure'), { code: 'P2003' });
      }, ...args);
    };
    let thrown: any;
    try {
      await runCommand({ actorId: actor, key: randomUUID(), kind: 'x', body: {}, work: async () => { runs++; return 1; } });
    } catch (error) { thrown = error; }
    finally { h.prisma.$transaction = originalTransaction; }
    ok('посторонняя ошибка вернулась вызывающему коду', thrown?.code === 'P2003', thrown?.code);
    ok('посторонняя ошибка не вызвала повтор', attempts === 1 && runs === 1, { attempts, runs });
  }

  console.log('\n13. Появившаяся расписка проверяется до повтора работы');
  {
    const key = randomUUID();
    const body = { concurrent: true };
    const partyId = randomUUID();
    let attempts = 0, runs = 0;
    const originalTransaction = h.prisma.$transaction.bind(h.prisma);
    h.prisma.$transaction = async (work: any, ...args: any[]) => {
      attempts++;
      try {
        return await originalTransaction(async (tx: any) => {
          await work(tx);
          throw Object.assign(new Error('simulated concurrent write conflict'), { code: 'P2034' });
        }, ...args);
      } catch (error: any) {
        if (attempts === 1 && error?.code === 'P2034') {
          // Model the competing request committing after this attempt rolls back.
          await h.prisma.playParty.create({ data: { id: partyId, leaderId: actor, gameId: 'concurrent' } });
          await h.prisma.playCommand.create({ data: {
            id: randomUUID(), actorId: actor, key, requestHash: bodyHash(body), kind: 'party.create',
            status: 'OK', resultJson: JSON.stringify({ partyId }), expiresAt: new Date(Date.now() + 60_000),
          } });
        }
        throw error;
      }
    };
    let result: any;
    try {
      result = await runCommand({ actorId: actor, key, kind: 'party.create', body, work: async () => { runs++; return { partyId: randomUUID() }; } });
    } finally { h.prisma.$transaction = originalTransaction; }
    ok('найденная расписка возвращена как повтор', result?.ok && result.repeated && result.result?.partyId === partyId, result);
    ok('после конфликта работа не выполнялась второй раз', attempts === 1 && runs === 1, { attempts, runs });
    ok('состояние конкурирующей команды осталось единственным', await h.prisma.playParty.count({ where: { id: partyId } }) === 1);
  }

  await h.close();
  console.log(f === 0 ? '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ' : `\nПРОВАЛОВ: ${f}`);
  process.exit(f === 0 ? 0 : 1);
})();
