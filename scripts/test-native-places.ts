import { parseWindowsLogicalDisks } from '../electron/filesystem/nativePlaces';

let ok = 0;
let fail = 0;
function eq(name: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) { ok++; return; }
  fail++;
  console.error(`✗ ${name}: получено ${JSON.stringify(got)}, ожидалось ${JSON.stringify(want)}`);
}

const volumes = parseWindowsLogicalDisks(JSON.stringify([
  { path: 'C:\\', label: 'System', driveType: 3, size: 1000, freeSpace: 250 },
  { path: 'Z:\\', label: 'Projects', driveType: 4, providerName: '\\\\server\\projects', size: '9000', freeSpace: '5000' },
  { path: 'E:\\', driveType: 5, size: null, freeSpace: null },
]));
eq('локальный том сохраняет ёмкость', [volumes[0]?.path, volumes[0]?.kind, volumes[0]?.size, volumes[0]?.free], ['C:\\', 'fixed', 1000, 250]);
eq('сетевой диск сохраняет UNC-адрес и ёмкость', [volumes[2]?.path, volumes[2]?.kind, volumes[2]?.networkPath, volumes[2]?.size], ['Z:\\', 'network', '\\\\server\\projects', 9000]);
eq('оптический привод доступен без заявленной ёмкости', [volumes[1]?.path, volumes[1]?.kind, volumes[1]?.size], ['E:\\', 'optical', null]);
eq('повторяющийся диск не показывается дважды', parseWindowsLogicalDisks('[{"path":"C:\\\\","driveType":3},{"path":"c:\\\\","driveType":3}]').length, 1);
eq('недопустимый путь и неизвестный тип не становятся дисками', parseWindowsLogicalDisks('[{"path":"\\\\server\\share\\","driveType":4},{"path":"Q:\\\\","driveType":99}]').length, 0);
eq('повреждённый ответ Windows не ломает Проводник', parseWindowsLogicalDisks('not json'), []);

console.log(`\n${ok} проверок пройдено, ${fail} провалено`);
process.exit(fail ? 1 : 0);
