/**
 * Комната файла Flux Office: кто правит, кто смотрит — без сервера.
 *
 * Что стережёт (server/officeRooms.ts, components/collab/useOfficeRoom.ts,
 * OfficePresence.tsx):
 *   - правит первый, кому файл можно писать; второй — смотрит;
 *   - тот, кому писать нельзя, правку не получает ни по приходу, ни кнопкой;
 *   - закрыл окно — правка свободна, но сама не переходит: берут кнопкой;
 *   - обрыв связи: правка ждёт то же окно, вернулось — продолжает; не
 *     вернулось вовремя — правка свободна;
 *   - окно без связи: зритель остаётся зрителем, держатель — держателем;
 *   - полоса говорит правду о каждом состоянии.
 *
 * Запуск: npx tsx scripts/test-office-rooms.ts
 */
import { OfficeRoomBook, GRACE_MS, type OfficePeer } from '../server/officeRooms';
import { officeMode, type OfficeRoster } from '../src/components/collab/useOfficeRoom';
import { presenceLine } from '../src/components/collab/OfficePresence';
import { CollabBook } from '../server/officeCollab';
import { dueToSave, QUIET_MS, MAX_UNSAVED_MS } from '../src/components/collab/useDocCollab';
import * as Y from 'yjs';

let f = 0;
const ok = (n: string, c: boolean, d?: unknown) =>
  (c ? console.log('  ✓', n) : (f++, console.error('  ✗', n, d === undefined ? '' : JSON.stringify(d))));

const peer = (sid: string, cid: string, uid: string, mayWrite = true): OfficePeer =>
  ({ socketId: sid, clientId: cid, userId: uid, name: `Сотрудник ${uid}`, color: '#000', mayWrite, since: 0 });

console.log('1. Кто правит');
{
  const b = new OfficeRoomBook();
  b.join('F', peer('s1', 'c1', 'A'), 0);
  b.join('F', peer('s2', 'c2', 'B'), 1);
  ok('правит первый', b.holder('F', 2)?.userId === 'A');
  ok('второй смотрит', !b.holds('F', 's2'));
  ok('взять занятую правку нельзя', /правит/.test(b.take('F', 's2', 3)));
  ok('список: двое, держатель A', b.roster('F').peers.length === 2 && b.roster('F').holder?.userId === 'A');
}
{
  const b = new OfficeRoomBook();
  b.join('F', peer('s1', 'c1', 'R', false), 0);
  ok('без права записи правку по приходу не получает', b.holder('F', 1) === null);
  ok('и кнопкой тоже', /только смотреть/.test(b.take('F', 's1', 2)));
  b.join('F', peer('s2', 'c2', 'W'), 3);
  ok('пришедший с правом — правит', b.holder('F', 4)?.userId === 'W');
}

console.log('\n2. Держатель закрыл окно');
{
  const b = new OfficeRoomBook();
  b.join('F', peer('s1', 'c1', 'A'), 0);
  b.join('F', peer('s2', 'c2', 'B'), 1);
  b.leave('s1');
  ok('правка свободна сразу', b.holder('F', 2) === null);
  ok('сама не перешла к зрителю', !b.holds('F', 's2'));
  b.join('F', peer('s3', 'c3', 'C'), 3);
  ok('и к новому пришедшему тоже', !b.holds('F', 's3'));
  ok('зритель берёт кнопкой', b.take('F', 's2', 4) === '' && b.holds('F', 's2'));
  ok('второй после него — уже нет', /правит/.test(b.take('F', 's3', 5)));
  b.leave('s2'); b.leave('s3');
  b.join('F', peer('s4', 'c4', 'D'), 6);
  ok('опустевшая комната начинается заново: первый снова правит', b.holds('F', 's4'));
}

console.log('\n3. Обрыв связи');
{
  const b = new OfficeRoomBook();
  b.join('F', peer('s1', 'c1', 'A'), 0);
  b.join('F', peer('s2', 'c2', 'B'), 0);
  b.lost('s1', 1000);
  ok('пропавший держатель ещё держит', b.holder('F', 1000 + GRACE_MS - 1)?.userId === 'A');
  ok('в списке он «потерял связь»', b.roster('F').holder?.lost === true);
  ok('пока его ждут, взять нельзя', /правит/.test(b.take('F', 's2', 1000 + GRACE_MS - 1)));
  b.join('F', peer('s9', 'c1', 'A'), 1000 + GRACE_MS - 1);
  ok('то же окно вернулось — правит дальше', b.holds('F', 's9'));
}
{
  const b = new OfficeRoomBook();
  b.join('F', peer('s1', 'c1', 'A'), 0);
  b.join('F', peer('s2', 'c2', 'B'), 0);
  b.lost('s1', 1000);
  b.join('F', peer('s5', 'c5', 'A'), 1500);
  ok('другое окно того же человека правку не перехватывает', !b.holds('F', 's5'));
  ok('не вернулся вовремя — свободна', b.expire(1000 + GRACE_MS).includes('F') && b.holder('F', 1000 + GRACE_MS) === null);
  ok('и берут её кнопкой', b.take('F', 's2', 1000 + GRACE_MS + 1) === '');
  b.join('F', peer('s9', 'c1', 'A'), 1000 + GRACE_MS + 2);
  ok('вернувшийся поздно — зритель', !b.holds('F', 's9'));
}

console.log('\n4. Окно: правлю или смотрю');
const roster = (holderCid: string | null, lost = false): OfficeRoster => ({
  fileId: 'F',
  holder: holderCid ? { socketId: 'x', clientId: holderCid, userId: 'U' + holderCid, name: 'Иванов', color: '', lost } : null,
  peers: [{ socketId: 'a', clientId: 'me', userId: 'Ume', name: 'Я', color: '' }, { socketId: 'b', clientId: 'other', userId: 'Uother', name: 'Иванов', color: '' }],
});
ok('держу — правлю', officeMode(roster('me'), 'me', true, false) === 'edit');
ok('держит другой — смотрю', officeMode(roster('other'), 'me', true, false) === 'view');
ok('никто не держит — смотрю', officeMode(roster(null), 'me', true, false) === 'view');
ok('до списка — жду', officeMode(null, 'me', true, false) === 'pending');
ok('связь пропала, правил другой — смотрю дальше', officeMode(roster('other'), 'me', false, true) === 'view');
ok('связь пропала, правил я — правлю', officeMode(roster('me'), 'me', false, true) === 'edit');
ok('связи не было вовсе — правлю под сверкой', officeMode(null, 'me', false, true) === 'alone');
ok('связи ещё нет — жду', officeMode(null, 'me', false, false) === 'pending');

console.log('\n5. Полоса');
ok('правлю один — полосы нет', presenceLine({ ...roster('me'), peers: [roster('me').peers[0]] }, 'me', 'edit', true).text === '');
ok('правлю при зрителях — сказано', /Вы правите/.test(presenceLine(roster('me'), 'me', 'edit', true).text));
ok('смотрю — названо, кто правит', /правит Иванов/.test(presenceLine(roster('other'), 'me', 'view', false).text));
ok('держатель без связи — сказано, и взять нельзя', (() => { const l = presenceLine(roster('other', true), 'me', 'view', false); return /потерял связь/.test(l.text) && !l.canTake; })());
ok('свободна — кнопка «Взять правку»', presenceLine(roster(null), 'me', 'view', false).canTake);
ok('без связи — сказано про сверку', /сверит/.test(presenceLine(null, 'me', 'alone', true).text));

(async () => {
console.log('\n6. Общий файл: держатель передаётся сам');
{
  const b = new OfficeRoomBook();
  b.join('F', peer('s1', 'c1', 'A'), 0, true);
  b.join('F', peer('s2', 'c2', 'R', false), 1, true);
  b.join('F', peer('s3', 'c3', 'B'), 2, true);
  ok('первый записывает', b.holds('F', 's1'));
  ok('в списке — совместная правка и права каждого', b.roster('F').collab && b.roster('F').peers.some((p) => p.mayWrite === false));
  b.leave('s1');
  ok('ушёл — записывает следующий, кому можно писать (не зритель)', b.holds('F', 's3'));
  b.lost('s3', 100);
  ok('обрыв — ждём', b.holder('F', 100 + GRACE_MS - 1)?.userId === 'B');
  b.join('F', peer('s4', 'c4', 'C'), 200, true);
  b.expire(100 + GRACE_MS);
  ok('не вернулся — записывает следующий', b.holds('F', 's4'));
  ok('окно: общий файл — правим вместе', officeMode(b.roster('F'), 'c4', true, false) === 'together');
  ok('без права записи — смотрю', officeMode(b.roster('F'), 'c2', true, false) === 'view');
  ok('общий файл без связи не правится', officeMode(b.roster('F'), 'c4', false, true) === 'view');
}

console.log('\n7. Сеанс общего документа');
{
  const book = new CollabBook();
  const base = Buffer.from('исходник');
  const s = await book.ensure('F', async () => base);
  const again = await book.ensure('F', async () => Buffer.from('другое'));
  ok('сеанс один, исходник — первый', again === s && s.baseBytes.equals(base));
  ok('первый, кому можно писать, засевает', book.want(s, 's1', true) === 'seed');
  ok('второй ждёт, а не засевает вторым', book.want(s, 's2', true) === 'wait');
  ok('зритель без права тоже только ждёт', book.want(s, 's3', false) === 'wait');
  // Засевающий ушёл, не засеяв, — поручить следующему
  const next = book.gone(s, 's1', 0);
  ok('засевающий ушёл — поручено следующему', next === 's2' && s.seeder === 's2');
  const a = new Y.Doc();
  a.getXmlFragment('prosemirror').insert(0, [new Y.XmlText('Проба')]);
  ok('засеял — сеанс готов', book.update(s, 's2', Y.encodeStateAsUpdate(a)) === true && s.seeded);
  ok('засеянное не считается незаписанным', !book.unsaved(s));
  ok('теперь приходящий получает содержимое', book.want(s, 's4', true) === 'state');
  const late = new Y.Doc();
  Y.applyUpdate(late, Y.encodeStateAsUpdate(s.ydoc));
  ok('опоздавший видит то же', late.getXmlFragment('prosemirror').toString() === a.getXmlFragment('prosemirror').toString());
  a.getXmlFragment('prosemirror').insert(1, [new Y.XmlText('!')]);
  book.update(s, 's2', Y.encodeStateAsUpdate(a));
  ok('правка после засева — незаписанная', book.unsaved(s));
  book.markSaved(s);
  ok('держатель записал — записано', !book.unsaved(s));
}

console.log('\n8. Когда держатель записывает');
ok('правок нет — не пишет', !dueToSave(10_000, null, null));
ok('печатают — ждёт тишины', !dueToSave(1000 + QUIET_MS - 1, 0, 1000));
ok('тишина — пишет', dueToSave(1000 + QUIET_MS, 0, 1000));
ok('печатают без остановки — всё равно пишет', dueToSave(MAX_UNSAVED_MS, 0, MAX_UNSAVED_MS - 100));

console.log(f ? `\nПРОВАЛОВ: ${f}` : '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ');
process.exit(f ? 1 : 0);
})();
