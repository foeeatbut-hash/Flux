/**
 * Редакторы подпрограммы в Studio: модульные проверки без браузера.
 *
 * Что проверяется: разбор form.json с номерами строк; схема и привязки; двусторонняя
 * синхронизация текста и визуальной формы (и что неверный текст не затирает форму); операции
 * перестановки; настоящие типы из договора (настоящим компилятором TypeScript, с мутациями);
 * подсказки и проверка кода; checkFormDesign — каждое правило с мутацией; выписка из
 * методологии совпадает с документом.
 *
 * Запуск: npx tsx scripts/test-studio-editor.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import Ajv from 'ajv';
import { formSchema } from '../modules/formSchema';
import { validateSchema } from '../modules/miniSchema';
import { binding as readFlux, isVisible as visible, renderForm, type ModuleForm } from '../modules/runtime/form';
import { parseJson } from '../studio/renderer/editors/jsonText';
import { bindingProblems, structureProblems } from '../studio/renderer/editors/formSchema';
import { applyForm, applyText, formStateFromForm, recheck } from '../studio/renderer/editors/formStore';
import { addComponent, applyDrop, dropComponent, moveSelected, removeSelected, serializeForm, updateSelected } from '../studio/renderer/editors/formModel';
import { ownerEditablePaths, ownerEditViolations, ownerMayEdit } from '../modules/trust/ownerEdit';
import { diffFiles } from '../modules/trust/diff';
import { codeFiles, contractChanges, contractFromFiles, inferValues, languageOfPath } from '../studio/renderer/editors/packageFiles';
import { sampleContract, sampleFiles, sampleData, sampleForm, sampleLogic } from '../studio/renderer/editors/sample';
import { bindingOptions, columnKeys, resolveBinding } from '../studio/renderer/editors/contractModel';
import { contractReference, generateContractDts } from '../studio/renderer/editors/contractTypes';
import { checkOther, checkScript, completeScript } from '../studio/renderer/editors/codeSupport';
import { checkFormDesign } from '../studio/renderer/editors/designCheck';
import { PALETTE, guidanceFor } from '../studio/renderer/editors/methodology';
import { extractMethodology, generate, TARGET } from './gen-studio-editor-methodology';
import { validateModuleForm } from '../modules/validateForm';
import type { ContractDraft, FormDef } from '../studio/renderer/editors/types';

let passed = 0;
const ok = (name: string, value: unknown) => { assert.ok(value, name); passed++; console.log(`  ✓ ${name}`); };
const eq = (name: string, actual: unknown, expected: unknown) => { assert.deepEqual(actual, expected, name); passed++; console.log(`  ✓ ${name}`); };
const throws = (name: string, fn: () => unknown) => { assert.throws(fn, undefined, name); passed++; console.log(`  ✓ ${name}`); };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const contract = sampleContract();

console.log('Разбор JSON с номерами строк');
{
  const good = parseJson('{\n  "a": [1,\n    {"b": true}]\n}');
  ok('верный текст разобран', good.ok);
  eq('место вложенного значения — своя строка', good.place(['a', 1, 'b']).line, 3);
  eq('место ключа', good.place(['a'], true), { line: 2, column: 3 });
  const cases: Array<[string, string, number, RegExp]> = [
    ['пустой файл', '', 1, /пуст/],
    ['пропущена запятая', '{\n"a": 1\n"b": 2\n}', 3, /Ожидалось «,» или «\}»/],
    ['лишняя запятая', '{\n"a": 1,\n}', 3, /Лишняя запятая перед «\}»/],
    ['лишняя запятая в списке', '[1,\n2,\n]', 3, /перед «\]»/],
    ['строка не закрыта', '{\n"a": "x\n}', 2, /не закрыта/],
    ['одинарные кавычки', "{\n'a': 1}", 2, /имя поля в кавычках/],
    ['нет значения', '{\n"a": }', 2, /пропущено значение/],
    ['лишний текст', '{}\n}', 2, /лишний текст/],
    ['повтор поля', '{\n"a": 1,\n"a": 2}', 3, /повторяется/],
    ['мусор вместо значения', '{"a": nope}', 1, /Неожиданный символ/],
  ];
  for (const [name, text, line, message] of cases) {
    const result = parseJson(text);
    ok(`${name}: ошибка`, !result.ok);
    eq(`${name}: строка ${line}`, result.problem!.line, line);
    ok(`${name}: текст понятный`, message.test(result.problem!.message));
  }
  // Мутация: то, что разбор принял, принимает и JSON.parse (иначе Flux отверг бы форму)
  for (const text of ['{"a":[1,2,{"b":null}],"c":"\\u00e9\\n"}', '  [ ]  ', '"x"', '-1.5e3']) eq(`совпадает с JSON.parse: ${text}`, parseJson(text).value, JSON.parse(text));
  for (const text of ['{"a":01}', '{"a":1,}', '[1 2]', '{"a":"\t"}', '{a:1}', '"\\x"']) { throws(`JSON.parse отвергает ${JSON.stringify(text)}`, () => JSON.parse(text)); ok(`и наш разбор отвергает ${JSON.stringify(text)}`, !parseJson(text).ok); }
}

console.log('Схема формы');
{
  const text = serializeForm(sampleForm());
  eq('образец проходит схему', structureProblems(text).problems, []);
  const mutate = (change: (form: any) => void) => { const form = clone(sampleForm()); change(form); return structureProblems(JSON.stringify(form, null, 2)); };
  const typo = mutate(form => { form.groups[0].fields[1].lable = form.groups[0].fields[1].label; });
  ok('опечатка в имени поля найдена', typo.problems.some(p => /Неизвестное поле «lable»/.test(p.message)));
  const typoText = serializeForm(sampleForm()).split("\n");
  const version = mutate(form => { form.version = 2; });
  ok('версия 2 отвергнута понятным текстом', /версии 1/.test(version.problems[0].message));
  eq('строка ошибки версии — вторая', version.problems[0].line, 2);
  const missing = mutate(form => { delete form.groups[1].fields[0].bind; });
  ok('нет bind: «Не хватает поля»', missing.problems.some(p => /Не хватает поля «bind»/.test(p.message)));
  ok('нет bind: строка внутри второй группы', missing.problems[0].line > typoText.findIndex(line => line.includes('Расчёт')));
  const wrongType = mutate(form => { form.groups[1].fields[1].unit = 5; });
  ok('unit числом: «Ожидается строка»', wrongType.problems.some(p => /Ожидается строка/.test(p.message)));
  ok('удалённое свойство ввода (min) названо неизвестным', mutate(form => { form.groups[1].fields[1].min = 0; }).problems.some(p => /Неизвестное поле «min»/.test(p.message)));
  const wrongOp = mutate(form => { form.groups[1].fields[1].visibleIf.op = 'maybe'; });
  ok('неизвестное условие показа перечисляет допустимые', wrongOp.problems.some(p => /«eq», «ne», «filled», «empty»/.test(p.message)));
  const wrongKind = mutate(form => { form.groups[0].fields[2].kind = 'mono'; });
  ok('kind только code', wrongKind.problems.length > 0);
  ok('обработчик с пробелом отвергнут', mutate(form => { form.onDataChanged = 'пересчёт'; }).problems.length > 0);
  // Старая форма из пакета Flux остаётся верной
  const fixture = fs.readFileSync(path.join(__dirname, '../modules/fixtures/equipment-inspector/form.json'), 'utf8');
  eq('form.json из modules/fixtures проходит схему', structureProblems(fixture).problems, []);
}

console.log('Своя проверка схемы согласна с Ajv (Ajv в окне Studio не запускается: CSP без unsafe-eval)');
{
  const ajv = new Ajv({ allErrors: true, strict: false });
  const check = ajv.compile(formSchema);
  const base = clone(sampleForm()) as any;
  const mutations: Array<(f: any) => void> = [
    () => {}, f => { f.version = 2; }, f => { delete f.groups; }, f => { f.groups[0].fields[0].bind = 5; }, f => { f.groups[0].fields[0].extra = 1; },
    f => { f.groups[0].title = 'x'.repeat(121); }, f => { f.onDataChanged = 'bad name'; },
    f => { f.groups[1].fields[1].visibleIf.op = 'zz'; }, f => { f.tables[0].columns[0].align = 'start'; }, f => { f.groups[1].fields[1].unit = 5; },
    f => { f.tables = {}; }, f => { f.groups[0].fields[0].kind = 'mono'; }, f => { f.groups[0].fields[0].hint = 5; },
    // ключи, которые находятся по цепочке прототипов: Ajv их отвергает, наивная проверка пропускала
    f => { JSON.parse; Object.defineProperty(f, 'constructor', { value: 1, enumerable: true }); }, f => { Object.defineProperty(f.groups[0], 'toString', { value: 1, enumerable: true }); },
    f => { Object.defineProperty(f, '__proto__', { value: {}, enumerable: true }); }, f => { Object.defineProperty(f.groups[0].fields[0], 'hasOwnProperty', { value: 1, enumerable: true }); },
  ];
  for (const [i, mutate] of mutations.entries()) {
    const form = clone(base); mutate(form);
    eq(`мутация ${i}: решение совпадает с Ajv`, structureProblems(JSON.stringify(form)).problems.length === 0, check(form));
    eq(`мутация ${i}: и Studio, и выпуск решают так же`, validateSchema(formSchema, form).length === 0, check(form));
  }
}

console.log('Привязки и согласие с проверкой выпуска');
{
  const form = sampleForm();
  const text = serializeForm(form);
  eq('в образце привязки верны', bindingProblems(text, form, contract), []);
  const bad = (change: (f: FormDef) => void, c: ContractDraft = contract) => {
    const next = clone(form); change(next);
    return bindingProblems(serializeForm(next), next, c);
  };
  const unknownPath = bad(f => { f.groups[0].fields[1].bind = 'flux.equipment.nme'; });
  ok('несуществующий путь', /нет пути «nme»/.test(unknownPath[0].message));
  {
    const next = clone(form); next.groups[0].fields[1].bind = 'flux.equipment.nme';
    ok('строка ошибки — строка с этой привязкой', serializeForm(next).split('\n')[unknownPath[0].line - 1].includes('flux.equipment.nme'));
  }
  ok('данные не из reads', /не разрешены/.test(bad(f => { f.groups[0].fields[0].bind = 'flux.catalog.families'; })[0].message));
  ok('state без объявления', /не объявлено в договоре/.test(bad(f => { f.groups[1].fields[1].bind = 'state.unknown'; })[0].message));
  ok('пустая привязка', /не выбрана/.test(bad(f => { f.groups[0].fields[0].bind = ''; })[0].message));
  ok('таблица на не-список', /должна ссылаться на список/.test(bad(f => { f.tables[0].bind = 'flux.equipment.name'; })[0].message));
  ok('колонка вне схемы', /нет поля «zzz»/.test(bad(f => { f.tables[0].columns[0].key = 'zzz'; })[0].message));
  ok('список в поле', /нужна таблица/.test(bad(f => { f.groups[0].fields[0].bind = 'flux.equipment.params'; })[0].message));
  ok('условие показа с чужой привязкой', /Условие показа/.test(bad(f => { f.groups[1].fields[1].visibleIf!.bind = 'state.nope'; })[0].message));
  ok('таблица на state — как при выпуске', /должна ссылаться на список из данных Flux/.test(bad(f => { f.tables[0].bind = 'state.mode'; })[0].message));
  // Мутация договора: убрали чтение equipment — привязки сломались
  const noEquipment: ContractDraft = { ...contract, reads: ['project', 'tag'] };
  ok('договор без equipment ломает привязки', bindingProblems(text, form, noEquipment).length >= 3);
  // Согласие с modules/validateForm.ts: что он принимает, принимаем и мы
  const plain = { version: 1, groups: form.groups.map(g => ({ title: g.title, fields: g.fields.filter(f => f.bind.startsWith('flux.')).map(f => ({ label: f.label, bind: f.bind })) })), tables: form.tables };
  validateModuleForm(plain, 'sample', contract.reads);
  eq('validateForm принимает ту же форму — и у нас нет замечаний к flux.*', bindingProblems(JSON.stringify(plain, null, 2), plain as FormDef, contract), []);
  const broken = clone(plain); broken.groups[0].fields[0].bind = 'flux.equipment.nme';
  throws('validateForm отвергает опечатку', () => validateModuleForm(broken, 'sample', contract.reads));
  ok('и мы её видим', bindingProblems(JSON.stringify(broken, null, 2), broken as FormDef, contract).length === 1);
  ok('список привязок содержит выходы и state', ['calc.out.pressure', 'state.mode', 'flux.equipment.itemCode'].every(p => bindingOptions(contract).some(o => o.path === p)));
  ok('список привязок не содержит неразрешённого', !bindingOptions(contract).some(o => o.path.startsWith('flux.catalog')));
  eq('колонки таблицы из схемы', columnKeys('flux.equipment.params', contract), ['group', 'key', 'value', 'unit']);
  ok('state.recalculations объявлен', resolveBinding('state.recalculations', contract).ok);
}

console.log('Один источник истины: визуальный и текстовый редакторы');
{
  let state = formStateFromForm(sampleForm(), contract);
  // Визуально → текст
  const added = addComponent(state.form, 'field', { kind: 'group', g: 0 });
  state = applyForm(state, updateSelected(added.form, added.selection, { label: 'Давление', bind: 'calc.out.pressure', unit: 'Па' }), contract);
  ok('правка в визуальном видна в тексте', state.text.includes('"label": "Давление"') && state.text.includes('"unit": "Па"'));
  eq('текст разбирается в ту же форму', JSON.parse(state.text).groups[0].fields[4], { label: 'Давление', bind: 'calc.out.pressure', unit: 'Па' });
  // Текст → визуально
  const edited = state.text.replace('"label": "Давление"', '"label": "Напор"');
  state = applyText(state, edited, contract);
  ok('правка в тексте видна в форме', state.form.groups[0].fields[4].label === 'Напор');
  eq('текст остаётся как набран', state.text, edited);
  // Неверный текст не затирает форму
  const keep = state.form;
  const broken = applyText(state, edited.replace('"unit": "Па"', '"unit": "Па"\n"hint": 1'), contract);
  ok('при ошибке форма прежняя', broken.form === keep && !broken.textValid);
  ok('ошибка с номером строки и словами', broken.problems.length === 1 && broken.problems[0].line > 1 && /Ожидалось/.test(broken.problems[0].message));
  const schemaBroken = applyText(state, edited.replace('"bind": "calc.out.pressure"', '"bind": 5'), contract);
  ok('ошибка схемы тоже не затирает форму', schemaBroken.form === keep && schemaBroken.problems[0].line > 1);
  // Исправили — форма снова обновляется
  const fixed = applyText(broken, edited.replace('"label": "Напор"', '"label": "Напор воздуха"'), contract);
  ok('после исправления форма принимает текст', fixed.textValid && fixed.form.groups[0].fields[4].label === 'Напор воздуха' && fixed.problems.length === 0);
  // Визуальная правка при испорченном тексте — текст пересоздаётся из последней верной формы
  const visual = applyForm(broken, broken.form, contract);
  ok('визуальная правка заменяет испорченный текст верным', visual.textValid && !visual.text.includes('"hint": 1\n'));
  // Договор меняется — привязки перепроверяются
  const lessReads = recheck(state, { ...contract, reads: ['project'] });
  ok('смена договора обновляет замечания по привязкам', lessReads.bindings.length > state.bindings.length);
  eq('форма после круга текст→форма→текст стабильна', serializeForm(JSON.parse(serializeForm(sampleForm()))), serializeForm(sampleForm()));
}

console.log('Операции над формой: добавление и перестановка');
{
  const form = sampleForm();
  const names = (f: FormDef) => f.groups[0].fields.map(x => x.label);
  const down = moveSelected(form, { kind: 'field', g: 0, f: 0 }, 1);
  eq('поле вниз (клавиши)', names(down.form).slice(0, 2), ['Наименование', 'Проект']);
  eq('выделение следует за полем', down.selection, { kind: 'field', g: 0, f: 1 });
  eq('у края остаётся на месте', moveSelected(form, { kind: 'field', g: 0, f: 0 }, -1).form, form);
  const drop = dropComponent(form, { kind: 'field', g: 0, f: 0 }, { kind: 'field', g: 1, f: 0, index: 2 });
  eq('перетаскивание поля в другую группу', [drop!.form.groups[0].fields.length, drop!.form.groups[1].fields[2].label], [3, 'Проект']);
  const same = dropComponent(form, { kind: 'field', g: 0, f: 0 }, { kind: 'field', g: 0, f: 0, index: 3 });
  eq('внутри группы место считается до удаления', names(same!.form), ['Наименование', 'Код позиции', 'Проект', 'Тег']);
  const groups = dropComponent(form, { kind: 'group', g: 0 }, { kind: 'group', g: 0, index: 2 });
  eq('группа переставлена', groups!.form.groups.map(g => g.title), ['Расчёт', 'Позиция оборудования']);
  eq('поле нельзя бросить в таблицу', dropComponent(form, { kind: 'field', g: 0, f: 0 }, { kind: 'column', t: 0, c: 0, index: 0 }), null);
  const column = addComponent(form, 'column', { kind: 'table', t: 0 }, 1);
  eq('колонка вставлена на место', [column.form.tables[0].columns[1].label, column.selection], ['Новая колонка', { kind: 'column', t: 0, c: 1 }]);
  const fresh = applyDrop(form, { new: 'field' }, { kind: 'field', g: 1, f: 1 }, true);
  eq('новое поле на нижнюю половину строки — после неё', [fresh!.form.groups[1].fields[2].label, fresh!.selection], ['Новое поле', { kind: 'field', g: 1, f: 2 }]);
  eq('новое поле-код на группу — в её конец', applyDrop(form, { new: 'code-field' }, { kind: 'group', g: 0 }, false)!.form.groups[0].fields[4].kind, 'code');
  eq('новая группа перед группой', applyDrop(form, { new: 'group' }, { kind: 'group', g: 0 }, false)!.form.groups[0].title, 'Новая группа');
  eq('поле на другую группу — в её конец', applyDrop(form, { move: { kind: 'field', g: 0, f: 0 } }, { kind: 'group', g: 1 }, false)!.form.groups[1].fields[4].label, 'Проект');
  eq('колонка на таблицу — в конец', applyDrop(form, { new: 'column' }, { kind: 'table', t: 0 }, false)!.form.tables[0].columns.length, 5);
  eq('колонку нельзя бросить на поле', applyDrop(form, { new: 'column' }, { kind: 'field', g: 0, f: 0 }, false), null);
  eq('поле на пустое место пустой формы создаёт группу', applyDrop({ version: 1, groups: [], tables: [] }, { new: 'field' }, { kind: 'form' }, false)!.form.groups.length, 1);
  const onEmpty = addComponent({ version: 1, groups: [], tables: [] }, 'field', { kind: 'form' });
  eq('поле в пустой форме создаёт группу', [onEmpty.form.groups.length, onEmpty.form.groups[0].fields.length], [1, 1]);
  eq('удаление поля выделяет его группу', removeSelected(form, { kind: 'field', g: 0, f: 1 }).selection, { kind: 'group', g: 0 });
  eq('удаление убирает именно его', names(removeSelected(form, { kind: 'field', g: 0, f: 1 }).form), ['Проект', 'Код позиции', 'Тег']);
  const cleared = updateSelected(form, { kind: 'field', g: 1, f: 1 }, { unit: undefined, hint: undefined });
  ok('сброс свойства убирает его из текста', !('unit' in cleared.groups[1].fields[1]) && !serializeForm(cleared).includes('"unit": "м³/ч"'));
  ok('исходная форма не изменена', form.groups[1].fields[1].unit === 'м³/ч');
}

console.log('Типы из договора — настоящим компилятором');
{
  const compile = (code: string, dts: string): string[] => {
    const files: Record<string, string> = { '/p/contract.d.ts': dts, '/p/logic/main.ts': code };
    const options: ts.CompilerOptions = { strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, lib: ['lib.es2022.d.ts'], types: [] };
    const host = ts.createCompilerHost(options);
    const read = host.readFile.bind(host), exists = host.fileExists.bind(host), source = host.getSourceFile.bind(host);
    host.fileExists = f => f in files || exists(f);
    host.readFile = f => files[f] ?? read(f);
    const dirExists = host.directoryExists?.bind(host);
    host.directoryExists = d => d === '/p' || d === '/p/logic' || (dirExists ? dirExists(d) : false);
    host.getSourceFile = (f, l, ...rest) => f in files ? ts.createSourceFile(f, files[f], l) : source(f, l, ...rest);
    const program = ts.createProgram(['/p/logic/main.ts'], options, host);
    return ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
  };
  const dts = generateContractDts(contract);
  eq('образцовая логика компилируется без ошибок', compile(sampleLogic, dts), []);
  const withBody = (body: string) => `import type { ModuleApi } from '../contract';\nexport async function setup({ flux, state, calc }: ModuleApi) {\n${body}\n}\n`;
  ok('опечатка в поле данных — ошибка типов', compile(withBody("const e = await flux.read('equipment'); return e?.params[0].valeu;"), dts).some(m => /valeu/.test(m)));
  ok('чтение неразрешённых данных — ошибка типов', compile(withBody("await flux.read('catalog');"), dts).length > 0);
  ok('неизвестное имя данных — ошибка типов', compile(withBody("await flux.read('equipmnt');"), dts).length > 0);
  ok('state не объявленный в договоре — ошибка', compile(withBody('state.nothing = 1;'), dts).some(m => /nothing/.test(m)));
  ok('state неверного типа — ошибка', compile(withBody("state.airflow = 'много';"), dts).length > 0);
  ok('calc.out с неизвестным ключом — ошибка', compile(withBody('calc.out = { typo: 1 };'), dts).length > 0);
  ok('верный calc.out компилируется', compile(withBody('calc.out = { pressure: 450 };'), dts).length === 0);
  // Мутация договора: убрали equipment из reads — тот же код перестаёт компилироваться
  const narrow = generateContractDts({ ...contract, reads: ['project'] });
  ok('договор без equipment: образцовая логика не компилируется', compile(sampleLogic, narrow).length > 0);
  ok('единица измерения попала в подсказку', dts.includes('единица: м³/ч'));
  ok('тип плоской структуры совпадает со схемой', /params: \{[\s\S]*?value: string;[\s\S]*?\}\[\];/.test(dts));
  const withArray: ContractDraft = { ...contract, outputs: [...contract.outputs, { name: 'rows', type: 'array', items: 'number' }, { name: 'rows', type: 'string' }] };
  const arrayDts = generateContractDts(withArray);
  ok('список с типом элементов — number[], дубль имени отброшен', arrayDts.includes('rows?: number[];') && (arrayDts.match(/rows\?:/g) ?? []).length === 1);
  eq('number[] в calc.out компилируется', compile(withBody('calc.out = { rows: [1, 2] };'), arrayDts), []);
  ok('строка в number[] — ошибка типов', compile(withBody("calc.out = { rows: ['a'] };"), arrayDts).length > 0);
  const reference = contractReference(contract);
  ok('справка для остальных языков описывает вход и выход', reference.includes('Вход compute(input)') && reference.includes('"calc"') && reference.includes('parameterCount — integer'));
  ok('справка не содержит неразрешённых данных', !reference.includes('"catalog"'));
}

console.log('Подсказки и проверка кода');
{
  const issues = checkScript("const x = await flux.read('equipmnt');\nconst y = await flux.read('catalog');\nstate.ghost = 1;\ncalc.out = { parameterCount: 1, typo: 2 };\nstate.mode = 'a';", contract);
  eq('замечания по строкам', issues.map(i => [i.line, i.message.split(' ')[0]]), [[1, 'У'], [2, 'Данные'], [3, '«ghost»'], [4, '«typo»']]);
  eq('верный код без замечаний', checkScript(sampleLogic, contract), []);
  eq('чужое свойство obj.state.x не считается', checkScript('obj.state.ghost = 1;', contract), []);
  eq('другие языки: неразрешённое чтение', checkOther('x = input["flux"]["catalog"]\ny = input["flux"]["equipment"]', contract).map(i => i.line), [1]);
  const complete = (before: string, c = contract) => completeScript(before, c);
  eq('flux. → read, on', complete('flux.')!.options.map(o => o.label), ['read', 'on']);
  eq("flux.read(' → только разрешённые данные", complete("flux.read('")!.options.map(o => o.label), ['project', 'equipment', 'tag']);
  eq('state. → объявленные', complete('state.')!.options.map(o => o.label), ['recalculations', 'mode', 'airflow']);
  eq('calc.out. → выходы', complete('calc.out.')!.options.map(o => o.label), ['parameterCount', 'pressure']);
  eq('частично набранное слово заменяется', complete('state.rec')!.from, 6);
  eq('поля прочитанных данных', complete("const eq = await flux.read('equipment');\neq?.")!.options.map(o => o.label).slice(0, 3), ['id', 'name', 'itemCode']);
  eq('вглубь списка', complete("const eq = await flux.read('equipment');\neq.params[0].")!.options.map(o => o.label), ['group', 'key', 'value', 'unit']);
  eq('чтение не разрешено — подсказок по полям нет', complete("const eq = await flux.read('equipment');\neq.", { ...contract, reads: ['project'] }), null);
}

console.log('checkFormDesign');
{
  eq('образец без замечаний', checkFormDesign(sampleForm(), { contract }), []);
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '../modules/fixtures/equipment-inspector/form.json'), 'utf8'));
  const fixtureContract: ContractDraft = { ...contract, reads: ['project', 'equipment', 'tag', 'specification', 'catalog'], outputs: [{ name: 'parameterCount', type: 'integer' }] };
  eq('форма из пакета Flux без замечаний', checkFormDesign(fixture, { contract: fixtureContract }), []);
  const rule = (change: (form: any) => void, id: string, withContract = true) => {
    const form = clone(sampleForm()); change(form);
    return checkFormDesign(form, withContract ? { contract } : {}).filter(f => f.rule === id);
  };
  ok('форма неверного вида', checkFormDesign(null)[0].rule === 'form-shape');
  eq('пустая подпись', rule(f => { f.groups[0].fields[0].label = '  '; }, 'text-empty').map(f => f.path), ['groups[0].fields[0].label']);
  ok('рекламное слово (слова из методологии)', rule(f => { f.groups[0].fields[0].label = 'Мгновенный расчёт'; }, 'text-ad').length === 1);
  ok('рекламное слово в заголовке таблицы', rule(f => { f.tables[0].title = 'Интеллектуальные параметры'; }, 'text-ad').length === 1);
  ok('звёздочка в подписи', rule(f => { f.groups[0].fields[0].label = 'Проект *'; }, 'text-asterisk').length === 1);
  ok('ЗАГЛАВНЫЕ в подписи', rule(f => { f.groups[0].fields[0].label = 'ВАЖНЫЙ ПАРАМЕТР'; }, 'text-caps').length === 1);
  ok('аббревиатура допустима', rule(f => { f.groups[0].fields[0].label = 'Тип HVAC'; }, 'text-caps').length === 0);
  ok('слишком длинная подпись', rule(f => { f.groups[0].fields[0].label = 'Расход воздуха на приточной установке первого этажа'; }, 'text-long').length === 1);
  ok('точка в конце подписи', rule(f => { f.groups[0].fields[0].label = 'Проект.'; }, 'text-dot').length === 1);
  ok('повтор подписи в группе', rule(f => { f.groups[0].fields[1].label = 'Проект'; }, 'text-duplicate').length === 1);
  ok('пояснение из двух предложений', rule(f => { f.groups[1].fields[0].hint = 'Первое. Второе.'; }, 'hint-sentence').length === 1);
  ok('единица дважды', rule(f => { f.groups[1].fields[1].label = 'Расход воздуха (м³/ч)'; }, 'unit-duplicate').length === 1);
  ok('пустая группа', rule(f => { f.groups[0].fields = []; }, 'group-empty').length === 1);
  ok('таблица без колонок', rule(f => { f.tables[0].columns = []; }, 'table-empty').length === 1);
  ok('колонка с единицей слева', rule(f => { f.tables[0].columns[2] = { label: 'Расход', key: 'value', unit: 'м³/ч' }; }, 'numbers-end').length === 1);
  ok('колонка с единицей справа допустима', rule(f => { f.tables[0].columns[2] = { label: 'Расход', key: 'value', unit: 'м³/ч', align: 'end' }; }, 'numbers-end').length === 0);
  ok('код числом моноширинно', rule(f => { f.groups[1].fields[2].kind = 'code'; }, 'code-mono').length === 1);
  ok('код без моноширинного', rule(f => { delete f.groups[0].fields[2].kind; }, 'code-mono').length === 1);
  ok('много колонок в узком окне', rule(f => { f.tables[0].columns = Array.from({ length: 6 }, (_, i) => ({ label: `К${i}`, key: 'key' })); }, 'narrow-scroll').length === 1);
  ok('цвет не из токенов (ключ)', rule(f => { f.groups[0].color = '#ff0000'; }, 'color-token').length === 1);
  ok('цвет-литерал в любом поле', rule(f => { f.groups[0].fields[0].accent = 'rgb(1,2,3)'; }, 'color-token').length === 1);
  ok('токен допустим', rule(f => { f.groups[0].color = 'var(--flux-accent)'; }, 'color-token').length === 0);
  ok('размер не кратен 4', rule(f => { f.groups[0].gap = '13px'; }, 'measure-step').length === 1);
  ok('размер кратный 4 допустим', rule(f => { f.groups[0].gap = '12px'; }, 'measure-step').length === 0);
  ok('высота строки вне 28–40', rule(f => { f.tables[0].rowHeight = 56; }, 'measure-row').length === 1);
  ok('высота строки 32 допустима', rule(f => { f.tables[0].rowHeight = 32; }, 'measure-row').length === 0);
  ok('ширина больше узкого окна', rule(f => { f.tables[0].columns[0].width = 400; }, 'narrow-scroll').length >= 1);
  ok('колонки вместе шире окна', rule(f => { f.tables[0].columns.forEach((c: any) => { c.width = 120; }); }, 'narrow-scroll').length >= 1);
}

console.log('Методология');
{
  const generated = fs.readFileSync(TARGET, 'utf8');
  ok('выписка в репозитории совпадает с документом', generated === generate());
  const md = fs.readFileSync(path.join(__dirname, '../docs/methodology/01-design.md'), 'utf8');
  const mutated = extractMethodology(md.replace('Placeholder — пример значения', 'Подсказка — пример значения'));
  ok('мутация документа меняет выписку (тест сверки не слепой)', JSON.stringify(mutated) !== JSON.stringify(extractMethodology(md)));
  for (const item of PALETTE) {
    const guidance = guidanceFor(item);
    ok(`«${item.title}»: когда применять и пример из методологии`, guidance.when.length > 0 && guidance.example.length > 0);
  }
  ok('«Форма»: правило про placeholder пришло из документа', guidanceFor(PALETTE.find(p => p.kind === 'field')!).when.some(t => t.includes('Placeholder')));
  ok('«Таблица»: числа и даты вправо', guidanceFor(PALETTE.find(p => p.kind === 'table')!).when.some(t => t.includes('по правому краю')));
}

console.log('Файлы пакета и договор оболочки (files, binary, onChange(changed))');
{
  const files = sampleFiles();
  const fromFiles = contractFromFiles(files);
  eq('reads из manifest.json, значения из contract.json', [fromFiles.reads, fromFiles.state.map(v => v.name), fromFiles.outputs.map(v => v.name)], [contract.reads, ['recalculations', 'mode', 'airflow'], ['parameterCount', 'pressure']]);
  const noContract = { ...files }; delete noContract['contract.json'];
  const inferred = contractFromFiles(noContract);
  ok('без contract.json значения выводятся из формы и кода', ['mode', 'airflow', 'recalculations'].every(n => inferred.state.some(v => v.name === n)) && inferred.outputs.some(v => v.name === 'parameterCount'));
  eq('вывод из кода: calc.out = { … } и state.x', inferValues({ 'logic/main.ts': 'state.a = 1; calc.out = { b: 1, c: 2 }; obj.state.zzz;' }), { state: [{ name: 'a', type: 'string' }], outputs: [{ name: 'b', type: 'string' }, { name: 'c', type: 'string' }] });
  const broken = contractFromFiles({ ...files, 'contract.json': JSON.stringify({ state: [{ name: 'a b', type: 'string' }, { name: 'ok', type: 'zzz' }, { name: 'dup', type: 'string' }, { name: 'dup', type: 'number' }], outputs: 5 }) });
  eq('битый contract.json: лишнее отброшено, дубли тоже', [broken.state.map(v => v.name), broken.outputs], [['dup'], []]);
  const changes = contractChanges(files, { ...contract, reads: ['project'] });
  eq('смена reads пишет manifest.json и contract.json, остальное в манифесте цело', [Object.keys(changes.changed).sort(), JSON.parse(changes.changed['manifest.json']).reads, JSON.parse(changes.changed['manifest.json']).id, changes.error], [['contract.json', 'manifest.json'], ['project'], 'equipment-inspector', '']);
  eq('те же reads — manifest.json не трогаем', Object.keys(contractChanges(files, contract).changed), ['contract.json']);
  ok('битый manifest.json — понятная ошибка', /manifest\.json не читается/.test(contractChanges({ ...files, 'manifest.json': '{' }, contract).error));
  eq('файлы кода: logic/main первым, примеры и .d.ts не код', codeFiles({ 'src/a.rs': '', 'logic/main.py': '', 'examples/x.ts': '', 'logic/main.ts': '', 'contract.d.ts': '', 'form.json': '{}' }).map(f => f.path), ['logic/main.py', 'logic/main.ts', 'src/a.rs']);
  eq('языки по расширению', ['a.ts', 'a.py', 'a.rs', 'a.cpp', 'a.c', 'a.go', 'a.cs', 'a.txt'].map(languageOfPath), ['typescript', 'python', 'rust', 'cpp', 'c', 'go', 'csharp', null]);
}

console.log('Стык с окном владельца: contract.json в составе пакета, править его владелец не вправе');
{
  const enc = (text: string) => new TextEncoder().encode(text);
  const files = sampleFiles();
  const bundle = Object.fromEntries(Object.entries(files).map(([name, text]) => [name, enc(text)]));
  ok('владелец не правит contract.json, form.json и код', !ownerMayEdit('contract.json') && !ownerMayEdit('form.json') && !ownerMayEdit('logic/main.ts'));
  ok('manifest.json, data/ и examples/ владелец править может', ownerMayEdit('manifest.json') && ownerMayEdit('data/x.json') && ownerMayEdit('examples/controls.json'));
  eq('правка contract.json владельцем отвергается', ownerEditViolations(bundle, { ...bundle, 'contract.json': enc('{}') }), ['contract.json']);
  eq('правка manifest.json и examples/ допускается', ownerEditViolations(bundle, { ...bundle, 'manifest.json': enc('{}'), 'examples/controls.json': enc('[1]') }), []);
  ok('окно предлагает править только разрешённые файлы, без contract.json', !ownerEditablePaths(bundle).includes('contract.json') && ownerEditablePaths(bundle).includes('manifest.json'));
  ok('в составе пакета (сравнение выпусков) contract.json виден владельцу', diffFiles(null, bundle).some(file => file.path === 'contract.json' && file.status === 'added'));
  eq('изменение значений договора видно как изменённый файл', diffFiles(bundle, { ...bundle, 'contract.json': enc(files['contract.json'].replace('airflow', 'flow')) }).filter(file => file.status !== 'same').map(file => file.path), ['contract.json']);
}

console.log('Рендерер Flux: единицы, пояснения, условия показа; старые формы выглядят как раньше');
{
  // Минимальный DOM: хватает renderForm. Снимок — дерево тегов, классов и текста.
  class Node { children: Node[] = []; className = ''; textContent = ''; constructor(public tag: string) {} append(...nodes: Node[]) { this.children.push(...nodes); } replaceChildren() { this.children = []; } }
  (globalThis as any).document = { createElement: (tag: string) => new Node(tag) };
  const dump = (node: Node): unknown => [node.tag, node.className, node.textContent, node.children.map(dump)];
  const draw = (render: (root: any, form: any, data: any) => void, form: unknown, data: unknown) => { const root = new Node('div'); render(root, form, data); return JSON.stringify(dump(root)); };
  // Прежний рендерер дословно: эталон «как раньше»
  const legacy = (root: any, form: any, data: any) => {
    const element = (tag: string, className: string, text?: unknown) => { const node = new Node(tag); node.className = className; if (text !== undefined) node.textContent = String(text ?? '—'); return node; };
    root.replaceChildren();
    for (const group of form.groups) {
      const section = element('section', 'p-3');
      section.append(element('h2', 'fx-group-title', group.title));
      for (const field of group.fields) {
        const row = element('div', 'flex items-center justify-between gap-4 min-h-8 border-b border-[var(--flux-line)]');
        row.append(element('span', 'fx-label', field.label), element('span', `text-sm break-words min-w-0${field.kind === 'code' ? ' font-mono' : ''}`, readFlux(data, field.bind) ?? '—'));
        section.append(row);
      }
      root.append(section);
    }
    for (const definition of form.tables) {
      const section = element('section', 'p-3 min-w-0');
      section.append(element('h2', 'fx-group-title', definition.title));
      const table = element('table', 'fx-table w-full table-fixed');
      const head = new Node('thead'), header = new Node('tr');
      for (const column of definition.columns) header.append(element('th', `break-words${column.align === 'end' ? ' text-right' : ''}`, column.label));
      head.append(header); table.append(head);
      const body = new Node('tbody');
      const rows = readFlux(data, definition.bind);
      if (Array.isArray(rows)) for (const row of rows) {
        const tr = new Node('tr');
        for (const column of definition.columns) tr.append(element('td', `break-words${column.align === 'end' ? ' text-right tabular-nums' : ''}`, readFlux(row, column.key) ?? '—'));
        body.append(tr);
      }
      table.append(body); section.append(table); root.append(section);
    }
  };
  const data = sampleData();
  let fixtures = 0;
  for (const dir of fs.readdirSync(path.join(__dirname, '../modules/fixtures'))) {
    const file = path.join(__dirname, '../modules/fixtures', dir, 'form.json');
    if (!fs.existsSync(file)) continue;
    const form = JSON.parse(fs.readFileSync(file, 'utf8'));
    fixtures++;
    eq(`фикстура ${dir}: проходит общую схему`, validateSchema(formSchema, form), []);
    validateModuleForm(form, dir, ['project', 'equipment', 'tag', 'specification', 'catalog']);
    // Прежний рендерер не знает условий показа, единиц и пояснений: формы, которые их используют (пример «Переводчик»), с ним не сравниваются
    if (/"(?:visibleIf|unit|hint)"/.test(JSON.stringify(form))) { ok(`фикстура ${dir}: использует условия, единицы или пояснения - со старым рендерером не сравнивается`, true); continue; }
    eq(`фикстура ${dir}: рисуется как прежним рендерером`, draw(renderForm, form, data), draw(legacy, form, data));
  }
  ok('проверены все фикстуры', fixtures >= 4);

  const form = sampleForm() as unknown as ModuleForm;
  const text = (json: string) => json;
  const shown = draw(renderForm, form, data);
  ok('единица стоит после значения', text(shown).includes('1200 м³/ч'));
  ok('пояснение выведено под полем', text(shown).includes('От режима зависят поправки к расходу.'));
  const hidden = draw(renderForm, form, { ...data, state: { ...data.state, mode: '' } });
  ok('условие «заполнено» скрывает поле, когда режим пуст', !hidden.includes('Расход воздуха') && shown.includes('Расход воздуха'));
  ok('условия eq / ne / empty', visible({ bind: 'state.mode', op: 'eq', value: 'зима' }, data) && !visible({ bind: 'state.mode', op: 'ne', value: 'зима' }, data) && visible({ bind: 'state.none', op: 'empty' }, data));
  ok('условие группы скрывает всю группу', !draw(renderForm, { ...form, groups: [{ ...form.groups[1], visibleIf: { bind: 'state.mode', op: 'eq', value: 'лето' } }] }, data).includes('Расчёт'));
  ok('условие таблицы скрывает таблицу', !draw(renderForm, { ...form, tables: [{ ...form.tables[0], visibleIf: { bind: 'state.mode', op: 'eq', value: 'лето' } }] }, data).includes('Параметры'));
  ok('единица колонки — в шапке', draw(renderForm, { version: 1, groups: [], tables: [{ title: 'T', bind: 'flux.equipment.params', columns: [{ label: 'Мощность', key: 'value', unit: 'кВт' }] }] }, data).includes('Мощность, кВт'));
  ok('пустое значение без единицы — тире', draw(renderForm, { version: 1, groups: [{ title: 'G', fields: [{ label: 'X', bind: 'state.zzz', unit: 'Па' }] }], tables: [] }, data).includes('"—"'));
}

console.log('Выпуск и Studio решают одинаково (modules/validateForm.ts)');
{
  const contractAll: ContractDraft = { ...contract, reads: ['project', 'equipment', 'tag', 'specification', 'catalog'] };
  const flux = (form: unknown) => { try { validateModuleForm(form, 'sample', contractAll.reads); return true; } catch { return false; } };
  const studio = (form: FormDef) => { const text = JSON.stringify(form, null, 2); return structureProblems(text).problems.length === 0 && bindingProblems(text, form, contractAll).filter(p => p.severity === 'error').length === 0; };
  const cases: Array<[string, (f: any) => void]> = [
    ['образец', () => {}], ['опечатка в пути', f => { f.groups[0].fields[0].bind = 'flux.equipment.nme'; }], ['чужие данные', f => { f.groups[0].fields[0].bind = 'flux.bogus.x'; }],
    ['таблица на state', f => { f.tables[0].bind = 'state.mode'; }], ['таблица на calc.out', f => { f.tables[0].bind = 'calc.out.pressure'; }],
    ['таблица на не-список', f => { f.tables[0].bind = 'flux.equipment.name'; }], ['колонка вне схемы', f => { f.tables[0].columns[0].key = 'zzz'; }],
    ['пустая колонка', f => { f.tables[0].columns[0].key = ''; }], ['список в поле', f => { f.groups[0].fields[0].bind = 'flux.equipment.params'; }],
    ['условие на чужую привязку', f => { f.groups[1].fields[1].visibleIf.bind = 'flux.bogus.x'; }], ['условие eq без значения', f => { f.groups[1].fields[1].visibleIf = { bind: 'state.mode', op: 'eq' }; }],
    ['лишний ключ', f => { f.groups[0].fields[0].color = 'red'; }], ['лишний ключ формы', f => { f.extra = 1; }], ['версия 2', f => { f.version = 2; }],
    ['пустая привязка', f => { f.groups[0].fields[0].bind = ''; }],
  ];
  for (const [name, mutate] of cases) {
    const form = clone(sampleForm()) as any; mutate(form);
    const byFlux = flux(form), byStudio = studio(form);
    // Studio строже выпуска (проверяет ещё объявленные state и calc.out), но мягче быть не вправе
    ok(`${name}: выпуск ${byFlux ? 'принимает' : 'отвергает'}, Studio ${byStudio ? 'принимает' : 'отвергает'}`, !byStudio || byFlux);
  }
  ok('образец принят обоими', flux(sampleForm()) && studio(sampleForm()));
  throws('validateForm: таблица на state отвергнута', () => validateModuleForm({ version: 1, groups: [], tables: [{ title: 'T', bind: 'state.rows', columns: [{ label: 'A', key: 'a' }] }] }, 'm', []));
  throws('validateForm: лишний ключ отвергнут с понятным текстом', () => validateModuleForm({ version: 1, groups: [{ title: 'G', fields: [{ label: 'X', bind: 'state.x', colour: 1 }] }], tables: [] }, 'm', []));
  try { validateModuleForm({ version: 1, groups: [{ title: 'G', fields: [{ label: 'X', bind: 'state.x', colour: 1 }] }], tables: [] }, 'm', []); } catch (error) { ok('текст ошибки называет поле и место', /Неизвестное поле «colour»/.test((error as Error).message) && /\[1\]/.test((error as Error).message)); }
  throws('miniSchema: неизвестное слово схемы — исключение', () => validateSchema({ type: 'string', minLength: 1 }, 'x'));
  throws('miniSchema: additionalProperties-схема — исключение', () => validateSchema({ type: 'object', additionalProperties: { type: 'string' } }, {}));
}

console.log(`\nПройдено проверок: ${passed}`);
