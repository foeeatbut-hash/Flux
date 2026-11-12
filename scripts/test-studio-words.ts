/**
 * Слова интерфейса Studio (обе сборки): без «канал», «договор», «привязки», «манифест», «бандл».
 *
 * Решение владельца (12 ноября 2026): человек видит «для всех / пробная группа», «описание данных», «источник значения»,
 * «описание программы». Проверка читает исходники Studio настоящим разбором TypeScript и смотрит ТОЛЬКО то, что попадает
 * на экран или в сообщение: строки, шаблонные строки и текст разметки. Комментарии и имена в коде (channel, manifest,
 * contract) не трогаются. Проверка не пустая: на синтетическом исходнике она находит каждое запрещённое слово.
 *
 * Запуск: npx tsx scripts/test-studio-words.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const root = path.resolve(__dirname, '..');
const FORBIDDEN = /канал|договор|привяз|манифест|бандл/i;
const SKIP_DIRS = new Set(['node_modules', 'fixtures', 'vendor', 'scripts']);
let passed = 0;
const ok = (name: string, value: unknown) => { assert.ok(value, name); passed++; console.log(`  ✓ ${name}`); };

/** Тексты исходника, которые увидит человек: строки, куски шаблонов, текст разметки */
function visibleTexts(name: string, text: string): Array<{ line: number; text: string }> {
  const kind = name.endsWith('x') ? ts.ScriptKind.TSX : name.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, kind);
  const found: Array<{ line: number; text: string }> = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isJsxText(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      found.push({ line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, text: node.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}
/** Текст страниц .html: без тегов и комментариев */
const htmlTexts = (text: string) => text.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ');

function files(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) files(full, out); }
    else if (/\.(ts|tsx|cjs|js|html)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

console.log('Проверка самой проверки');
for (const word of ['канал', 'договор', 'привязка', 'манифест', 'бандл']) {
  ok(`слово «${word}» в строке находится`, visibleTexts('x.tsx', `const a = <p>Тут ${word}</p>; const b = '${word}'; const c = \`${word}\`;`).filter((t) => FORBIDDEN.test(t.text)).length === 3);
}
ok('в комментарии и имени слово не считается', visibleTexts('x.ts', '// канал и договор\nconst channel = 1; /* бандл */').length === 0);
ok('в тексте страницы слово находится', FORBIDDEN.test(htmlTexts('<p>Манифест</p>')) && !FORBIDDEN.test(htmlTexts('<!-- канал --><p>Данные</p>')));

console.log('Тексты Studio');
const bad: string[] = [];
let scanned = 0;
for (const file of files(path.join(root, 'studio'))) {
  const text = fs.readFileSync(file, 'utf8');
  scanned++;
  const hits = file.endsWith('.html') ? (FORBIDDEN.test(htmlTexts(text)) ? [{ line: 0, text: htmlTexts(text).match(FORBIDDEN)![0] }] : []) : visibleTexts(file, text).filter((t) => FORBIDDEN.test(t.text));
  for (const hit of hits) bad.push(`${path.relative(root, file)}:${hit.line}: ${hit.text.replace(/\s+/g, ' ').slice(0, 80)}`);
}
ok(`просмотрено файлов: ${scanned}`, scanned > 80);
if (bad.length) console.log(bad.join('\n'));
ok('запрещённых слов в текстах интерфейса нет', bad.length === 0);

console.log(`\nFlux Studio: слова интерфейса — ${passed} проверок пройдено`);
