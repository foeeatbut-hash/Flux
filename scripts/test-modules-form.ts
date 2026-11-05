import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateModuleForm } from '../modules/validateForm';
import { buildModuleAssets } from '../modules/build';
import { bundledModules } from '../modules/bundled';

let complete = false;
process.on('exit', () => { if (!complete) process.exitCode = 1; });
let passed = 0;
const check = (name: string, value: unknown) => { assert.ok(value, name); passed++; console.log(`✓ ${name}`); };
async function main() {
  const manifest = bundledModules[0];
  const original = JSON.parse(fs.readFileSync(`modules/fixtures/${manifest.id}/form.json`, 'utf8'));
  validateModuleForm(original, manifest.id, manifest.reads);
  check('привязки примера соответствуют схемам договора', true);
  const cwd = process.cwd();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-bad-form-'));
  const fixture = path.join(temp, 'modules/fixtures', manifest.id);
  fs.mkdirSync(fixture, { recursive: true });
  try {
    for (const bad of ['flux.bogus.x', 'flux.equipment.bogus', 'flux.project.name.nope']) {
      const form = structuredClone(original);
      form.groups[0].fields[0].bind = bad;
      fs.writeFileSync(path.join(fixture, 'form.json'), JSON.stringify(form));
      // Настоящий сборщик обязан остановиться до поиска исходников Worker.
      process.chdir(temp);
      await assert.rejects(buildModuleAssets('', {}), error => error instanceof Error
        && error.message.includes('form.json') && error.message.includes(bad) && error.message.includes('неизвестная привязка'));
      process.chdir(cwd);
      check(`сборка отклоняет ${bad} с понятной причиной`, true);
    }
    const form = structuredClone(original);
    form.tables[0].columns[0].key = 'bogus';
    assert.throws(() => validateModuleForm(form, manifest.id, manifest.reads), /неизвестная колонка/);
    check('колонки таблицы также проверяются по items схемы', true);
    complete = true;
    console.log(`${passed} проверок пройдено`);
  } finally { process.chdir(cwd); fs.rmSync(temp, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
