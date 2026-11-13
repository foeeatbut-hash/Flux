/**
 * Языки логики (этап 3а, шаг 1): манифест, подпись выпуска, файлы Python и
 * WebAssembly, точность обмена, контрольные примеры.
 *
 * Запуск: npx tsx scripts/test-modules-languages.ts
 */
import assert from 'node:assert/strict';
import { validManifest } from '../modules/schemas';
import { parseReleaseClaim } from '../modules/trust/claims';
import { packBundle, splitChunks, unpackBundle } from '../modules/trust/bundle';
import { verifyRelease, verifyRequest, readCertificates } from '../modules/trust/verify';
import { buildReleaseClaim } from '../modules/trust/owner';
import { encodeJson, parseComputeOutput, parseJson } from '../modules/engine/json';
import { compareWithTolerance, parseControls, runControls } from '../modules/engine/controls';
import { ComputeError } from '../modules/engine/types';
import { certificateEnvelope, hexOf, moduleBundle, newKey, releaseEnvelope, requestEnvelope } from './fixtures/moduleTrust';
import { fluxModule } from './fixtures/wasmBuilder';

let passed = 0;
const ok = (name: string, value: unknown) => { assert.ok(value, name); passed++; };
const code = (fn: () => unknown) => { try { fn(); return ''; } catch (e) { return e instanceof ComputeError ? e.code : 'other'; } };
const root = newKey(), rootHex = hexOf(root), dev = newKey(), devHex = hexOf(dev);
const none = { releases: new Set<string>(), keys: new Set<string>() };
const now = Date.now();

const controls = JSON.stringify({ version: 1, cases: [{ name: 'один', input: {}, expect: { calc: { out: { ok: true } }, state: {} } }] });
const base = { id: 'equipment-inspector', name: 'Параметры', version: '1.0.0', author: 'Flux', contractVersion: 1, entries: ['start'], reads: ['equipment'] };

console.log('Манифест: язык и файл логики согласованы');
{
  ok('без языка — TypeScript, как раньше', validManifest({ ...base, logic: 'logic/main.ts' }));
  ok('python с main.py', validManifest({ ...base, logic: 'logic/main.py', language: 'python' }));
  ok('wasm с main.wasm и исходным языком', validManifest({ ...base, logic: 'logic/main.wasm', language: 'wasm', sourceLanguage: 'rust' }));
  ok('платформа any и windows', validManifest({ ...base, logic: 'logic/main.ts', platform: 'windows' }) && validManifest({ ...base, logic: 'logic/main.ts', platform: 'any' }));
  ok('python с файлом TypeScript отклонён', !validManifest({ ...base, logic: 'logic/main.ts', language: 'python' }));
  ok('typescript с файлом python отклонён', !validManifest({ ...base, logic: 'logic/main.py' }));
  ok('wasm без исходного языка отклонён', !validManifest({ ...base, logic: 'logic/main.wasm', language: 'wasm' }));
  ok('исходный язык у не-wasm отклонён', !validManifest({ ...base, logic: 'logic/main.py', language: 'python', sourceLanguage: 'c' }));
  ok('лишний язык (Java, Fortran, Lua) отклонён', ['java', 'fortran', 'lua', 'ruby', 'php'].every(language => !validManifest({ ...base, logic: 'logic/main.py', language })));
  ok('лишний исходный язык отклонён', !validManifest({ ...base, logic: 'logic/main.wasm', language: 'wasm', sourceLanguage: 'zig' }));
  ok('неизвестная платформа отклонена', !validManifest({ ...base, logic: 'logic/main.ts', platform: 'linux' }));
}

console.log('Подписанный выпуск несёт язык и платформу');
{
  const wasm = fluxModule();
  const pyBundle = moduleBundle('1.0.0', { 'logic/main.py': 'def compute(i):\n    return {}\n', 'examples/controls.json': controls },
    { logic: 'logic/main.py', language: 'python' });
  const sign = (bundle: Uint8Array, extra: Record<string, string> = {}) => releaseEnvelope(root, bundle, { version: '1.0.0', author: devHex, ...extra });
  const check = (bundle: Uint8Array, signature: string, extra: Record<string, unknown> = {}) =>
    verifyRelease({ signature, chunks: splitChunks(bundle), rootHex, revoked: none, now, moduleId: 'equipment-inspector', version: '1.0.0', ...extra });

  const pySig = sign(pyBundle, { language: 'python' });
  ok('выпуск Python проходит', check(pyBundle, pySig).ok);
  ok('язык попадает в разобранную подпись', parseReleaseClaim(JSON.parse(Buffer.from(pySig.split('.')[1], 'base64url').toString()))?.language === 'python');
  ok('подпись без языка у модуля Python не проходит', (check(pyBundle, sign(pyBundle)).why || '').includes('Язык или платформа'));
  ok('подпись с другим языком не проходит', (check(pyBundle, sign(pyBundle, { language: 'wasm' })).why || '').includes('Язык или платформа'));
  ok('язык без платформы в подписи — недействительная запись', parseReleaseClaim({
    v: 1, moduleId: 'm', version: '1.0.0', contractVersion: 1, channel: 'test', notBefore: 0, request: 'r', author: devHex, iat: 1,
    size: 1, sha256: '0'.repeat(64), chunks: ['0'.repeat(64)], language: 'python',
  }) === null);

  // Изменённый .py не запускается: подпись покрывает каждый байт пакета
  const tampered = moduleBundle('1.0.0', { 'logic/main.py': 'def compute(i):\n    return {"x":1}\n', 'examples/controls.json': controls },
    { logic: 'logic/main.py', language: 'python' });
  const tamperedCheck = check(tampered, pySig);
  ok('изменённый main.py не запускается', !tamperedCheck.ok && /не совпадает/.test(tamperedCheck.why || ''));
  ok('причина названа словами для человека', (tamperedCheck.why || '').length > 10);
  const files = unpackBundle(pyBundle);
  files['logic/main.py'] = new TextEncoder().encode('def compute(i):\n    return {}\n ');
  ok('допись пробела в main.py тоже ломает проверку', !check(packBundle(files), pySig).ok);

  const wasmBundle = moduleBundle('1.0.0', { 'logic/main.wasm': wasm as any as string, 'examples/controls.json': controls },
    { logic: 'logic/main.wasm', language: 'wasm', sourceLanguage: 'c' });
  const wasmSig = sign(wasmBundle, { language: 'wasm' });
  ok('выпуск WebAssembly проходит', check(wasmBundle, wasmSig).ok);
  const badWasm = Uint8Array.from(wasm); badWasm[badWasm.length - 3] ^= 1;
  const wasmFiles = unpackBundle(wasmBundle); wasmFiles['logic/main.wasm'] = badWasm;
  ok('изменённый main.wasm не запускается', !check(packBundle(wasmFiles), wasmSig).ok);

  // Файлы логики проверяются и по смыслу, не только по хешу: такой выпуск не должен получить подпись
  const noControls = moduleBundle('1.0.0', { 'logic/main.py': 'x = 1\n' }, { logic: 'logic/main.py', language: 'python' });
  ok('Python без контрольных примеров не проходит', (check(noControls, sign(noControls, { language: 'python' })).why || '').includes('контрольные примеры'));
  const noLogic = moduleBundle('1.0.0', { 'examples/controls.json': controls }, { logic: 'logic/main.py', language: 'python' });
  ok('Python без main.py не проходит', (check(noLogic, sign(noLogic, { language: 'python' })).why || '').includes('нет logic/main.py'));
  const notWasm = moduleBundle('1.0.0', { 'logic/main.wasm': 'это текст', 'examples/controls.json': controls }, { logic: 'logic/main.wasm', language: 'wasm', sourceLanguage: 'c' });
  ok('текст вместо .wasm не проходит', (check(notWasm, sign(notWasm, { language: 'wasm' })).why || '').includes('WebAssembly'));
  const badControls = moduleBundle('1.0.0', { 'logic/main.py': 'x = 1\n', 'examples/controls.json': '{"version":1,"cases":[]}' }, { logic: 'logic/main.py', language: 'python' });
  ok('пустые контрольные примеры не проходят', !check(badControls, sign(badControls, { language: 'python' })).ok);

  // Методы для других программ на TypeScript: исполняет собранный build/logic.js, и только после контрольных примеров
  {
    const methods = [{ method: 'convert', does: 'Пересчитывает сумму из одной валюты в другую по курсу' }];
    const built = 'globalThis.__fluxLogic=(function(){var module={exports:{}},exports=module.exports;exports.compute=function(i){return {state:{},calc:{out:{}}};};return module.exports;})();\n';
    const tsBundle = (extra: Record<string, string>, patch: Record<string, unknown> = {}) => moduleBundle('1.0.0', extra, { contractVersion: 3, exports: methods, ...patch });
    const signedV3 = (bundle: Uint8Array) => releaseEnvelope(root, bundle, { version: '1.0.0', author: devHex, contractVersion: 3 });
    const verify = (bundle: Uint8Array) => verifyRelease({ signature: signedV3(bundle), chunks: splitChunks(bundle), rootHex, revoked: none, now, moduleId: 'equipment-inspector', version: '1.0.0' });
    ok('TypeScript с exports, build/logic.js и контрольными примерами проходит', verify(tsBundle({ 'build/logic.js': built, 'examples/controls.json': controls })).ok);
    ok('TypeScript с exports без build/logic.js не проходит, причина названа', /build\/logic\.js/.test(verify(tsBundle({ 'examples/controls.json': controls })).why || ''));
    ok('TypeScript с exports без контрольных примеров не проходит', /контрольные примеры/.test(verify(tsBundle({ 'build/logic.js': built })).why || ''));
    ok('build/logic.js больше 1 МиБ не проходит', /больше 1 МиБ/.test(verify(tsBundle({ 'build/logic.js': `${built}/*${'x'.repeat(1024 * 1024)}*/`, 'examples/controls.json': controls })).why || ''));
    ok('build/logic.js не в кодировке UTF-8 не проходит', /UTF-8/.test(verify(packBundle({ ...unpackBundle(tsBundle({ 'examples/controls.json': controls })), 'build/logic.js': Uint8Array.from([0xff, 0xfe, 0x00]) })).why || ''));
    ok('файл, не похожий на собранную логику, не проходит', /не похож на собранную логику/.test(verify(tsBundle({ 'build/logic.js': 'alert(1)', 'examples/controls.json': controls })).why || ''));
    const emptySource = unpackBundle(tsBundle({ 'build/logic.js': built, 'examples/controls.json': controls }));
    delete emptySource['logic/main.ts'];
    ok('TypeScript с exports без исходника logic/main.ts не проходит', /нужен исходник/.test(verify(packBundle(emptySource)).why || ''));
    ok('подмена build/logic.js при прежней подписи не запускается',
      (() => { const bundle = tsBundle({ 'build/logic.js': built, 'examples/controls.json': controls }); const swapped = packBundle({ ...unpackBundle(bundle), 'build/logic.js': `${built};globalThis.evil=1` });
        return !verifyRelease({ signature: signedV3(bundle), chunks: splitChunks(swapped), rootHex, revoked: none, now, moduleId: 'equipment-inspector', version: '1.0.0' }).ok; })());
    // Без exports ничего не меняется: прежние выпуски на TypeScript (без build/logic.js и без примеров) остаются годными
    const plain = moduleBundle('1.0.0', {});
    ok('TypeScript без exports по-прежнему проходит без build/logic.js и без контрольных примеров', check(plain, sign(plain)).ok);
  }

  // Подмена любого файла пакета при прежней подписи: контрольные примеры, манифест (платформа, язык), логика
  {
    const files = unpackBundle(pyBundle);
    const mutate = (path: string, text: string) => packBundle({ ...files, [path]: text });
    const withControls = mutate('examples/controls.json', JSON.stringify({ version: 1, cases: [{ name: 'один', input: {}, expect: { calc: { out: { ok: false } }, state: {} } }] }));
    ok('подмена controls.json при прежней подписи не запускается', !check(withControls, pySig).ok && /не совпадает/.test(check(withControls, pySig).why || ''));
    const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']));
    const winSigned = sign(moduleBundle('1.0.0', {}, { platform: 'windows' }), { language: 'typescript', platform: 'windows' });
    ok('подмена manifest.platform (windows → any) при прежней подписи не запускается',
      !check(moduleBundle('1.0.0', {}, { platform: 'any' }), winSigned, { hostPlatform: 'linux' }).ok);
    const flipped = packBundle({ ...files, 'manifest.json': JSON.stringify({ ...manifest, platform: 'windows' }) });
    ok('и в обратную сторону (any → windows)', !check(flipped, pySig).ok);
    ok('подмена manifest.language не проходит', !check(packBundle({ ...files, 'manifest.json': JSON.stringify({ ...manifest, language: undefined, logic: 'logic/main.ts' }) }), pySig).ok);
    // Подпись с верными данными, но пакет собран с другой платформой в манифесте: расхождение подписи и манифеста
    const mismatched = moduleBundle('1.0.0', {}, { platform: 'windows' });
    ok('подпись платформы any при манифесте windows — отказ', (check(mismatched, sign(mismatched, { language: 'typescript', platform: 'any' })).why || '').includes('Язык или платформа'));
  }

  // Платформа
  const winBundle = moduleBundle('1.0.0', {}, { platform: 'windows' });
  const winSig = sign(winBundle, { language: 'typescript', platform: 'windows' });
  ok('windows-выпуск на Windows проходит', check(winBundle, winSig, { hostPlatform: 'win32' }).ok);
  ok('windows-выпуск на другой системе не запускается', (check(winBundle, winSig, { hostPlatform: 'linux' }).why || '').includes('Windows'));
  ok('подпись без платформы у windows-модуля не проходит', !check(winBundle, sign(winBundle)).ok);
  ok('выпуск any запускается везде', check(moduleBundle('1.0.0'), sign(moduleBundle('1.0.0')), { hostPlatform: 'linux' }).ok);

  // Владелец подписывает язык из байт пакета
  const pyFiles = unpackBundle(pyBundle);
  const certs = readCertificates([certificateEnvelope(root, devHex)], rootHex, none);
  const req = requestEnvelope(dev, pyBundle, { version: '1.0.0' });
  ok('запрос на публикацию с Python принимается', verifyRequest({ signature: req, bundle: pyBundle, rootHex, certificates: certs }).ok);
  ok('запрос без контрольных примеров отклонён', !verifyRequest({ signature: requestEnvelope(dev, noControls, { version: '1.0.0' }), bundle: noControls, rootHex, certificates: certs }).ok);
  const claim = buildReleaseClaim({ requestId: 'r1', requestSignature: req, bundle: pyBundle, channel: 'test', notBefore: 0 });
  ok('владелец подписывает язык и платформу из манифеста', claim.language === 'python' && claim.platform === 'any');
  ok('для TypeScript без полей подпись прежнего вида', buildReleaseClaim({ requestId: 'r', requestSignature: requestEnvelope(dev, moduleBundle('1.0.0'), { version: '1.0.0' }),
    bundle: moduleBundle('1.0.0'), channel: 'test', notBefore: 0 }).language === undefined);
  ok('файлы пакета читаются обратно', Object.keys(pyFiles).includes('logic/main.py'));
}

console.log('Точность обмена');
{
  ok('обычный вход кодируется', encodeJson({ a: 1.5, b: [1, 2], c: 'x' }) === '{"a":1.5,"b":[1,2],"c":"x"}');
  ok('NaN на входе — ошибка проверки', code(() => encodeJson({ a: NaN })) === 'NUMBER');
  ok('бесконечность на входе — ошибка проверки', code(() => encodeJson({ a: [Infinity] })) === 'NUMBER' && code(() => encodeJson({ a: -Infinity })) === 'NUMBER');
  ok('целое больше 2^53 на входе — ошибка, строкой можно', code(() => encodeJson({ a: 2 ** 53 })) === 'NUMBER' && code(() => encodeJson({ a: '9007199254740993' })) === '');
  ok('граница 2^53 − 1 допустима', code(() => encodeJson({ a: 2 ** 53 - 1 })) === '');
  ok('дробное большое допустимо (это float64, а не целое)', code(() => encodeJson({ a: 1.5e300 })) === '');
  ok('bigint, функция, Date на входе отклонены', code(() => encodeJson({ a: 1n })) === 'BAD_INPUT' && code(() => encodeJson({ a: () => 1 })) === 'BAD_INPUT' && code(() => encodeJson({ a: new Date() })) === 'BAD_INPUT');
  ok('слишком глубокий вход отклонён', code(() => encodeJson(JSON.parse('['.repeat(40) + ']'.repeat(40)))) === 'BAD_INPUT');
  ok('вход больше предела отклонён', code(() => encodeJson({ a: 'x'.repeat(1024 * 1024) })) === 'BAD_INPUT');

  ok('целое больше 2^53 в выходе — ошибка, а не молчаливое округление', code(() => parseJson('{"a":9007199254740993}')) === 'NUMBER');
  ok('отрицательное большое целое тоже', code(() => parseJson('{"a":-9007199254740993}')) === 'NUMBER');
  ok('переполнение float64 в выходе — ошибка', code(() => parseJson('{"a":1e999}')) === 'NUMBER' && code(() => parseJson('{"a":-1e999}')) === 'NUMBER');
  ok('NaN и Infinity как слова — не JSON', code(() => parseJson('{"a":NaN}')) === 'BAD_OUTPUT' && code(() => parseJson('{"a":Infinity}')) === 'BAD_OUTPUT');
  ok('большое число внутри строки не считается числом', code(() => parseJson('{"a":"9007199254740993"}')) === '');
  ok('число с экспонентой и точкой — float64', (parseJson('{"a":1.5e3,"b":2E-2}') as any).a === 1500);
  ok('целое с нулевой дробью допустимо', code(() => parseJson('{"a":1.0}')) === '');
  ok('выход глубже предела отклонён', code(() => parseJson('['.repeat(40) + ']'.repeat(40))) === 'BAD_OUTPUT');
  ok('выход больше предела отклонён', code(() => parseJson(`{"a":"${'x'.repeat(300 * 1024)}"}`)) === 'BAD_OUTPUT');
  ok('обрезанный выход — ошибка', code(() => parseJson('{"a":1')) === 'BAD_OUTPUT');

  ok('выход по схеме договора принимается', parseComputeOutput('{"state":{"n":1},"calc":{"out":{"x":2}}}').calc.out.x === 2);
  ok('выход без calc.out отклонён', code(() => parseComputeOutput('{"state":{}}')) === 'BAD_OUTPUT');
  ok('лишнее поле верхнего уровня отклонено', code(() => parseComputeOutput('{"state":{},"calc":{"out":{}},"flux":{}}')) === 'BAD_OUTPUT');
  ok('лишнее поле calc отклонено', code(() => parseComputeOutput('{"state":{},"calc":{"out":{},"x":1}}')) === 'BAD_OUTPUT');
  ok('массив вместо объекта отклонён', code(() => parseComputeOutput('{"state":[],"calc":{"out":{}}}')) === 'BAD_OUTPUT');
}

async function controlsSuite() {
  console.log('Контрольные примеры');
  ok('корректный набор разбирается', typeof parseControls(controls) !== 'string');
  ok('не JSON', typeof parseControls('{') === 'string');
  ok('нужна версия 1', typeof parseControls('{"version":2,"cases":[]}') === 'string');
  ok('больше восьми примеров — «короткий набор» нарушен', typeof parseControls(JSON.stringify({ version: 1, cases: Array.from({ length: 9 }, (_, i) => ({ name: `n${i}`, input: {}, expect: {} })) })) === 'string');
  ok('повтор имени отклонён', typeof parseControls(JSON.stringify({ version: 1, cases: [{ name: 'a', input: {}, expect: {} }, { name: 'a', input: {}, expect: {} }] })) === 'string');
  ok('допуск вне 0..1 отклонён', typeof parseControls(JSON.stringify({ version: 1, cases: [{ name: 'a', input: {}, expect: {}, tolerance: { abs: 5 } }] })) === 'string');

  ok('равные числа сходятся без допуска', compareWithTolerance({ a: 0.1 + 0.2 }, { a: 0.1 + 0.2 }).length === 0);
  ok('разница в последнем разряде видна без допуска', compareWithTolerance({ a: 0.3 }, { a: 0.1 + 0.2 }).length === 1);
  ok('абсолютный допуск', compareWithTolerance({ a: 100 }, { a: 100.4 }, { abs: 0.5 }).length === 0 && compareWithTolerance({ a: 100 }, { a: 100.6 }, { abs: 0.5 }).length === 1);
  ok('относительный допуск ±0,5 %', compareWithTolerance({ p: 1000 }, { p: 1004 }, { rel: 0.005 }).length === 0 && compareWithTolerance({ p: 1000 }, { p: 1006 }, { rel: 0.005 }).length === 1);
  ok('лишний и пропавший ключи — расхождение', compareWithTolerance({ a: 1 }, { a: 1, b: 2 }).length === 1 && compareWithTolerance({ a: 1, b: 2 }, { a: 1 }).length === 1);
  ok('строки сравниваются точно, допуск к ним не относится', compareWithTolerance({ a: 'x' }, { a: 'y' }, { abs: 1, rel: 1 }).length === 1);
  ok('длина массива', compareWithTolerance({ a: [1, 2] }, { a: [1, 2, 3] }).length === 1);
  ok('путь расхождения указан', compareWithTolerance({ a: { b: [1] } }, { a: { b: [2] } })[0].path === '$.a.b[0]');

  const set = parseControls(JSON.stringify({ version: 1, cases: [
    { name: 'верный', input: 2, expect: { r: 4 } }, { name: 'неверный', input: 3, expect: { r: 9 } }, { name: 'падает', input: 'boom', expect: {} },
  ] })) as Exclude<ReturnType<typeof parseControls>, string>;
  const report = await runControls(set, async (input) => {
    if (input === 'boom') throw new ComputeError('CRASH');
    return { r: (input as number) * 2 };
  });
  ok('набор с расхождением не проходит', !report.ok && report.passed === 1);
  ok('расхождение названо по имени примера', report.failures.some(f => f.name === 'неверный') && report.failures.some(f => f.name === 'падает'));
}

controlsSuite().then(() => console.log(`Языки логики, шаг 1: проверок ${passed}`)).catch(e => { console.error('✗', e); process.exit(1); });
