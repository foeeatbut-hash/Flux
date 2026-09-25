/**
 * Перевод заметок из HTML прежнего редактора в Markdown нового Блокнота.
 *
 * Ошибка здесь стоит дорого: заметка переводится при открытии и при первой
 * правке записывается уже Markdown. Потерянный пункт списка или таблица
 * пропадают из заметки навсегда. То же — у «письмо → заметка».
 *
 * Запуск: npx tsx scripts/test-html-to-markdown.ts
 */
import { readFileSync } from 'node:fs';
import { htmlToMarkdown, looksLikeHtml, noteText, decodeEntities } from '../src/lib/htmlToMarkdown';

let failed = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  if (cond) return;
  failed++;
  console.error(`  ✗ ${name}${got === undefined ? '' : ` — получили ${JSON.stringify(got)}`}`);
};
const md = (h: string) => htmlToMarkdown(h).trim();

console.log('Узнаём, что перед нами');
check('HTML прежнего редактора', looksLikeHtml('<p>текст</p>'));
check('таблица без абзаца — тоже HTML', looksLikeHtml('<table><tr><td>1</td></tr></table>'));
check('Markdown — не HTML', !looksLikeHtml('# Заголовок\n\n- пункт'));
check('знак «меньше» в тексте — не HTML', !looksLikeHtml('расход < 1200'));
check('пустое — не HTML', !looksLikeHtml(''));

console.log('Блоки');
check('заголовки', md('<h1>А</h1><h3>Б</h3>') === '# А\n\n### Б', md('<h1>А</h1><h3>Б</h3>'));
check('абзацы через пустую строку', md('<p>раз</p><p>два</p>') === 'раз\n\nдва');
check('перенос строки — жёсткий', md('<p>раз<br>два</p>') === 'раз\\\ndva'.replace('dva', 'два'), md('<p>раз<br>два</p>'));
check('черта', md('<p>а</p><hr><p>б</p>') === 'а\n\n---\n\nб');
check('цитата', md('<blockquote>раз<br>два</blockquote>').startsWith('> раз'));
check('код сохраняет строки', md('<pre>x = 1\ny = 2</pre>') === '```\nx = 1\ny = 2\n```');

console.log('Списки');
check('маркированный', md('<ul><li>а</li><li>б</li></ul>') === '- а\n- б');
check('нумерованный с начала', md('<ol start="3"><li>а</li><li>б</li></ol>') === '3. а\n4. б');
check('вложенный', md('<ul><li>а<ul><li>б</li></ul></li></ul>') === '- а\n   - б', md('<ul><li>а<ul><li>б</li></ul></li></ul>'));
check('галочки прежнего редактора', md('<ul><li data-checked="true"><p>готово</p></li><li data-checked="false">нет</li></ul>') === '- [x] готово\n- [ ] нет',
  md('<ul><li data-checked="true"><p>готово</p></li><li data-checked="false">нет</li></ul>'));
check('незакрытые пункты', md('<ul><li>а<li>б</ul>') === '- а\n- б', md('<ul><li>а<li>б</ul>'));

console.log('Таблица');
{
  const t = md('<table><tr><th>Тег</th><th>Расход</th></tr><tr><td>П1</td><td>1200 | 1300</td></tr></table>');
  check('шапка и разделитель', t.split('\n')[1] === '| --- | --- |', t);
  check('ячейки на месте, черта экранирована', t.includes('| П1 | 1200 \\| 1300 |'), t);
}

console.log('Строка');
check('жирный и курсив', md('<p><b>а</b> и <em>б</em></p>') === '**а** и *б*');
check('пробел внутри жирного не ломает разметку', md('<p><b>а </b>б</p>') === '**а** б', md('<p><b>а </b>б</p>'));
check('ссылка на тег Flux', md('<p><a href="flux:tag/abc">П1</a></p>') === '[П1](flux:tag/abc)');
check('javascript: не становится ссылкой', !md('<p><a href="javascript:alert(1)">x</a></p>').includes('javascript'));
check('звёздочка в тексте экранирована', md('<p>a*b</p>') === 'a\\*b');
check('угловая скобка экранирована', md('<p>&lt;b&gt;</p>') === '\\<b>', md('<p>&lt;b&gt;</p>'));
check('картинка', md('<p><img src="data:image/png;base64,AAA" alt="схема"></p>') === '![схема](data:image/png;base64,AAA)');
check('сущности', decodeEntities('&laquo;а&raquo;&nbsp;&#8212;&#x41;') === '«а» —A');
check('script и style вырезаны', !md('<p>а</p><script>alert(1)</script><style>p{}</style>').includes('alert'));

console.log('Письмо в Блокнот');
{
  const head = '<p><b>Из письма</b><br>От: Иван &lt;ivan@example.ru&gt;<br>Дата: 1 мая</p><hr>';
  const out = md(head + '<p>Привет,&nbsp;коллеги!</p>');
  check('шапка письма — строками', out.startsWith('**Из письма**\\\nОт: Иван \\<ivan@example.ru>\\\nДата: 1 мая'), out);
  check('тело письма на месте', out.endsWith('Привет, коллеги!'), out);
}

console.log('Текст для списка и поиска');
check('без разметки Markdown', noteText('## Итоги\n\n- **раз**\n- [x] два\n\n[П1](flux:tag/a)') === 'Итоги раз два П1',
  noteText('## Итоги\n\n- **раз**\n- [x] два\n\n[П1](flux:tag/a)'));
check('и без прежнего HTML', noteText('<p>раз</p><p>два</p>') === 'раз два');

console.log('Кто пишет заметки');
{
  const mail = readFileSync('server/routes/mailLink.ts', 'utf8');
  check('письмо кладётся в Блокнот Markdown', /content:\s*htmlToMarkdown\(/.test(mail));
  check('прежнего редактора заметок нет', !readFileSync('src/screens/NotesManagement.tsx', 'utf8').includes('RichTextEditor')
    && !readFileSync('src/screens/StickerWindow.tsx', 'utf8').includes('RichTextEditor'));
}

if (failed) { console.error(`\nПровалов: ${failed}`); process.exit(1); }
console.log('\nВсё верно');
