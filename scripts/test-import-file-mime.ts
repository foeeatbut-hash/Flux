import assert from 'node:assert/strict';
import { importFileMime } from '../src/lib/importFileMime.js';

const cases: Array<[string, string]> = [
  ['drawing.png', 'image/png'], ['photo.jpg', 'image/jpeg'], ['scan.JPEG', 'image/jpeg'],
  ['table.csv', 'text/csv'], ['book.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['manual.pdf', 'application/pdf'], ['opaque.unknown', ''],
];
let failed = 0;
for (const [name, expected] of cases) {
  try { assert.equal(importFileMime(name), expected); console.log(`PASS ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL ${name}`, error); }
}
console.log(`${cases.length - failed}/${cases.length} MIME compatibility checks passed`);
if (failed) process.exitCode = 1;
