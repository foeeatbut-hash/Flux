/**
 * Проверки присутствия: кто в сети.
 *
 * Ошибка здесь не падает и не мигает — она врёт. Человек видит зелёную точку у
 * того, кто ушёл час назад, пишет ему и ждёт ответа; или наоборот, не видит
 * точки у того, кто сидит рядом. Поэтому счёт сокетов, подпись «был(а)…» и
 * поведение при обрыве связи проверяются отдельно от разметки.
 *
 * Запуск: npx tsx scripts/test-presence.ts
 */
import { readFileSync } from 'fs';
import { usePresenceStore, presenceLabel } from '../src/store/presenceStore';

let failed = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  if (cond) return;
  failed++;
  console.error(`  ✗ ${name}${got === undefined ? '' : ` — получили ${JSON.stringify(got)}`}`);
};

const st = () => usePresenceStore.getState();

console.log('Список присутствия');
{
  st().setList(['u1', 'u2', 'u1'], { u3: 1000 });
  check('повторы схлопываются', st().online.length === 2, st().online);
  check('в сети — те, кого прислали', st().isOnline('u1') && st().isOnline('u2'));
  check('остальные не в сети', !st().isOnline('u3'));
  check('когда видели — запомнено', st().seenAt('u3') === 1000);
  check('пустой идентификатор никогда не в сети', !st().isOnline(''));

  st().setOnline('u3');
  check('пришедший добавился', st().isOnline('u3'));
  st().setOnline('u3');
  check('повторное появление не задваивает', st().online.filter((x) => x === 'u3').length === 1);

  st().setOffline('u1', 5000);
  check('ушедший убран из списка', !st().isOnline('u1'));
  check('время ухода записано', st().seenAt('u1') === 5000);
}

console.log('Обрыв связи');
{
  st().setList(['u1', 'u2'], {});
  st().reset();
  check('без связи никто не показан в сети', st().online.length === 0);
  // «Был(а) в …» остаётся: это по-прежнему правда, в отличие от «в сети»
  check('прошлое присутствие не стёрто', st().seenAt('u1') === 5000);
}

console.log('Подпись под именем');
{
  const now = Date.parse('2026-09-02T12:00:00Z');
  check('в сети', presenceLabel(true, null, now) === 'в сети');
  check('неизвестно — не в сети, а не пусто', presenceLabel(false, null, now) === 'не в сети');
  check('только что', presenceLabel(false, now - 30_000, now) === 'был(а) только что');
  check('минуты', presenceLabel(false, now - 12 * 60_000, now) === 'был(а) 12 мин. назад');
  check('часы', presenceLabel(false, now - 3 * 3600_000, now) === 'был(а) 3 ч. назад');
  check('вчера', presenceLabel(false, now - 30 * 3600_000, now) === 'был(а) вчера');
  check('дни', presenceLabel(false, now - 3 * 24 * 3600_000, now) === 'был(а) 3 дн. назад');
  check('давно', presenceLabel(false, now - 40 * 24 * 3600_000, now) === 'давно не заходил(а)');
  check('точного времени не показываем нигде',
    !['12:00', '2026'].some((x) => presenceLabel(false, now - 60_000, now).includes(x)));
}

console.log('Сервер считает сокеты, а не людей');
{
  // Подключения сокетов вынесены из server.ts в server/sockets.ts: читаем оба файла
  const src = readFileSync(new URL('../server.ts', import.meta.url), 'utf8')
    + readFileSync(new URL('../server/sockets.ts', import.meta.url), 'utf8');
  check('присутствие ведётся по набору сокетов', /const online = new Map<string, Set<string>>\(\)/.test(src));
  check('появление объявляется только для первого сокета',
    /online\.set\(uid, new Set\(\[socket\.id\]\)\);\s*[\s\S]{0,400}?io\.emit\('presence:online'/.test(src));
  check('уход объявляется, когда ушёл последний сокет',
    /if \(set && set\.size === 0\)[\s\S]{0,500}?io\.emit\('presence:offline'/.test(src));
  check('вошедшему выдаётся весь список', /socket\.emit\('presence:list'/.test(src));
  check('администратор не исключён из присутствия',
    !/presence[\s\S]{0,200}role\s*!==?\s*'ADMIN'/.test(src));

  const chat = readFileSync(new URL('../src/screens/ChatManagement.tsx', import.meta.url), 'utf8');
  check('чат показывает присутствие', chat.includes('presenceLabel') && chat.includes('onlineIds'));
  const users = readFileSync(new URL('../src/screens/UsersManagement.tsx', import.meta.url), 'utf8');
  check('список сотрудников показывает присутствие', users.includes('onlineIds.includes(emp.id)'));
}


// ── Присутствие в общей базе ────────────────────────────────────────────────
// Добавлено по случаю у заказчика: в отделе база одна, а сервер у каждого свой,
// встроенный. Пока присутствие жило в памяти сервера, каждый сидел в своей
// комнате один и все были для него «не в сети». Теперь свежесть отметки решает
// всё, и числа здесь важнее кода.
import { isFresh, rosterOf, mergeLocal, hideFrom, lastLoginLabel, BEAT_MS, FRESH_MS } from '../src/lib/presenceTime';

console.log('Свежесть отметки');
{
  const now = 1_700_000_000_000;
  check('только что отмеченный — в сети', isFresh(now - 1000, now));
  check('один пропущенный удар не гасит', isFresh(now - BEAT_MS - 500, now));
  check('два пропущенных подряд гасят', !isFresh(now - BEAT_MS * 3 - 1, now));
  check('срок свежести втрое больше удара', FRESH_MS === BEAT_MS * 3);
  check('отметки нет — не в сети', !isFresh(null, now) && !isFresh(undefined, now));
  check('мусор вместо времени не роняет проверку', !isFresh('не дата', now));
  check('строка времени понимается', isFresh(new Date(now - 1000).toISOString(), now));
  check('спешащие часы соседа не гасят человека', isFresh(now + 60_000, now));
}

console.log('Список из отметок базы');
{
  const now = 1_700_000_000_000;
  const r = rosterOf([
    { userId: 'a', at: now - 2000 },
    { userId: 'b', at: now - FRESH_MS - 1000 },
    { userId: '', at: now },
    { userId: 'c', at: 'не дата' },
  ], now);
  check('свежий попал в «в сети»', r.online.includes('a'), r.online);
  check('давний не попал', !r.online.includes('b'), r.online);
  check('про давнего известно, когда его видели', r.lastSeen.b === now - FRESH_MS - 1000);
  check('запись без человека отброшена', !r.online.includes(''), r.online);
  check('битое время не создаёт записи', !('c' in r.lastSeen), r.lastSeen);
  check('пустая база — пустой список', rosterOf([], now).online.length === 0);
}

console.log('Свои и чужие вместе');
{
  check('свои добавляются к тем, кто виден по базе',
    mergeLocal(['a'], ['b']).sort().join() === 'a,b');
  check('повтор не удваивает', mergeLocal(['a'], ['a']).join() === 'a');
  check('пустые не попадают', mergeLocal([], ['']).length === 0);
}

console.log('Скрытое присутствие');
{
  const roster = { online: ['a', 'b', 'c'], lastSeen: { a: 10, b: 20, c: 30 } };

  const seen = hideFrom(roster, ['b']);
  check('скрытого нет среди тех, кто в сети', !seen.online.includes('b'), seen.online);
  // Половинчатое скрытие не скрывает ничего: «был(а) минуту назад» отвечает на
  // тот же вопрос, что и зелёная точка
  check('и когда его видели — тоже не видно', !('b' in seen.lastSeen), seen.lastSeen);
  check('остальных это не касается',
    seen.online.join() === 'a,c' && seen.lastSeen.a === 10 && seen.lastSeen.c === 30, seen);

  const mine = hideFrom(roster, ['b'], 'b');
  check('себя скрывший видит: иначе он решит, что связи нет', mine.online.includes('b'), mine.online);
  check('и своё время тоже', mine.lastSeen.b === 20, mine.lastSeen);

  check('скрывать некого — список тот же объект', hideFrom(roster, []) === roster);
  check('скрыт не пойми кто — список не портится',
    hideFrom(roster, ['нет-такого']).online.join() === 'a,b,c');
}

console.log('Когда заходил последний раз');
{
  const now = Date.parse('2026-09-04T15:00:00');
  check('сегодняшний вход — со временем', /^сегодня в \d\d:\d\d$/.test(lastLoginLabel(now - 3600_000, now)),
    lastLoginLabel(now - 3600_000, now));
  check('вчерашний — тоже', /^вчера в \d\d:\d\d$/.test(lastLoginLabel(Date.parse('2026-09-03T09:15:00'), now)),
    lastLoginLabel(Date.parse('2026-09-03T09:15:00'), now));
  // Ночь считается по календарю, а не по «прошло 24 часа»: вход в 23:50
  // вчера — это вчера, даже если с тех пор прошло полтора часа
  check('полночь не превращает вчера в сегодня',
    lastLoginLabel(Date.parse('2026-09-03T23:50:00'), Date.parse('2026-09-04T01:20:00')).startsWith('вчера'),
    lastLoginLabel(Date.parse('2026-09-03T23:50:00'), Date.parse('2026-09-04T01:20:00')));
  check('давний вход — датой без времени',
    lastLoginLabel(Date.parse('2026-08-12T18:30:00'), now) === '12 авг.',
    lastLoginLabel(Date.parse('2026-08-12T18:30:00'), now));
  check('прошлый год отмечен годом — иначе он читается как позавчера',
    lastLoginLabel(Date.parse('2025-08-12T18:30:00'), now).includes('2025'),
    lastLoginLabel(Date.parse('2025-08-12T18:30:00'), now));
  // Не заходивший ни разу — это не «неизвестно когда», а отдельный ответ:
  // по нему видно, что учётку завели и забыли
  check('не заходивший назван прямо', lastLoginLabel(null, now) === 'ни разу не заходил(а)');
  check('мусор вместо времени не выдумывает дату', lastLoginLabel('не дата', now) === 'ни разу не заходил(а)');
  check('секунд нет нигде', !/\d\d:\d\d:\d\d/.test(lastLoginLabel(now - 1000, now)));
}

console.log('Раздельчик присутствия в Сотрудниках');
{
  const panel = readFileSync(new URL('../src/components/users/PresencePanel.tsx', import.meta.url), 'utf8');
  check('оба вопроса разведены', panel.includes('Сейчас в программе') && panel.includes('Заходили последними'));
  check('«в сети» берётся у присутствия, а не у отметки входа', panel.includes('onlineIds.includes'));
  check('«когда заходил» берётся у отметки входа', panel.includes('lastLoginLabel'));
  const screen = readFileSync(new URL('../src/screens/UsersManagement.tsx', import.meta.url), 'utf8');
  check('раздельчик стоит в Сотрудниках', screen.includes('<PresencePanel'));

  // Скрытый не должен просвечивать через список сотрудников: там время входа
  const routes = readFileSync(new URL('../server/routes/users.ts', import.meta.url), 'utf8');
  check('признак скрытности наружу не отдаётся',
    /\{ password, signatureImage, hideOnline, \.\.\.u \}/.test(routes));
  check('и время входа скрытого — тоже',
    /lastLoginAt: hideOnline && u\.id !== meId \? null/.test(routes));
}

console.log('Скрыться может только администратор');
{
  const routes = readFileSync(new URL('../server/routes/users.ts', import.meta.url), 'utf8');
  check('переключатель закрыт правом главного администратора',
    /put\('\/api\/presence\/visibility'[\s\S]{0,600}?isTopAdmin\(req\)/.test(routes));
  // Скрыть можно только себя: чужая видимость — это подделка ответа за другого
  check('меняется только своя видимость',
    /presence\/visibility'[\s\S]{0,900}?prisma\.user\.update\(\{ where: \{ id: me\.id \}/.test(routes));

  const srv = readFileSync(new URL('../server.ts', import.meta.url), 'utf8')
    + readFileSync(new URL('../server/sockets.ts', import.meta.url), 'utf8');
  check('список скрытых кэшируется, а не спрашивается на каждом ударе сердца',
    srv.includes('let hiddenOnline') && srv.includes('refreshHiddenOnline'));
  check('скрытый не объявляется ушедшим', /if \(!isHidden\(uid\)\) io\.emit\('presence:offline'/.test(srv));
  check('скрытый получает свой список лично',
    /broadcastTo: \(userId, roster\) => io\.to\(`user:\$\{userId\}`\)/.test(srv));
}

if (failed) {
  console.error(`\nПровалено проверок: ${failed}`);
  process.exit(1);
}
console.log('\nВсе проверки присутствия пройдены');
