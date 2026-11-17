/**
 * Сторона окна для обновления выбранным: когда светится значок, когда напоминать после «Позже»,
 * что доходит из сокета. Без браузера и сервера: хранилище настоящее, сеть подменена.
 *
 * Запуск: npx tsx scripts/test-update-assign-client.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Хранилище обновления трогает window и localStorage уже при загрузке
const memory = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => { memory.set(k, v); }, removeItem: (k: string) => { memory.delete(k); } };
(globalThis as any).window = { location: { origin: 'http://localhost:3000', protocol: 'http:' }, dispatchEvent() {}, addEventListener() {}, fetch: globalThis.fetch, setTimeout, clearTimeout };

let count = 0;
const test = async (label: string, fn: () => unknown) => { try { await fn(); count++; } catch (error) { console.error('✗', label); throw error; } };

void (async () => {
  const { reminderPlan, readPostponed, writePostponed, REMINDER_DAY_MS } = await import('../src/lib/updateReminder');
  const { useUpdateStore, updateReady, selectOffer } = await import('../src/store/updateStore');

  // ---- «Позже»
  const base = { now: 10 * REMINDER_DAY_MS, lastShown: 0, postponed: null, session: 'now', version: '2.0.0' };
  await test('без «Позже» и без напоминаний сегодня — напомнить', () => assert.equal(reminderPlan(base), 'daily'));
  await test('напомнили меньше суток назад — молчим', () => assert.equal(reminderPlan({ ...base, lastShown: base.now - REMINDER_DAY_MS + 1000 }), 'none'));
  await test('напомнили больше суток назад — напоминаем снова', () => assert.equal(reminderPlan({ ...base, lastShown: base.now - REMINDER_DAY_MS - 1000 }), 'daily'));
  await test('после «Позже» в этом запуске — молчим до конца суток', () => {
    assert.equal(reminderPlan({ ...base, postponed: { version: '2.0.0', at: base.now - 3600000, session: 'now' } }), 'none');
    assert.equal(reminderPlan({ ...base, postponed: { version: '2.0.0', at: base.now - REMINDER_DAY_MS - 1, session: 'now' } }), 'daily');
  });
  await test('после «Позже» при следующем запуске — напоминаем сразу', () =>
    assert.equal(reminderPlan({ ...base, lastShown: base.now - 60000, postponed: { version: '2.0.0', at: base.now - 3600000, session: 'before' } }), 'launch'));
  await test('«Позже» на другую версию не заглушает новую', () =>
    assert.equal(reminderPlan({ ...base, postponed: { version: '1.9.0', at: base.now - 1000, session: 'now' } }), 'daily'));

  const store = new Map<string, string>(), fake = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } };
  await test('отложенное запоминается по сотруднику и снимается', () => {
    writePostponed('ivan', { version: '2.0.0', at: 5, session: 's' }, fake);
    assert.deepEqual(readPostponed('ivan', fake), { version: '2.0.0', at: 5, session: 's' });
    assert.equal(readPostponed('petr', fake), null);
    writePostponed('ivan', null, fake);
    assert.equal(readPostponed('ivan', fake), null);
  });
  await test('повреждённая запись и недоступное хранилище не ломают', () => {
    store.set('flux.update.postponed.ivan', '{не json');
    assert.equal(readPostponed('ivan', fake), null);
    assert.equal(readPostponed('ivan', { getItem: () => { throw new Error('закрыто'); } }), null);
    assert.doesNotThrow(() => writePostponed('ivan', { version: '1', at: 1, session: 's' }, { setItem: () => { throw new Error('закрыто'); }, removeItem: () => {} }));
  });

  // ---- Значок: только назначенным
  const release = { version: '2.0.0', changelog: 'Исправления', fileUrl: '/api/updates/download/2.0.0', signature: 's', size: 1 };
  const reset = (over: object = {}) => useUpdateStore.setState({ current: '1.0.0', phase: 'idle', latest: null, assignedOffer: null, campaignOffer: null, working: '', error: '', seen: false, ...over } as any);
  await test('опубликованная версия без назначения значок не зажигает', () => {
    reset({ latest: release, phase: 'available' });
    assert.equal(updateReady(useUpdateStore.getState()), false);
  });
  await test('назначенное обновление зажигает значок', () => {
    reset({ latest: release, phase: 'available', assignedOffer: { ...release, source: 'assignment' } });
    assert.equal(updateReady(useUpdateStore.getState()), true);
  });
  await test('уже установленное значок не зажигает', () => {
    reset({ current: '2.0.0', assignedOffer: { ...release, source: 'assignment' } });
    assert.equal(updateReady(useUpdateStore.getState()), false);
  });
  await test('во время установки значок гаснет', () => {
    reset({ assignedOffer: { ...release, source: 'assignment' }, phase: 'installing' });
    assert.equal(updateReady(useUpdateStore.getState()), false);
  });
  await test('возврат зажигает значок, пока работающая версия выше', () => {
    reset({ current: '3.0.0', campaignOffer: { ...release, version: '2.0.0', source: 'campaign', campaignId: 'c', rollback: true } });
    assert.equal(updateReady(useUpdateStore.getState()), true);
    useUpdateStore.setState({ current: '2.0.0' });
    assert.equal(updateReady(useUpdateStore.getState()), false);
  });
  await test('обязательное важнее обычного', () => {
    reset({ assignedOffer: { ...release, source: 'assignment' }, campaignOffer: { ...release, version: '2.5.0', source: 'campaign', campaignId: 'c' } });
    assert.equal(selectOffer(useUpdateStore.getState())?.version, '2.5.0');
  });

  // ---- Ответ сервера «что назначено мне»
  const answers: any[] = [], urls: string[] = [];
  (globalThis as any).fetch = async (url: string) => {
    urls.push(String(url));
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return { ok: true, json: async () => next };
  };
  await test('назначенное с сервера становится предложением, вместе с описанием', async () => {
    reset();
    answers.push({ release: { assignmentId: 'a', ...release } });
    await useUpdateStore.getState().refreshAssigned();
    const offer = useUpdateStore.getState().assignedOffer;
    assert.equal(offer?.version, '2.0.0'); assert.equal(offer?.changelog, 'Исправления'); assert.equal(offer?.source, 'assignment');
    assert.match(urls.at(-1)!, /assigned\?current=1\.0\.0$/, 'сервер узнаёт установленную версию');
    assert.equal(useUpdateStore.getState().seen, false);
  });
  await test('отмена на сервере убирает предложение', async () => {
    answers.push({ release: null });
    await useUpdateStore.getState().refreshAssigned();
    assert.equal(useUpdateStore.getState().assignedOffer, null);
  });
  await test('обрыв связи не стирает предложение', async () => {
    answers.push({ release: { assignmentId: 'a', ...release } });
    await useUpdateStore.getState().refreshAssigned();
    answers.push(new Error('нет связи'));
    await useUpdateStore.getState().refreshAssigned();
    assert.equal(useUpdateStore.getState().assignedOffer?.version, '2.0.0');
  });

  // ---- Сокет и плашка: события сервера доходят до окна
  const read = (file: string) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  await test('SocketProvider пересылает app:update-assigned в окно', () => {
    const text = read('src/components/SocketProvider.tsx');
    assert.match(text, /activeSocket\.on\('app:update-assigned', handleUpdateAssigned\)/);
    assert.match(text, /activeSocket\.off\('app:update-assigned', handleUpdateAssigned\)/);
    assert.match(text, /new CustomEvent\('socket:app:update-assigned'/);
  });
  await test('окно обновления слушает это событие и спрашивает назначенное сразу', () => {
    const text = read('src/components/UpdateDialog.tsx');
    assert.match(text, /addEventListener\('socket:app:update-assigned', assignedUpdates\)/);
    assert.match(text, /const assignedUpdates = \(\) => \{ lastAssigned = 0;/);
  });
  await test('«Опубликовано» больше не показывается всем всплывашкой', () => assert.doesNotMatch(read('src/components/SocketProvider.tsx'), /Опубликовано обновление Flux/));

  console.log(`${count} проверок пройдено, 0 провалено`);
})().catch(error => { console.error(error); process.exitCode = 1; });
