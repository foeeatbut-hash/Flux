/**
 * У каждой кнопки на ленте есть обработчик.
 *
 * Проверка написана по жалобе «убрать всё нерабочее из редакторов файлов».
 * Кнопка, которая ничего не делает, — худший вид поломки: человек нажимает,
 * ничего не происходит, и он решает, что сломана программа целиком. А в коде
 * такую кнопку не видно: лента описана списком в src/lib/ribbon*.ts, а
 * обработчики — свитчем в экране, и они расходятся молча.
 *
 * Проверяем текстом, а не запуском: свитч разбирать честнее по исходнику, чем
 * поднимать движок документа ради одного вопроса «а есть ли case».
 *
 * Запуск: npx tsx scripts/test-ribbon-wiring.ts
 */
import { readFileSync } from 'fs';

const PAIRS: [string, string, string][] = [
  ['Текстовый документ', 'src/lib/ribbonDoc.ts', 'src/screens/TextDocEditor.tsx'],
  ['Таблица', 'src/lib/ribbonSheet.ts', 'src/screens/ConstructorScreen.tsx'],
  ['Просмотр', 'src/lib/ribbonPdf.ts', 'src/screens/PdfEditor.tsx'],
];

let failed = 0;

for (const [name, ribbonFile, screenFile] of PAIRS) {
  const ribbon = readFileSync(ribbonFile, 'utf8');
  const screen = readFileSync(screenFile, 'utf8');
  const ids = [...new Set([...ribbon.matchAll(/id:\s*'([a-z]+\.[A-Za-z]+)'/g)].map((m) => m[1]))];

  console.log(`${name}: органов на ленте — ${ids.length}`);
  if (!ids.length) { failed++; console.error('  ✗ лента пуста — разбор сломался'); continue; }

  // Орган подключён либо своим `case` в свитче, либо через таблицу вида
  // `{'pdf.cloud': 'CLOUD'}` — так сделаны инструменты пометок. А вот
  // `organState` и `organDisabled` не подключают ничего: они только говорят,
  // как кнопка выглядит, — поэтому их из текста вырезаем, иначе кнопка с
  // видом, но без действия сошла бы за живую
  const body = screen.replace(/const organ(State|Disabled)[\s\S]*?\n  };/g, '');
  const wired = (id: string) => body.includes(`case '${id}'`) || body.includes(`'${id}':`);
  const dead = ids.filter((id) => !wired(id));
  if (dead.length) {
    failed++;
    console.error(`  ✗ кнопки без обработчика: ${dead.join(', ')}`);
  }

  // Обратная сторона: обработчик есть, а кнопки нет. Это не поломка для
  // человека, но это мёртвый код, который потом принимают за живой
  const handled = [...new Set([...body.matchAll(/case '([a-z]+\.[A-Za-z]+)'/g)].map((m) => m[1]))]
    .filter((id) => id.startsWith(ids[0].split('.')[0] + '.'));
  const orphan = handled.filter((id) => !ids.includes(id));
  if (orphan.length) {
    failed++;
    console.error(`  ✗ обработчики без кнопки: ${orphan.join(', ')}`);
  }
}

/**
 * Обещанное сочетание должно работать.
 *
 * Лента показывает `keys` текстом подсказки и НЕ регистрирует команду: это
 * просто надпись. Так и вышло с Ctrl+Shift+S у переводчика — надпись была,
 * обработчика не было, и человек нажимал впустую.
 *
 * Часть сочетаний обрабатывает не экран, а движок таблиц и документов: Ctrl+Z,
 * Ctrl+B и подобные приходят из пресетов Univer. Их приходится объявлять
 * списком — проверить статически, что пресет их зарегистрировал, отсюда
 * нельзя. Зато любое НОВОЕ сочетание без обработчика и без такого объявления
 * теперь роняет проверку.
 */
const FROM_ENGINE = new Set([
  'doc.undo', 'doc.redo', 'doc.bold', 'doc.italic', 'doc.underline',
  'notes.undo', 'notes.redo', 'notes.bold', 'notes.italic', 'notes.underline',
  'sh.undo', 'sh.redo', 'sh.bold', 'sh.italic', 'sh.underline',
  // Ctrl+F у таблицы и документа — UniverSheetsFindReplacePreset
  'sh.find',
  // Ctrl+V — обычная вставка браузера в поле ввода
  'tr.paste',
]);

/** Где искать обработчик сочетания: экраны разделов */
const KEY_SOURCES = [
  'src/screens/TranslateScreen.tsx', 'src/screens/NotesManagement.tsx',
  'src/screens/ConstructorScreen.tsx', 'src/screens/TextDocEditor.tsx',
  'src/screens/Explorer.tsx', 'src/screens/PdfEditor.tsx',
];

/** Все ленты — сочетания объявляются и там, где пары «лента ↔ экран» нет */
const RIBBON_FILES = [
  'src/lib/ribbonDoc.ts', 'src/lib/ribbonSheet.ts', 'src/lib/ribbonPdf.ts',
  'src/lib/ribbonTranslate.ts',
];

{
  const sources = KEY_SOURCES.map((f) => {
    try { return readFileSync(f, 'utf8'); } catch (_) { return ''; }
  }).join('\n');

  let checked = 0;
  for (const file of RIBBON_FILES) {
    let text = '';
    try { text = readFileSync(file, 'utf8'); } catch (_) { continue; }
    for (const m of text.matchAll(/id:\s*'([a-z]+\.[A-Za-z]+)'[^}]*?keys:\s*'([^']+)'/g)) {
      const [, id, keys] = m;
      checked++;
      if (FROM_ENGINE.has(id)) continue;
      // Ищем разбор самой клавиши: 'Ctrl+Shift+S' → в коде должно быть 's',
      // 'Ctrl+Enter' → 'Enter'. Регистр в коде разный, поэтому без разницы
      const last = keys.split('+').pop()!.toLowerCase();
      const hit = new RegExp(`['"]${last}['"]`, 'i').test(sources);
      if (!hit) {
        failed++;
        console.error(`  ✗ ${id}: подсказка обещает ${keys}, обработчика нет (${file})`);
      }
    }
  }
  console.log(`\nСочетаний на лентах — ${checked}; из них движок берёт на себя ${FROM_ENGINE.size}`);
}

if (failed) {
  console.error(`\nПровалено проверок: ${failed}`);
  process.exit(1);
}
console.log('\nВсе кнопки лент подключены, обещанные сочетания работают');
