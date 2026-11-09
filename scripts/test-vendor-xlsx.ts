/**
 * Библиотека Excel лежит в репозитории (vendor/xlsx) и ставится из неё: сборка
 * не ходит на cdn.sheetjs.com. Проверяется целостность архива и согласие
 * package.json, package-lock.json и таблицы в vendor/xlsx/README.md.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

let passed = 0;
const check = (name: string, condition: unknown, detail?: unknown) => { assert.ok(condition, `${name}${detail === undefined ? '' : ': ' + JSON.stringify(detail)}`); passed++; console.log(`✓ ${name}`); };

const file = 'vendor/xlsx/xlsx-0.20.3.tgz';
const bytes = readFileSync(file);
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const readme = readFileSync('vendor/xlsx/README.md', 'utf8');

check('SHA-256 архива совпадает с таблицей в README', readme.includes(createHash('sha256').update(bytes).digest('hex')));
check('package.json ставит xlsx из файла в репозитории', pkg.dependencies.xlsx === `file:${file}`, pkg.dependencies.xlsx);
const entry = lock.packages['node_modules/xlsx'];
check('lock ссылается на тот же файл и версию 0.20.3', entry?.resolved === `file:${file}` && entry.version === '0.20.3', entry);
check('SHA-512 в lock совпадает с архивом', entry.integrity === `sha512-${createHash('sha512').update(bytes).digest('base64')}`);
check('корневая зависимость в lock совпадает с package.json', lock.packages[''].dependencies.xlsx === pkg.dependencies.xlsx);
check('ни lock, ни package.json не ссылаются на сеть за xlsx', !/cdn\.sheetjs\.com|registry\.npmjs\.org\/xlsx\//.test(JSON.stringify(entry) + JSON.stringify(pkg.dependencies)));
check('старые зависимости 0.18 (adler-32, cfb, ssf и др.) из lock убраны', !['adler-32', 'cfb', 'codepage', 'frac', 'ssf', 'wmf', 'word'].some((n) => lock.packages[`node_modules/${n}`]));

// Установленный пакет — именно эта версия и читает/пишет книгу
const XLSX = createRequire(import.meta.url)('xlsx');
check('установлена версия 0.20.3', XLSX.version === '0.20.3', XLSX.version);
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Тег', 'Расход'], ['П1', 1200]]), 'Лист1');
const back = XLSX.read(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' });
check('книга пишется и читается обратно', JSON.stringify(XLSX.utils.sheet_to_json(back.Sheets['Лист1'], { header: 1 })) === JSON.stringify([['Тег', 'Расход'], ['П1', 1200]]));

console.log(`vendor-xlsx: ${passed} проверок пройдено`);
