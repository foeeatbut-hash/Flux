/**
 * Присутствие не врёт: ни ложного «в сети», ни мигания «ушёл — пришёл».
 *
 * Две беды, из-за которых присутствию раньше нельзя было верить, и обе
 * проверяются здесь живьём, на настоящих таблицах:
 *
 *   1. **Беззвучный обрыв.** Сокет не закрывается, `disconnect` не приходит —
 *      и человек висит «онлайн» до перезапуска сервера. Лечится арендой:
 *      запись живёт до срока, продлевается сердцебиением и кончается сама.
 *   2. **Поздний disconnect.** Окно переподключилось, а `disconnect` старого
 *      соединения приходит ПОСЛЕ этого — и гасит уже живое. Лечится
 *      поколением: удаляется только своё.
 *
 * Плюс то, что ТЗ требует отдельно: четыре независимых состояния и
 * «невидимость», которую не отменяет забытый второй компьютер.
 *
 * Запуск: npx tsx scripts/test-play-presence.ts
 */
import { openHarness } from './playHarness';
import { connect, disconnect, heartbeat, isFresh, sweep, viewFor } from '../server/play/presence';
import { PLAY_LIMITS } from '../play/contracts';

let f = 0;
const ok = (n: string, c: boolean, d?: any) =>
  (c ? console.log('  ✓', n) : (f++, console.error('  ✗', n, d !== undefined ? JSON.stringify(d).slice(0, 300) : '')));

const only = (list: any[], userId: string) => list.find((r) => r.userId === userId);

(async () => {
  const h = await openHarness();

  console.log('1. Подключился — виден; не продлил — пропал сам');
  {
    await connect({ userId: 'u1', deviceId: 'd1', connectionId: 'c1' });
    const now = await viewFor(['u1']);
    ok('в сети', only(now, 'u1')?.status === 'ONLINE', now);

    // Аренда кончилась: никого не надо «выключать», запись перестаёт быть
    // действительной сама — ровно так и лечится беззвучный обрыв
    const later = new Date(Date.now() + PLAY_LIMITS.presenceLeaseMs + 1000);
    const after = await viewFor(['u1'], later);
    ok('после истечения аренды — не в сети', only(after, 'u1')?.status === 'OFFLINE', after);

    // И это правда даже до уборки: показанное обязано быть правдой в момент
    // показа, а не в момент последней уборки
    const left = await h.prisma.playPresence.count({ where: { connectionId: 'c1' } });
    ok('запись ещё лежит, но уже не показывается', left === 1, left);

    const swept = await sweep(later);
    ok('уборка её забрала', swept === 1, swept);
  }

  console.log('\n2. Сердцебиение продлевает аренду');
  {
    await connect({ userId: 'u2', deviceId: 'd1', connectionId: 'c2' });
    const before = await h.prisma.playPresence.findUnique({ where: { connectionId: 'c2' } });
    await new Promise((r) => setTimeout(r, 25));
    const alive = await heartbeat('c2');
    ok('запись жива', alive === true);
    const after = await h.prisma.playPresence.findUnique({ where: { connectionId: 'c2' } });
    ok('срок отодвинулся', new Date(after.expiresAt).getTime() > new Date(before.expiresAt).getTime(),
      { before: before.expiresAt, after: after.expiresAt });
  }

  console.log('\n3. Сердцебиение по исчезнувшей записи отвечает «нет»');
  {
    // Молчаливое «ничего не обновилось» здесь и есть ложный онлайн: окно
    // обязано узнать, что его больше нет, и переподключиться
    const alive = await heartbeat('нет-такого-соединения');
    ok('ответ отрицательный', alive === false);
  }

  console.log('\n4. Поздний disconnect старого поколения не гасит новое');
  {
    const gen1 = await connect({ userId: 'u3', deviceId: 'd1', connectionId: 'c3' });
    // Переподключение того же устройства: новое соединение, новое поколение
    const gen2 = await connect({ userId: 'u3', deviceId: 'd1', connectionId: 'c4' });
    ok('поколение выросло', gen2 === gen1 + 1, { gen1, gen2 });

    // …и только теперь пришёл disconnect первого
    const killedOld = await disconnect('c3', gen1);
    ok('своё соединение закрылось', killedOld === true);
    const view = await viewFor(['u3']);
    ok('человек остался в сети', only(view, 'u3')?.status === 'ONLINE', view);

    // А чужое поколение не закрывает ничего
    const wrong = await disconnect('c4', gen1);
    ok('чужое поколение ничего не гасит', wrong === false);
    const still = await viewFor(['u3']);
    ok('и человек по-прежнему в сети', only(still, 'u3')?.status === 'ONLINE', still);
  }

  console.log('\n5. Занятость берётся самая глубокая, а не последняя');
  {
    await connect({ userId: 'u4', deviceId: 'ноутбук', connectionId: 'c5' });
    await connect({ userId: 'u4', deviceId: 'телефон', connectionId: 'c6' });
    await heartbeat('c5', { activity: 'MATCH', gameId: 'testgame' });
    await heartbeat('c6', { activity: 'IDLE' });
    const view = only(await viewFor(['u4']), 'u4');
    ok('человек в матче', view?.activity === 'MATCH', view);
    ok('названа игра', view?.gameId === 'testgame', view);
    ok('устройств двое', view?.devices === 2, view);
  }

  console.log('\n6. «Не показываться» сильнее всего');
  {
    await connect({ userId: 'u5', deviceId: 'ноутбук', connectionId: 'c7', invisible: true });
    await connect({ userId: 'u5', deviceId: 'телефон', connectionId: 'c8' });
    const view = only(await viewFor(['u5']), 'u5');
    // Иначе невидимость, включённая на ноутбуке, отменялась бы забытым
    // телефоном — и человек оказался бы виден, думая, что скрыт
    ok('наружу — не в сети', view?.status === 'OFFLINE', view);
    ok('занятость не показывается', view?.activity === 'IDLE', view);
    ok('и число устройств не выдаёт его', view?.devices === 0, view);
  }

  console.log('\n7. «Отошёл» — когда отошли все устройства');
  {
    await connect({ userId: 'u6', deviceId: 'd1', connectionId: 'c9' });
    await connect({ userId: 'u6', deviceId: 'd2', connectionId: 'c10' });
    await heartbeat('c9', { status: 'AWAY' });
    ok('одно устройство активно — человек в сети', only(await viewFor(['u6']), 'u6')?.status === 'ONLINE');
    await heartbeat('c10', { status: 'AWAY' });
    ok('оба отошли — отошёл', only(await viewFor(['u6']), 'u6')?.status === 'AWAY');
  }

  console.log('\n8. Про кого не спрашивали — того и нет');
  {
    const view = await viewFor(['нет-такого']);
    ok('незнакомый — не в сети', view[0]?.status === 'OFFLINE', view);
    ok('пустой запрос — пустой ответ', (await viewFor([])).length === 0);
  }

  console.log('\n9. Предел устаревания взят из договора');
  {
    // Больше аренды на один интервал сердцебиения: один потерянный пакет — не
    // повод объявлять человека ушедшим, два подряд — уже повод
    ok('предел больше аренды', PLAY_LIMITS.staleAfterMs > PLAY_LIMITS.presenceLeaseMs);
    ok('ровно на интервал сердцебиения',
      PLAY_LIMITS.staleAfterMs - PLAY_LIMITS.presenceLeaseMs === PLAY_LIMITS.heartbeatMs / 2,
      PLAY_LIMITS.staleAfterMs - PLAY_LIMITS.presenceLeaseMs);
    const now = Date.now();
    ok('свежему верим', isFresh(now - 1000, now));
    ok('устаревшему — нет', !isFresh(now - PLAY_LIMITS.staleAfterMs - 1, now));
  }

  await h.close();
  console.log(f === 0 ? '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ' : `\nПРОВАЛОВ: ${f}`);
  process.exit(f === 0 ? 0 : 1);
})();
