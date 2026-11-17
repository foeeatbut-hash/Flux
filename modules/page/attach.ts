/**
 * Прикрепление результатов программы к проекту (`flux.attach`): где лежит файл и что вернётся программе.
 *
 * Файл без зависимостей: им пользуются мост, окно Flux, сервер (запись файла) и Studio (честная имитация), и все четыре обязаны
 * называть место одинаково. Решение руководителя, владельцем не подтверждено (`.claude/progress/programs-11.md`): результат кладётся
 * файлом в папку проекта в Проводнике, подпапка — по названию программы; видят те же, кто видит проект.
 */

/** Папка проекта, куда ложатся результаты всех программ; внутри — по подпапке на программу */
export const ATTACH_ROOT_FOLDER = 'Результаты программ';
/** Имя подпапки и имя файла не длиннее: как в Проводнике и в схеме сообщения моста */
export const ATTACH_NAME_MAX = 100;

/** Ответ программе на удачное прикрепление: имя, под которым файл лёг (при занятом имени оно получает номер), и папка */
export interface AttachResult { name: string; folder: string }

/** Название программы как имя папки: без разделителей пути и управляющих знаков, пустое — «Программа» */
export function attachFolderName(program: string): string {
  const clean = String(program).replace(/[\u0000-\u001f\u007f/\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, ATTACH_NAME_MAX).trim();
  return clean || 'Программа';
}

/** Папка для человека: «Результаты программ / Название» */
export const attachFolderPath = (program: string): string => `${ATTACH_ROOT_FOLDER} / ${attachFolderName(program)}`;

/**
 * Имя файла, свободное в папке: «расчёт.csv» → «расчёт (2).csv». Прежний файл никогда не перезаписывается:
 * два прогона программы дают два файла, а какой нужен, решает человек.
 */
export function freeAttachName(name: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map(n => n.toLowerCase()));
  if (!used.has(name.toLowerCase())) return name;
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 2; i < 10_000; i++) {
    const candidate = `${base.slice(0, Math.max(1, ATTACH_NAME_MAX - ext.length - String(i).length - 3))} (${i})${ext}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return `${base.slice(0, 60)} (${Date.now()})${ext}`;
}
