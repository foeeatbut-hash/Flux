/**
 * Приём файлов, принесённых из Windows.
 *
 * Правила здесь, а не в столе и не в Проводнике, по той же причине, по какой
 * вынесена раскладка значков: приёмников два, движение человека — одно. Пока
 * правила были записаны только в Проводнике, стол не принимал файлы ВООБЩЕ —
 * он читал лишь своё содержимое переноса и молча выходил, если пришло чужое.
 * Со стороны это выглядит как «перетащил, и ничего не случилось»: ни значка,
 * ни ошибки, ни объяснения.
 *
 * Второе, ради чего этот модуль: отказ должен быть сказан ДО переноса, а не
 * после. Файл, который «загрузился», но остался без содержимого, потом не
 * открывается — и человек считает, что сломана программа, а не что файл был
 * слишком большим.
 *
 * Без React и без DOM: у этих правил есть правильный ответ, и его проверяет
 * скрипт (scripts/test-drop-files.ts).
 */

/**
 * Предела на размер файла больше нет.
 *
 * Содержимое едет в базу кусками (server/routes/fileChunks.ts), и «сколько
 * влезает в пакет» стало свойством куска, а не файла. Имя оставлено, чтобы не
 * править десяток мест ради переименования: значение теперь означает
 * «отказывать по размеру не надо».
 */
export const MAX_FILE_BYTES = Number.POSITIVE_INFINITY;

/**
 * Выше этого спрашиваем подтверждение, а не отказываем (server/limits.ts).
 *
 * Предела на размер больше нет: содержимое едет в базу кусками, и «сколько
 * влезает в пакет» перестало быть свойством файла. Но полгигабайта лежат в
 * общей базе, едут по сети отдела и попадают в резервную копию — человек имеет
 * право их положить, а программа обязана об этом сказать один раз.
 */
export const WARN_FILE_BYTES = 500 * 1024 * 1024;

/** Файлы, о которых стоит спросить: слишком тяжёлые, чтобы класть молча */
export function heavyOnes<T extends DroppedFile>(files: T[], warn = WARN_FILE_BYTES): T[] {
  return files.filter((f) => (f.size || 0) > warn);
}

/** Что человек принёс: имя и размер — больше для решения ничего не нужно */
export interface DroppedFile {
  name: string;
  size: number;
}

export type DropRefusal = 'big' | 'empty' | 'noname';

export interface DropPlan<T extends DroppedFile> {
  /** Что принимаем и под каким именем */
  accepted: { file: T; name: string }[];
  /** Что не приняли и почему — словами, а не кодом */
  refused: { name: string; why: string }[];
}

export const MB = (n: number): string => `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} МБ`;

/**
 * Имя, которого ещё нет в этой папке: «Смета.xlsx» → «Смета (2).xlsx».
 *
 * Номер приписывается перед расширением, а не в конец: «Смета.xlsx (2)» Windows
 * откроет не тем, чем нужно, — расширение определяет программу.
 */
export function uniqueName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base} (${n})${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base} (${Date.now()})${ext}`;
}

/** Тип файла для базы — по расширению, а не по тому, что сказал браузер */
export function typeOf(name: string): string {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (ext === 'pdf') return 'PDF';
  if (['doc', 'docx'].includes(ext)) return 'DOCX';
  if (['xls', 'xlsx', 'xlsm'].includes(ext)) return 'XLSX';
  if (['txt', 'md', 'csv', 'log'].includes(ext)) return 'TXT';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) return 'IMAGE';
  return ext ? ext.toUpperCase() : 'FILE';
}

/**
 * Что принимаем, что отклоняем и под какими именами кладём.
 *
 * `taken` — имена, уже занятые в папке: список дополняется по ходу, иначе два
 * одинаковых файла из одного переноса получили бы одно имя.
 */
export function planDrop<T extends DroppedFile>(
  files: T[],
  taken: Iterable<string> = [],
  maxBytes: number = MAX_FILE_BYTES,
): DropPlan<T> {
  const busy = new Set(taken);
  const plan: DropPlan<T> = { accepted: [], refused: [] };
  for (const file of files) {
    const raw = String(file.name || '').trim();
    if (!raw) {
      plan.refused.push({ name: 'без имени', why: 'у файла нет имени' });
      continue;
    }
    if (!file.size) {
      // Папку браузер отдаёт как файл нулевого размера — и это самый частый
      // случай, когда «перенос не работает». Молчать об этом нельзя
      plan.refused.push({ name: raw, why: 'это пустой файл или папка — папки переносить нельзя' });
      continue;
    }
    if (file.size > maxBytes) {
      plan.refused.push({ name: raw, why: `${MB(file.size)} — больше предела в ${MB(maxBytes)}` });
      continue;
    }
    const name = uniqueName(raw, busy);
    busy.add(name);
    plan.accepted.push({ file, name });
  }
  return plan;
}

/** Подпись под курсором, пока файл висит над столом */
export function dropLabel(files: DroppedFile[], where = 'на ваш стол'): string {
  if (!files.length) return '';
  if (files.length === 1) return `${files[0].name} → ${where}`;
  const n = files.length;
  const word = n % 10 === 1 && n % 100 !== 11 ? 'файл' : (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'файла' : 'файлов');
  return `${n} ${word} → ${where}`;
}

/** Итог переноса одной строкой: сколько легло, что не легло и почему */
export function dropResult(ok: number, refused: { name: string; why: string }[], failed: string[]): string {
  const parts: string[] = [];
  if (ok) parts.push(ok === 1 ? 'Файл на вашем столе' : `Файлов принято: ${ok}`);
  for (const r of refused) parts.push(`«${r.name}» не принят: ${r.why}`);
  if (failed.length) parts.push(`не удалось загрузить: ${failed.join(', ')}`);
  return parts.join('. ');
}
