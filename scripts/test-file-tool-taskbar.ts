/** Старые закрепления не возвращают встроенные редакторы как программы. */
import assert from 'node:assert/strict';
import { SECTIONS, isKnownSection } from '../src/workspace/sections';
import { FILE_TOOL_PATHS, isFileToolPath } from '../src/lib/fileToolSections';
import { visibleSections, PLATFORM_OFF } from '../src/lib/appPolicy';
import { buildTaskbar } from '../src/lib/taskbar';
import { useDesktopStore } from '../src/store/desktopStore';

let checks = 0;
const check = (name: string, value: unknown) => { assert.ok(value, name); checks++; console.log('✓', name); };
const ctx = { user: { role: 'OWNER', isActive: true }, platform: PLATFORM_OFF };
const counts = { mail: 0, chat: 0, feedback: 0 };
const oldPins = ['/doc', '/sheet', '/pdf', '/archives', '/mail'];
const panel = (open: string[]) => buildTaskbar(
  visibleSections(SECTIONS, ctx, open).map(s => ({ ...s, pinned: !s.fileOnly && oldPins.includes(s.path) })),
  { open, activePath: open[0] || '/', counts, isAdmin: true },
);
check('старые закрепления не создают кнопки закрытых редакторов', panel([]).buttons.map(b => b.path).join(',') === '/mail');
check('открытый файл появляется на панели', panel(['/pdf']).buttons.some(b => b.path === '/pdf' && b.running));
check('после закрытия файла кнопка исчезает', !panel([]).buttons.some(b => b.path === '/pdf'));
check('несколько встроенных окон остаются доступными', ['/doc', '/sheet', '/pdf', '/archives'].every(p => panel(['/doc', '/sheet', '/pdf', '/archives']).buttons.some(b => b.path === p)));
check('таблица встроенных маршрутов согласована с реестром', FILE_TOOL_PATHS.every(p => isKnownSection(p) && SECTIONS.find(s => s.path === p)?.fileOnly));
check('старый адрес конструктора нельзя закрепить как редактор', isFileToolPath('/constructor?file=x'));
check('обычные программы продолжают закрепляться', !isFileToolPath('/equipment') && !isFileToolPath('/notes'));
const store = useDesktopStore.getState();
check('у нового профиля редакторы не закреплены', !store.apps.some(isFileToolPath) && !store.bar.some(isFileToolPath));
for (const path of oldPins.filter(isFileToolPath)) {
  store.pinApp(path); store.pinBar(path);
}
store.pinApp('/constructor'); store.pinBar('/constructor');
check('повторное закрепление встроенных действий отклоняется', !useDesktopStore.getState().apps.some(isFileToolPath) && !useDesktopStore.getState().bar.some(isFileToolPath));
console.log(`${checks} проверок пройдено`);
