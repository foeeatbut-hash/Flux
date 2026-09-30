/**
 * Что нельзя открывать двойным щелчком из программы.
 *
 * Файлы Проводника и вложения Чата кладут другие люди. «Открыть программой
 * Windows» для .exe или .bat означает «запустить», и тогда чужой файл
 * выполняется на этой машине от имени сотрудника — хватает подложенного
 * вложения или ошибки в окне, которая позовёт открытие сама. Такой файл
 * сохраняют на диск и решают осознанно, а не запускают из программы.
 *
 * Хвостовые точки и пробелы Windows отбрасывает: «счёт.exe.» — это exe.
 */
const RUNNABLE = new Set([
  'exe', 'com', 'scr', 'pif', 'cpl', 'msi', 'msp', 'mst', 'appx', 'msix', 'appref-ms', 'application',
  'bat', 'cmd', 'ps1', 'psm1', 'psd1', 'ps1xml', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'wsc', 'hta',
  'lnk', 'url', 'scf', 'sct', 'inf', 'reg', 'jar', 'msc', 'gadget', 'chm', 'library-ms', 'settingcontent-ms',
  'dll', 'sys', 'drv', 'ocx', 'iso', 'img', 'vhd', 'vhdx',
]);

export function isRunnableFile(name: string): boolean {
  const clean = String(name || '').replace(/[.\s]+$/g, '').toLowerCase();
  const dot = clean.lastIndexOf('.');
  if (dot < 0) return false;
  return RUNNABLE.has(clean.slice(dot + 1));
}

export const RUNNABLE_REFUSAL =
  'Этот файл — программа или сценарий. Из Flux такие не запускаются: сохраните его на диск и проверьте, прежде чем открывать.';
