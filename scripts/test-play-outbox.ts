/**
 * Очередь доставки: сообщение не теряется и не приходит дважды.
 *
 * Сокет, толкнутый сразу после записи, теряется ровно в тот момент, когда это
 * дороже всего: транзакция прошла, связь отвалилась, и половина группы не
 * узнала, что матч начался. Поэтому запись в очередь идёт в ТОЙ ЖЕ
 * транзакции, что и само изменение, а разбирает очередь отдельный проход.
 *
 * Проверяется ровно то, что ломается в бою:
 *
 *   — сообщение, поставленное в откатившейся транзакции, не уходит вовсе;
 *   — повтор постановки с тем же ключом не заводит второго сообщения;
 *   — запись, взятая в аренду, не достаётся второму проходу;
 *   — сообщение с отложенным сроком до него не уходит.
 *
 * Запуск: npx tsx scripts/test-play-outbox.ts
 */
import { randomUUID } from 'node:crypto';
import { openHarness } from './playHarness';
import { enqueue, fail, runCommand } from '../server/play/commands';
import { drainPlayOutbox } from '../server/play/outbox';
import { PLAY_ERRORS } from '../play/contracts';

let f = 0;
const ok = (n: string, c: boolean, d?: any) =>
  (c ? console.log('  ✓', n) : (f++, console.error('  ✗', n, d !== undefined ? JSON.stringify(d).slice(0, 300) : '')));

(async () => {
  const h = await openHarness();

  console.log('1. Сообщение ставится вместе с изменением и уходит после');
  {
    const key = randomUUID();
    await runCommand({
      actorId: 'a', key, kind: 'x', body: {},
      work: async (tx: any) => {
        await tx.playParty.create({ data: { id: 'p1', leaderId: 'a' } });
        await enqueue(tx, 'p1:created:b', 'b', 'party', { partyId: 'p1' });
        return { ok: true };
      },
    });
    ok('до прохода никому ничего не ушло', h.pushed.length === 0, h.pushed.length);
    const sent = await drainPlayOutbox();
    ok('проход отправил одно', sent === 1, sent);
    ok('и оно дошло до получателя', h.pushed[0]?.userId === 'b', h.pushed[0]);
    ok('имя события с приставкой платформы', h.pushed[0]?.event === 'play:party', h.pushed[0]?.event);
  }

  console.log('\n2. Второй проход не отправляет то же самое ещё раз');
  {
    const before = h.pushed.length;
    const sent = await drainPlayOutbox();
    ok('отправлять нечего', sent === 0, sent);
    ok('и ничего не ушло', h.pushed.length === before, h.pushed.length);
  }

  console.log('\n3. Откат транзакции уносит и сообщение');
  {
    const key = randomUUID();
    await runCommand({
      actorId: 'a', key, kind: 'x', body: {},
      work: async (tx: any) => {
        await enqueue(tx, 'rollback:b', 'b', 'party', {});
        return fail(PLAY_ERRORS.INVALID) as any;
      },
    });
    const left = await h.prisma.playOutbox.count({ where: { dedupeKey: 'rollback:b' } });
    ok('сообщения нет в очереди', left === 0, left);
    const sent = await drainPlayOutbox();
    ok('и отправлять нечего', sent === 0, sent);
  }

  console.log('\n4. Повтор постановки не заводит второго сообщения');
  {
    await h.prisma.$transaction(async (tx: any) => {
      await enqueue(tx, 'twice:b', 'b', 'lobby', { n: 1 });
      await enqueue(tx, 'twice:b', 'b', 'lobby', { n: 2 });
    });
    const rows = await h.prisma.playOutbox.count({ where: { dedupeKey: 'twice:b' } });
    ok('в очереди одна запись', rows === 1, rows);
    const before = h.pushed.length;
    await drainPlayOutbox();
    ok('и ушло одно сообщение', h.pushed.length === before + 1, h.pushed.length - before);
  }

  console.log('\n5. Отложенное не уходит раньше срока');
  {
    await h.prisma.playOutbox.create({
      data: {
        id: randomUUID(), dedupeKey: 'later:b', recipientId: 'b', kind: 'session',
        payloadJson: '{}', availableAt: new Date(Date.now() + 60_000),
      },
    });
    const sent = await drainPlayOutbox();
    ok('проход его не взял', sent === 0, sent);
    // Срок наступил — уходит
    await h.prisma.playOutbox.update({ where: { dedupeKey: 'later:b' }, data: { availableAt: new Date(Date.now() - 1000) } });
    const now = await drainPlayOutbox();
    ok('после срока ушло', now === 1, now);
  }

  console.log('\n6. Чужая аренда чужую запись не отдаёт');
  {
    // Два сервера на одной базе: запись, взятая одним, не должна достаться
    // второму — иначе одно и то же разошлось бы дважды
    await h.prisma.playOutbox.create({
      data: {
        id: randomUUID(), dedupeKey: 'leased:b', recipientId: 'b', kind: 'party',
        payloadJson: '{}', leaseOwner: 'чужой-сервер', leaseUntil: new Date(Date.now() + 60_000),
      },
    });
    const sent = await drainPlayOutbox();
    ok('запись под чужой арендой не взята', sent === 0, sent);

    // Аренда кончилась — запись подбирает любой: так сбой сервера не теряет
    // сообщение навсегда
    await h.prisma.playOutbox.update({
      where: { dedupeKey: 'leased:b' }, data: { leaseUntil: new Date(Date.now() - 1000) },
    });
    const after = await drainPlayOutbox();
    ok('после истечения аренды взята', after === 1, after);
  }

  console.log('\n7. Тело сообщения доезжает целиком');
  {
    await h.prisma.$transaction((tx: any) => enqueue(tx, 'body:b', 'b', 'invite', { from: 'Иванов', n: 7 }));
    await drainPlayOutbox();
    const last = h.pushed[h.pushed.length - 1];
    ok('получатель верный', last?.userId === 'b', last);
    ok('поля на месте', last?.payload?.from === 'Иванов' && last?.payload?.n === 7, last?.payload);
  }

  await h.close();
  console.log(f === 0 ? '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ' : `\nПРОВАЛОВ: ${f}`);
  process.exit(f === 0 ? 0 : 1);
})();
