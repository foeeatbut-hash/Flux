import assert from 'node:assert/strict';
import { displayAt, displayForRect, displaySnap, localDisplayAreas, rebaseRect, recoverRect, unionDisplays,
  type WorkspaceDisplay } from '../workspace/displays';
let checks = 0;
const equal = (actual: unknown, expected: unknown, label: string) => { assert.deepEqual(actual, expected, label); checks++; console.log(`✓ ${label}`); };
const screen = (id: number, x: number, y: number, w: number, h: number, scaleFactor = 1): WorkspaceDisplay => ({
  id, label: `Экран ${id}`, primary: id === 1, scaleFactor,
  bounds: { x, y, w, h }, workArea: { x, y, w, h: h - 40 },
});
const main = screen(1, 0, 0, 1920, 1080);
const left = screen(2, -1280, -200, 1280, 1024, 1.5);
const above = screen(3, 500, -1100, 1920, 1080, 2);
const union = unionDisplays([main, left, above]);
equal(union, { x: -1280, y: -1100, w: 3700, h: 2180 }, 'Отрицательные координаты и экран сверху входят в объединение');
const state = { enabled: true, displays: [main, left, above], bounds: union, primaryId: 1, mixedScale: true };
const local = localDisplayAreas(state, 48);
equal(local[0].bounds, { x: 1280, y: 1100, w: 1920, h: 1080 }, 'Основной монитор сохраняет положение в виртуальном столе');
equal(local[1].workArea, { x: 0, y: 900, w: 1280, h: 936 }, 'Резервированы панели Windows и Flux');
equal(localDisplayAreas({ ...state, showWindowsTaskbar: true }, 0)[0].workArea.h, main.workArea.h, 'Обычная геометрия использует workArea Windows без резерва под скрывающуюся панель Flux');
equal(localDisplayAreas({ ...state, showWindowsTaskbar: false }, 0)[0].workArea.h, main.bounds.h, 'Отключённая панель Windows отдаёт Flux всю физическую высоту экрана');
equal(local[2].bounds.w, 1920, 'DIP не умножается повторно на DPI-масштаб');
equal(displayAt(local, 10, 950)?.id, 2, 'Курсор выбирает левый монитор');
equal(displayAt(local, 1800, 10)?.id, 3, 'Курсор выбирает монитор сверху');
equal(displayAt(local, 0, 0)?.id, 2, 'Промежуток выбирает ближайший реальный экран');
equal(displayAt([], 0, 0), null, 'Нет экранов — нет выдуманного монитора');
equal(displayForRect(local, { x: 40, y: 930, w: 900, h: 1400 })?.id, 2, 'Монитор определяется заголовком большого окна');
equal(displaySnap('top', local[1].workArea), local[1].workArea, 'Разворачивание ограничено одним монитором');
equal(displaySnap('right', { x: 1280, y: 1100, w: 1921, h: 980 }), { x: 2240, y: 1100, w: 961, h: 980 }, 'Правая половина сохраняет координаты и нечётную ширину');
const edited = { id: 'document', x: 1400, y: 1150, w: 1000, h: 700, unsaved: 'Правки' };
equal(recoverRect(edited, local), edited, 'Доступное окно и содержимое редактора сохраняются');
const removed = { id: 'document', x: -1100, y: 100, w: 1000, h: 700, unsaved: 'Правки' };
equal(recoverRect(removed, [main]), { ...removed, x: 0, y: 100 }, 'После отключения монитора заголовок возвращается на основной');
equal(recoverRect({ x: 100, y: -900, w: 800, h: 500 }, [main]), { x: 100, y: 0, w: 800, h: 500 }, 'Экран сверху отключён — окно возвращается без потери размера');
equal(recoverRect({ x: 0, y: -30, w: 2500, h: 1600 }, [main]), { x: 0, y: 0, w: 1920, h: 1040 }, 'Невидимое большое окно помещается в workArea');
equal(recoverRect({ x: -300, y: 100, w: 500, h: 300 }, [main]), { x: -300, y: 100, w: 500, h: 300 }, 'Видимый заголовок позволяет окну пересекать границу');
equal(rebaseRect(edited, union, main.bounds), { ...edited, x: 120, y: 50 }, 'Изменение начала виртуального стола сохраняет физическое положение');
equal(recoverRect({ x: 0, y: 0, w: 800, h: 500 }, local).y, 900, 'Окно в разрыве расположения возвращается в workArea');
equal(localDisplayAreas({ ...state, displays: [screen(1, 0, 0, 400, 80)], bounds: { x: 0, y: 0, w: 400, h: 80 } }, 100)[0].workArea.h, 1, 'Панель не создаёт отрицательную высоту');
console.log(`\nПроверено ${checks} сценариев нескольких мониторов.`);

// Проверяем реальные команды хранилища: редактор остаётся тем же окном,
// а не пересоздаётся ради переноса или изменения состава экранов.
const { useWindowStore } = require('../src/store/windowStore');
const original = { id: 'test-document', path: '/doc', href: '/doc?file=synthetic', desk: 0,
  x: 100, y: 100, w: 800, h: 500, z: 1, minimized: false, maximized: false, restore: null };
useWindowStore.setState({ windows: [original], area: { w: 3700, h: 2180 }, displays: [], displayOrigin: null, titles: { 'test-document': 'Несохранённый документ' } });
useWindowStore.getState().setDisplayAreas(local, union);
equal(useWindowStore.getState().windows[0].x, 1380, 'Включение режима переносит открытое окно в основной экран');
equal(useWindowStore.getState().titles[original.id], 'Несохранённый документ', 'Заголовок и идентификатор редактора не сброшены');
useWindowStore.getState().move(original.id, -1300, -150);
useWindowStore.getState().finishMove(original.id);
equal(displayForRect(local, useWindowStore.getState().windows[0])?.id, 2, 'Реальная команда drag переносит окно между мониторами');
useWindowStore.getState().maximize(original.id);
equal(useWindowStore.getState().windows[0].w, left.workArea.w, 'Команда maximize использует ширину целевого монитора');
equal(useWindowStore.getState().windows[0].y, local[1].workArea.y, 'Команда maximize использует вертикальное положение целевого монитора');
useWindowStore.getState().maximize(original.id);
equal(useWindowStore.getState().windows[0].w, 800, 'Повторное maximize возвращает предыдущий размер');
const minimized = { ...original, id: 'minimized', x: 1380, y: 1200, minimized: true };
useWindowStore.setState({ windows: [...useWindowStore.getState().windows, minimized] });
useWindowStore.getState().tileAll();
equal(useWindowStore.getState().windows.find((w: any) => w.id === 'minimized'), minimized, 'Раскладка не сдвигает свёрнутое окно повторно');
const remaining = localDisplayAreas({ ...state, displays: [main], bounds: main.bounds }, 48);
useWindowStore.getState().setDisplayAreas(remaining, main.bounds);
equal(useWindowStore.getState().windows[0].id, original.id, 'Hotplug сохраняет экземпляр открытого редактора');
equal(displayForRect(remaining, useWindowStore.getState().windows[0])?.id, 1, 'Hotplug возвращает окно на оставшийся экран');
useWindowStore.getState().setDisplayAreas([], null);
useWindowStore.getState().setArea({ w: 1280, h: 752 });
equal(useWindowStore.getState().windows[0].href, original.href, 'Выход в оконный режим сохраняет открытый документ');
useWindowStore.getState().maximize(original.id);
equal(useWindowStore.getState().windows[0].w, 1280, 'Обычный режим снова разворачивает в доступное окно');
console.log(`\nВсего проверено ${checks} сценариев геометрии и управления окнами.`);
