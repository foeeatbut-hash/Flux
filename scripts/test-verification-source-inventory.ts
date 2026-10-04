import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanSourceControls, programSourceInventory, registeredRoutes } from '../verification/sourceInventory';

const example = `// <button onClick={fake}>ignored comment</button>
const text = '<button onClick={fake}>ignored string</button>';
const app = <><Btn onClick={save}>Сохранить</Btn><input aria-label="Имя" onChange={rename}/>
<a href="/equipment">Оборудование</a><div role="button" onKeyDown={open}>Карточка</div>
<span>Не действие</span><button disabled>Удалить</button></>;
window.addEventListener('keydown', shortcuts);
ipcMain.handle('files:save', saveFile);`;
const bindings = scanSourceControls('fixture.tsx', example);
assert.equal(bindings.length, 7, 'comments and JSX-looking strings cannot invent clickable controls');
assert.deepEqual(bindings.filter(b => b.kind === 'jsx').map(b => b.label), ['Сохранить', 'Имя', 'Оборудование', 'Карточка', 'Удалить']);
assert.equal(bindings[0].line, 3);
assert.deepEqual(bindings.filter(b => b.kind === 'registration').map(b => b.label), ['keydown', 'files:save']);
assert.deepEqual(scanSourceControls('fixture.html', '<!-- <button id="fake"> --><button id="save" onclick="save()">Сохранить</button><a>текст</a>').map(b => b.label), ['save']);
assert.deepEqual(registeredRoutes(`const paths = [{path:'/doc'}, {path:'/doc'}, {path:'/office-doc'}]; // path:'/fake'`), ['/doc', '/office-doc']);

const root = mkdtempSync(join(tmpdir(), 'flux-inventory-'));
const outside = mkdtempSync(join(tmpdir(), 'flux-outside-'));
try {
  writeFileSync(join(root, 'fixture.tsx'), example);
  const inventory = programSourceInventory(root, [{id:'notes',sources:['fixture.tsx','fixture.tsx']}]);
  assert.equal(inventory[0].controls.length, 7, 'duplicate source does not inflate inventory');
  assert.equal(inventory[0].status, 'INVENTORY_ONLY', 'source binding discovery cannot certify real button behavior');
  writeFileSync(join(outside, 'secret.tsx'), '<button>outside</button>');
  assert.throws(() => programSourceInventory(root, [{id:'unsafe',sources:['../' + outside.split(/[\\/]/).pop() + '/secret.tsx']}]), /outside workspace/);
  if (process.platform !== 'win32') {
    symlinkSync(join(outside, 'secret.tsx'), join(root, 'link.tsx'));
    assert.throws(() => programSourceInventory(root, [{id:'unsafe',sources:['link.tsx']}]), /outside workspace/);
  }
} finally { rmSync(root,{recursive:true,force:true}); rmSync(outside,{recursive:true,force:true}); }
console.log('✓ Исходные элементы: комментарии, строки, клавиатура, native-каналы, дубликаты и выход за границы стенда');
