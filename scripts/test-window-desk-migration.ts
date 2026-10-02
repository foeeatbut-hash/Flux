const saved = new Map<string, string>([
  ['flux_windows', JSON.stringify([
    { id: 'draft-window', path: '/notes', href: '/notes?draft=unsaved', desk: 1, x: -240, y: 80, w: 900, h: 600, z: 3, minimized: false, maximized: false, restore: null },
    { id: 'hidden-window', path: '/projects', href: '/projects?tab=recent', desk: 2, x: 40, y: 120, w: 800, h: 500, z: 4, minimized: true, maximized: false, restore: null },
  ])],
  ['flux_desks', JSON.stringify(['Рабочий стол 1', 'Старый стол'])],
]);
(globalThis as any).localStorage = {
  getItem: (key: string) => saved.get(key) ?? null,
  setItem: (key: string, value: string) => { saved.set(key, value); },
};

const { useWindowStore } = require('../src/store/windowStore');
const state = useWindowStore.getState();
const windows = state.windows;
const persisted = JSON.parse(saved.get('flux_windows') || '[]');
if (state.desks.length !== 1 || state.desk !== 0) throw new Error('Legacy virtual desks were not reduced to one workspace');
if (windows.length !== 2 || windows.some((item: any) => item.desk !== 0)) throw new Error('A legacy window stayed hidden on a removed desk');
if (windows[0].id !== 'draft-window' || windows[0].href !== '/notes?draft=unsaved' || windows[0].x !== -240) throw new Error('Window identity, draft location or position was lost');
if (!windows[1].minimized || windows[1].id !== 'hidden-window') throw new Error('Minimized window state was lost');
if (persisted.some((item: any) => item.desk !== 0)) throw new Error('Migrated layout was not saved');
console.log('✓ Старые столы объединены без потери окон, черновиков и геометрии');
