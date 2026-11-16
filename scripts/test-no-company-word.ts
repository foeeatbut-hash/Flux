/**
 * Слово «компания» в значении «наша организация» не пишется в src, server,
 * studio, shared (решение владельца: docs/plan.md). Исключения перечислены
 * явно, по файлу, с причиной: это данные (поле «Компания» проекта, корень
 * дерева подразделений, чужие организации), а не слова программы.
 *
 * Мутация, которой набор проверен: вернуть слово в любой файл вне исключений —
 * набор падает.
 */
import fs from 'node:fs';
import path from 'node:path';

type Allow = { file: RegExp; why: string };
const ALLOW: Allow[] = [
  { file: /^shared\/departments\.ts$|^server\/departments(Match)?\.ts$|^src\/components\/users\/(DepartmentDialogs|DepartmentsTab|LegacyWizard|EmployeeImportDialog)\.tsx$/,
    why: 'корень дерева подразделений называется «Компания» — это данные, а не слово программы' },
  { file: /^src\/translate\/dict\//, why: 'словарь перевода: «компания» — переводимый текст чужих документов' },
];
const ROOTS = ['src', 'server', 'studio', 'shared'];
const SKIP_DIR = new Set(['node_modules', 'dist', '.git']);

const files: string[] = [];
const walk = (d: string) => {
  if (!fs.existsSync(d)) return;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (SKIP_DIR.has(e.name)) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(tsx?|cjs|mjs|js|md|json)$/.test(e.name)) files.push(p.split(path.sep).join('/'));
  }
};
ROOTS.forEach(walk);

const bad: string[] = [];
for (const f of files) {
  if (ALLOW.some((a) => a.file.test(f))) continue;
  fs.readFileSync(f, 'utf8').split('\n').forEach((l, i) => {
    if (/компани/i.test(l)) bad.push(`${f}:${i + 1}: ${l.trim().slice(0, 120)}`);
  });
}
if (bad.length) {
  console.error(`✗ слово «компания» найдено вне исключений (${bad.length}):\n${bad.join('\n')}`);
  process.exit(1);
}
console.log(`✓ в ${files.length} файлах нет слова «компания» вне перечня исключений`);
