import assert from 'node:assert/strict';
import { acquireDraftsSource, useDraftsPanelStore } from '../src/store/draftsPanelStore';

let completed = false;
process.on('exit', () => { if (!completed) process.exitCode = 1; });
async function main() {
  let calls = 0, subscriptions = 0, unsubscriptions = 0;
  let changed: (() => void) | undefined;
  let resolveFirst: ((value: unknown) => void) | undefined;
  const entries = [{ draftId: 'new', name: 'Новый.txt' }];
  (globalThis as any).window = { electron: { windowsFiles: {
    invoke: async () => {
      calls++;
      if (calls === 1) return new Promise(resolve => { resolveFirst = resolve; });
      return { ok: true, data: { entries, total: 1, nextOffset: null, unreadableCount: 0 } };
    },
    onChanged: (callback: () => void) => {
      subscriptions++; changed = callback;
      return () => { unsubscriptions++; };
    },
  } } };
  const first = acquireDraftsSource('one');
  const second = acquireDraftsSource('one');
  assert.equal(calls, 1, 'Два монитора делят один запрос');
  assert.equal(subscriptions, 1, 'Два монитора делят одну подписку');
  useDraftsPanelStore.getState().toggle(2);
  assert.equal(useDraftsPanelStore.getState().displayId, 2);
  useDraftsPanelStore.getState().toggle(2);
  assert.equal(useDraftsPanelStore.getState().displayId, null);
  first(); second();
  const next = acquireDraftsSource('two');
  resolveFirst!({ ok: true, data: { entries: [{ draftId: 'old' }], total: 1, nextOffset: null, unreadableCount: 0 } });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(calls, 2, 'Смена профиля не теряет запрос за предыдущим');
  assert.equal(useDraftsPanelStore.getState().entries[0]?.draftId, 'new', 'Старый ответ не попадает в новый профиль');
  changed!(); changed!();
  await new Promise(resolve => setTimeout(resolve, 140));
  assert.equal(calls, 3, 'Серия изменений даёт одно перечитывание');
  next();
  assert.equal(unsubscriptions, 2, 'Последнее окно освобождает подписку');
  completed = true;
  console.log('8 проверок общего источника и открытия панели пройдено');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
