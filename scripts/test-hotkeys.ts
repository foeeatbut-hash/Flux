/**
 * Клавишу обрабатывает ровно одно окно — то, в котором человек работает.
 *
 * Главное здесь — что Delete, набранный в ЧУЖОМ тексте, не удаляет файлы.
 * Проводник проверял только `input` и `textarea`, а редактор документа —
 * contenteditable; свёрнутые и стоящие на соседнем столе окна слушали наравне
 * с открытым, а Блокнот создавал по Ctrl+N столько заметок, сколько его окон
 * смонтировано. Всё это чистое правило, и потому проверяется здесь.
 *
 * Запуск: npx tsx scripts/test-hotkeys.ts
 */

import { shouldHandle, isTyping, topWindow } from '../src/lib/hotkeys';

let failed = 0;
const ok = (name: string, cond: boolean, detail?: unknown) =>
  cond
    ? console.log('  ✓', name)
    : (failed++, console.error('  ✗', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)));

/** Поддельная цель события: столько, сколько правилу нужно знать. */
const el = (o: Partial<{ tagName: string; isContentEditable: boolean; inside: boolean }>) => ({
  tagName: o.tagName || 'DIV',
  isContentEditable: !!o.isContentEditable,
  closest: (sel: string) => (o.inside && sel.includes('contenteditable') ? {} : null),
});

const ev = (target: unknown, defaultPrevented = false) => ({ target, defaultPrevented });

console.log('1. Набирает ли человек текст');
{
  ok('поле ввода — да', isTyping(el({ tagName: 'INPUT' })));
  ok('многострочное поле — да', isTyping(el({ tagName: 'TEXTAREA' })));
  ok('список выбора — да', isTyping(el({ tagName: 'SELECT' })));

  // Вот на чём Проводник и ловил Delete из чужого документа: редактор текста
  // не textarea, а contenteditable
  ok('редактируемый блок — да', isTyping(el({ isContentEditable: true })));
  ok('внутри редактируемого блока — да', isTyping(el({ inside: true })));

  ok('обычная разметка — нет', !isTyping(el({})));
  ok('кнопка — нет', !isTyping(el({ tagName: 'BUTTON' })));
  ok('пусто не роняет', !isTyping(null) && !isTyping(undefined));
}

console.log('\n2. Чья это клавиша');
{
  const base = { paneId: 'win:a', topWindowId: 'a', overlays: 0 };

  ok('активное окно — моя', shouldHandle(ev(el({})), base));

  // Ради этого всё: свёрнутое и не верхнее окно молчат
  ok('не верхнее окно — не моя', !shouldHandle(ev(el({})), { ...base, topWindowId: 'b' }));

  ok('человек набирает текст — не моя', !shouldHandle(ev(el({ isContentEditable: true })), base));
  ok('поле ввода — не моя', !shouldHandle(ev(el({ tagName: 'INPUT' })), base));

  // Панель, меню или диалог поверх содержимого: Escape и стрелки принадлежат им
  ok('поверх открыт диалог — не моя', !shouldHandle(ev(el({})), { ...base, overlays: 1 }));

  ok('событие уже разобрано — не моя', !shouldHandle(ev(el({}), true), base));

  // Раздел, живущий панелью, а не окном, в этой раздаче не участвует
  ok('раздел не в окне — не моя', !shouldHandle(ev(el({})), { ...base, paneId: '' }));
  ok('панель, а не окно — не моя', !shouldHandle(ev(el({})), { ...base, paneId: 'pane:a' }));
}

console.log('\n3. Кто наверху');
{
  const w = (id: string, z: number, extra: any = {}) => ({ id, z, ...extra });

  ok('один — он и наверху', topWindow([w('a', 1)]) === 'a');
  ok('наверху тот, у кого z больше', topWindow([w('a', 1), w('b', 5), w('c', 3)]) === 'b');

  // Свёрнутое окно человек не видит — отвечать на клавиши оно не должно,
  // даже если его z самый большой
  ok('свёрнутое не считается', topWindow([w('a', 1), w('b', 9, { minimized: true })]) === 'a',
    topWindow([w('a', 1), w('b', 9, { minimized: true })]));

  // Окно на соседнем столе с экрана убрано
  ok('соседний стол не считается',
    topWindow([w('a', 1, { desk: 0 }), w('b', 9, { desk: 1 })], 0) === 'a');
  ok('на своём столе считается',
    topWindow([w('a', 1, { desk: 0 }), w('b', 9, { desk: 1 })], 1) === 'b');

  ok('окон нет — никого', topWindow([]) === '');
  ok('все свёрнуты — никого', topWindow([w('a', 1, { minimized: true })]) === '');
}

console.log('\n4. Два окна одной программы');
{
  // Два Блокнота: Ctrl+N должен создать ОДНУ заметку, а не по одной на окно
  const windows = [{ id: 'n1', z: 2 }, { id: 'n2', z: 5 }];
  const top = topWindow(windows);
  const answers = windows
    .map((w) => shouldHandle(ev(el({})), { paneId: `win:${w.id}`, topWindowId: top, overlays: 0 }))
    .filter(Boolean);
  ok('отвечает ровно одно окно', answers.length === 1, answers.length);
  ok('и это верхнее', top === 'n2');
}

console.log(failed ? `\nПРОВАЛОВ: ${failed}` : '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ');
process.exit(failed ? 1 : 0);
