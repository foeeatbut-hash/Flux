// У пользователя Flux встроенных программ нет: «Параметры позиции» убрана из обычного Flux,
// остаётся образцом в Studio. Установленная программа (в том числе с прежним id образца)
// идёт обычным путём выпуска и не должна упираться в список встроенных.
import fs from 'fs';
import path from 'path';
import { bundledModules } from '../modules/bundled';
import { sampleModules } from '../modules/sampleModules';
import { validManifest } from '../modules/schemas';

let failed = 0;
const ok = (name: string, cond: boolean) => { if (!cond) { failed++; console.error(`ПРОВАЛ: ${name}`); } else console.log(`ok: ${name}`); };

ok('встроенных программ в обычном Flux нет', bundledModules.length === 0);
// Те же выражения, что в ModuleHost и ModuleLaunchActions: пустой список не роняет ни поиск, ни слияние.
const id = sampleModules[0].id;
ok('поиск встроенной по адресу не находит и не падает', bundledModules.find(item => `/module/${id}` === `/module/${item.id}`) === undefined);
const installed = [{ manifest: sampleModules[0] }];
const merged = [...bundledModules, ...installed.map(i => i.manifest).filter(m => !bundledModules.some(b => b.id === m.id))];
ok('установленная программа с id образца остаётся в списке запуска', merged.length === 1 && merged[0].id === id);
ok('манифест образца для проверок цел', !!validManifest(sampleModules[0]));
ok('образец остаётся в Studio («Новая программа»)', fs.readFileSync(path.join(__dirname, '../studio/renderer/editors/sample.ts'), 'utf8').includes("id: 'equipment-inspector'"));
if (failed) process.exit(1);
