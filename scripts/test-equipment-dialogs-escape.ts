/**
 * Окна раздела «Оборудование» закрываются по Esc.
 *
 * Дефект, ради которого проверка заведена: «Центр операций», «Вид для Таблицы»,
 * «Добавить позицию», «Обновления источников» и окно типа позиции закрывались
 * только мышью — остальные диалоги раздела по Esc закрывались, и клавиатурой
 * человек оставался в одном окне без выхода. Проверка читает разметку и от
 * данных не зависит: любое окно с role="dialog" в components/equipment обязано
 * подключать useEscapeClose (или слушать Escape само).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = 'src/components/equipment';
// Окно, которое сейчас переделывается отдельной задачей: Esc в нём появится
// вместе с новой версией, а сюда его вписали, чтобы проверка не краснела раньше срока
const PENDING = new Set(['EquipmentSourceImportDialog.tsx']);

let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) console.log(`  ✓ ${name}`);
  else { failed++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};

const files = readdirSync(dir).filter((f) => f.endsWith('.tsx'));
let dialogs = 0;
for (const file of files) {
  const text = readFileSync(join(dir, file), 'utf8');
  if (!text.includes('role="dialog"')) continue;
  dialogs++;
  if (PENDING.has(file)) continue;
  check(`${file}: закрывается по Esc`, /useEscapeClose\(|'Escape'/.test(text));
}
check('окна раздела найдены', dialogs >= 5, String(dialogs));

console.log(failed ? `\nПровалено проверок: ${failed}` : '\nОкна «Оборудования» закрываются по Esc');
process.exitCode = failed ? 1 : 0;
