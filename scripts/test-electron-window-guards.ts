/**
 * Электрон в контейнере не запускается, поэтому проверка исходная: защита
 * главного окна и окна печати на месте, ссылка «localhost:3000» не принимается
 * за схему. Живую проверку (печать, ссылки target=_blank) делают на Windows.
 */
import fs from 'fs';
import assert from 'node:assert/strict';

const src = fs.readFileSync('electron/main.ts', 'utf8');
const win = src.slice(src.indexOf('function createWindow'));
assert(/mainWindow\.webContents\.setWindowOpenHandler/.test(win), 'главное окно: setWindowOpenHandler');
assert(/mainWindow\.webContents\.on\('will-navigate'/.test(win), 'главное окно: will-navigate');
assert(/action: 'deny'/.test(win));
assert(/isOwnPage/.test(win) && /preload: undefined/.test(win), 'свои страницы открываются без preload');
const pdf = src.slice(src.indexOf("ipcMain.handle('print:to-pdf'"));
assert(/javascript: false/.test(pdf.slice(0, 900)), 'окно печати без скриптов');
assert(/partition: 'flux-print'/.test(pdf.slice(0, 900)), 'своя сессия окна печати');
assert(/webRequest\.onBeforeRequest/.test(pdf.slice(0, 1200)), 'сеть окна печати закрыта');

const m = src.match(/if \(raw && !(\/[^\n]*?\/)\.test\(raw\)\) raw = 'https:\/\/' \+ raw;/);
assert(m, 'регулярка схемы найдена');
const scheme = new RegExp(m![1].slice(1, m![1].lastIndexOf('/')));
for (const hostPort of ['localhost:3000', 'localhost:3000/path', '10.0.0.1:8080']) assert(!scheme.test(hostPort), `${hostPort} — не схема`);
for (const real of ['https://a.b', 'mailto:a@b.c', 'file:///x', 'javascript:alert(1)']) assert(scheme.test(real), `${real} — схема`);
console.log('✓ защита окон на месте; localhost:порт не считается схемой');
