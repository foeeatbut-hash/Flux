import assert from 'node:assert/strict';

const storage = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
};
(globalThis as any).document = { documentElement: { classList: { add() {}, remove() {} } } };
(globalThis as any).fetch = async () => new Response('{}', { status: 503 });

async function main() {
  const { useStore } = await import('../src/store/store');
  const { useWindowStore } = await import('../src/store/windowStore');
  const { guardClose, prepareSessionClose, clearGuards } = await import('../src/lib/closeGuard');
  let checks = 0;
  const check = (name: string, value: unknown) => { assert.ok(value, name); checks++; console.log('✓', name); };
  const owner = { id: 'person-a', name: 'A', symbol: 'A', role: 'OWNER' };
  const colleague = { id: 'person-b', name: 'B', symbol: 'B', role: 'OWNER' };
  await useStore.getState().setUser(owner);
  useWindowStore.getState().open('/notes');
  const id = useWindowStore.getState().windows[0].id;
  useWindowStore.getState().minimize(id);
  await useStore.getState().setUser({ ...owner, name: 'Новое имя' });
  check('обновление профиля сохраняет свёрнутое окно', useWindowStore.getState().windows[0].id === id && useWindowStore.getState().windows[0].minimized);
  const deny = guardClose(id, () => false);
  await useStore.getState().setUser(null);
  check('отказ редактора отменяет выход и сохраняет профиль', useStore.getState().user?.id === owner.id);
  check('отказ редактора сохраняет смонтированное окно', useWindowStore.getState().windows.length === 1);
  deny();
  await useStore.getState().setUser(null);
  check('отказ БД не препятствует локальному выходу', useStore.getState().user === null);
  check('выход удаляет live-окна и заголовки', useWindowStore.getState().windows.length === 0 && Object.keys(useWindowStore.getState().titles).length === 0);
  check('раскладка сохраняется только под владельцем профиля', storage.has('flux_windows_person-a'));
  await useStore.getState().setUser(colleague);
  check('новый сотрудник не получает чужие окна', useWindowStore.getState().windows.length === 0);
  useWindowStore.getState().open('/projects');
  await useStore.getState().setUser(null);
  await useStore.getState().setUser(owner);
  check('возвращение восстанавливает только свою раскладку и свёрнутость', useWindowStore.getState().windows.length === 1 && useWindowStore.getState().windows[0].id === id && useWindowStore.getState().windows[0].minimized);
  useWindowStore.getState().close(id);
  await useStore.getState().setUser(null);
  await useStore.getState().setUser(owner);
  check('закрытое окно не появляется при новом входе', useWindowStore.getState().windows.length === 0);

  let finish!: (value: boolean) => void;
  let calls = 0;
  const remove = guardClose('pending', () => { calls++; return new Promise<boolean>(resolve => { finish = resolve; }); });
  const first = prepareSessionClose();
  const second = prepareSessionClose();
  check('параллельные выход и обновление разделяют одну проверку сохранения', first === second && calls === 1);
  guardClose('opened-during-save', () => true);
  finish(true);
  check('появившийся во время сохранения редактор блокирует завершение', await first === false);
  remove();
  clearGuards();
  const bad = guardClose('save-failed', () => { throw new Error('save failed'); });
  check('ошибка сохранения не разрешает выход или перезапуск', await prepareSessionClose() === false);
  bad();
  check('без несохранённых редакторов можно завершать сессию', await prepareSessionClose() === true);
  console.log(`${checks} проверок пройдено`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
