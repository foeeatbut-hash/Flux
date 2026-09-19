/**
 * Клавишу обрабатывает ровно одно окно — то, в котором человек работает.
 *
 * Зачем. Разделы подписывались на `window.keydown` напрямую и не спрашивали,
 * их ли сейчас очередь. Проводник проверял только `HTMLInputElement` и
 * `HTMLTextAreaElement` — то есть Delete, набранный в ТЕКСТЕ документа,
 * открывал у него диалог удаления файлов; свёрнутое окно и окно на соседнем
 * столе слушали наравне с открытым; Блокнот создавал по Ctrl+N столько
 * заметок, сколько его окон смонтировано.
 *
 * Правило здесь чистое и проверяется скриптом, потому что ошибиться в нём
 * легко, а последствие — чужой диалог удаления поверх чужой работы.
 *
 * Своей «активности» оболочка не хранит: активное окно — это верхнее по `z`
 * среди несвёрнутых (см. `raise` в store/windowStore). Поэтому окно передаётся
 * сюда вместе с тем, кто сейчас наверху, а не спрашивается изнутри.
 */

/** Что нужно знать о событии, чтобы решить. Настоящий KeyboardEvent подходит. */
export interface KeyLike {
  target: unknown;
  defaultPrevented: boolean;
}

/** Обстановка вокруг: кто я, кто наверху, что открыто поверх. */
export interface KeyContext {
  /** Моё окно — `win:<id>` или пусто, если раздел живёт не в окне */
  paneId: string;
  /** Верхнее несвёрнутое окно — оно и есть активное */
  topWindowId: string;
  /** Сколько панелей, меню и диалогов открыто поверх содержимого */
  overlays: number;
}

/** Набирает ли человек прямо сейчас текст. */
export function isTyping(target: unknown): boolean {
  const el = target as any;
  if (!el || typeof el !== 'object') return false;
  const tag = String(el.tagName || '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  // Редактор документа — не textarea, а contenteditable. Именно на этом
  // Проводник и ловил Delete из чужого текста
  if (el.isContentEditable) return true;
  try { return !!el.closest?.('[contenteditable="true"], [contenteditable=""]'); } catch (_) { return false; }
}

/**
 * Моя ли это клавиша.
 *
 * Пять условий, и каждое стоило дефекта:
 * — событие не разобрано кем-то раньше;
 * — человек не набирает текст;
 * — поверх нет панели или диалога (у них свои клавиши, и Escape в первую
 *   очередь принадлежит им);
 * — раздел живёт в окне;
 * — это окно сейчас верхнее.
 */
export function shouldHandle(ev: KeyLike, ctx: KeyContext): boolean {
  if (ev.defaultPrevented) return false;
  if (isTyping(ev.target)) return false;
  if (ctx.overlays > 0) return false;
  if (!ctx.paneId.startsWith('win:')) return false;
  return ctx.paneId.slice(4) === ctx.topWindowId;
}

/**
 * Кто сейчас наверху.
 *
 * Свёрнутое окно активным не бывает, даже если его `z` самый большой: человек
 * его не видит, и отвечать на клавиши оно не должно. Столы тоже считаются —
 * окно на соседнем столе с экрана убрано.
 */
export function topWindow(
  windows: { id: string; z: number; minimized?: boolean; desk?: number }[],
  desk?: number,
): string {
  const here = windows.filter((w) => !w.minimized && (desk === undefined || w.desk === desk));
  if (!here.length) return '';
  return here.reduce((a, b) => (b.z > a.z ? b : a)).id;
}
