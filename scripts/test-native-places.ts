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

// Плитка «Этого компьютера»: метка, буква и занятое место — как «Локальный диск (C:) · 160 ГБ свободно из 541 ГБ»
const tiles = parseWindowsLogicalDisks(JSON.stringify([
  { path: 'C:\\', label: '', driveType: 3, size: 541, freeSpace: 160, fileSystem: 'NTFS' },
  { path: 'D:\\', label: 'Новый том', driveType: 3, size: 1000, freeSpace: 1000 },
  { path: 'E:\\', driveType: 2, size: null, freeSpace: null },
  { path: 'Z:\\', driveType: 4, providerName: '\\\\server\\projects', size: 10, freeSpace: 20 },
  { path: 'F:\\', driveType: 5 },
]));
eq('том без метки подписан названием по типу, как в Проводнике', [tiles[0].label, tiles[0].letter, tiles[0].name], ['Локальный диск', 'C:', 'Локальный диск (C:)']);
eq('метка тома сохраняется как есть', [tiles[1].label, tiles[1].name], ['Новый том', 'Новый том (D:)']);
eq('занятое место — ёмкость минус свободное', [tiles[0].used, tiles[0].size, tiles[0].free, tiles[1].used], [381, 541, 160, 0]);
eq('файловая система сообщается, когда её назвала Windows', [tiles[0].fileSystem, tiles[1].fileSystem], ['NTFS', undefined]);
eq('съёмный диск и дисковод без ёмкости: занятого места нет, а название есть', [tiles[2].name, tiles[2].used, tiles[3].name, tiles[3].used], ['Съёмный диск (E:)', null, 'CD-дисковод (F:)', null]);
eq('сетевой диск без метки подписан общей папкой и сервером', [tiles[4].label, tiles[4].networkPath], ['projects (\\\\server)', '\\\\server\\projects']);
eq('нелепая ёмкость (свободного больше, чем всего) не даёт отрицательного занятого места', tiles[4].used, null);
eq('неприличное имя файловой системы отбрасывается', parseWindowsLogicalDisks('[{"path":"C:\\\\","driveType":3,"fileSystem":"<script>"}]')[0].fileSystem, undefined);

console.log(`\n${ok} проверок пройдено, ${fail} провалено`);
process.exit(fail ? 1 : 0);
