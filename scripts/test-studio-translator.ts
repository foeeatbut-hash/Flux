/**
 * Пример-заготовка «Переводчик терминов» (modules/fixtures/translator): путь от создания проекта до запроса на публикацию.
 *
 * Что доказывается:
 * - заготовка создаётся из «Создать из примера», проходит проверку перед отправкой целиком (в том числе контрольные
 *   примеры, снимки обеих тем и «что нового» из заготовки), пакет принимает проверка сервера на синтетических ключах;
 * - словарь осмысленный: не меньше 300 пар, пары однозначны в обе стороны, нет пустых и перепутанных сторон;
 * - перевод по словарю в обе стороны, фразы длиннее слова, окончания, множественное число, регистр первой буквы;
 * - поиск по части слова, подсказки похожих при опечатке, перевод списка строк пачкой, слова вне словаря;
 * - строки берутся и из данных Flux (позиция, тег, спецификация), и из состояния; предел числа и длины строк;
 * - форма и логика согласованы: каждая привязка формы есть в результате расчёта, числа полей совпадают с логикой;
 * - мутации: другой словарь, сломанный поиск, сетевой вызов, запись в данные Flux, лишний контрольный пример — проверка падает.
 *
 * Запуск: npx tsx scripts/test-studio-translator.ts
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import esbuild from 'esbuild';
import { runChecks } from '../studio/shared/checks';
import { createControlsEngine } from '../studio/shared/controlsEngine';
import { DeveloperKeyring, type SafeStorageLike } from '../studio/shared/keyring';
import { buildRequest } from '../studio/shared/publish';
import { assembleRuntime, loadRuntimeTemplates } from '../studio/shared/runtime';
import { compileLogic } from '../studio/shared/logicSource';
import { createFromTemplate, TEMPLATE_IDS, TEMPLATES, type ProjectFiles } from '../studio/shared/templates';
import { unpackBundle } from '../modules/trust/bundle';
import { publicHexOf, sealEnvelope } from '../modules/trust/envelope';
import { readCertificates, verifyRequest } from '../modules/trust/verify';

const { buildDeveloperAssets } = require('../studio/build-assets.cjs');
let passed = 0;
const ok = (name: string, value: unknown) => { assert.ok(value, name); passed++; console.log(`  ✓ ${name}`); };
const eq = (name: string, actual: unknown, expected: unknown) => { assert.deepEqual(actual, expected, name); passed++; console.log(`  ✓ ${name}`); };
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-studio-translator-'));
const text = (bytes: Uint8Array) => Buffer.from(bytes).toString('utf8');
const enc = (value: string) => new TextEncoder().encode(value);
const storage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(plain, 'utf8').reverse(),
  decryptString: (data) => Buffer.from(data).reverse().toString('utf8'),
};

type Out = Record<string, any>;
/** Логика проекта, скомпилированная так же, как её запускает Studio, и вызванная как функция */
function load(source: string): (input: unknown) => Out {
  const compiled = compileLogic(source);
  assert.equal(compiled.problem, '');
  const holder: { exports: any } = { exports: {} };
  new Function('module', 'exports', compiled.code)(holder, holder.exports);
  return (input) => holder.exports.compute(input).calc.out;
}
const failing = (report: { items: Array<{ id: string; status: string }> }) => report.items.filter(i => i.status === 'fail').map(i => i.id);

async function main() {
  const app = path.join(temp, 'app');
  await buildDeveloperAssets({ app, esbuild });
  const templatesRoot = path.join(app, 'templates');
  const engine = createControlsEngine({ workerFile: path.join(app, 'controls-worker.cjs'), timeoutMs: 4000 });
  const info = TEMPLATES.find(t => t.id === 'translator')!;
  const files = createFromTemplate(templatesRoot, 'translator', { id: 'my-translator', name: 'Мой переводчик', author: 'Разработчик' });
  const check = (project: ProjectFiles, changelog = info.changelog || '') => runChecks({ files: project, changelog, studioVersion: '1.0.0', engine });
  const source = text(files['logic/main.ts']);
  const translate = load(source);

  console.log('Заготовка: создание и проверка перед отправкой');
  ok('в списке заготовок есть пример «Переводчик», он зарегистрирован в TEMPLATE_IDS', TEMPLATE_IDS.includes('translator') && /Переводчик/.test(info.title) && info.language === 'typescript');
  const manifest = JSON.parse(text(files['manifest.json']));
  ok('manifest: идентификатор, название и версия проекта, чтение только оборудования, тега и спецификации', manifest.id === 'my-translator' && manifest.name === 'Мой переводчик' && manifest.version === '0.1.0' && manifest.reads.every((r: string) => ['equipment', 'tag', 'specification'].includes(r)));
  ok('в проекте логика, форма, контрольные примеры и снимки обеих тем', ['logic/main.ts', 'form.json', 'examples/controls.json', 'store/light.png', 'store/dark.png'].every(n => files[n]?.length));
  ok('в «что нового» заготовки есть текст', (info.changelog || '').length > 40);
  const report = await check(files);
  ok(`проверка проходит целиком из коробки (${report.items.map(i => `${i.id}:${i.status}`).join(' ')})`, report.ok && failing(report).length === 0);
  ok('контрольные примеры выполнены и сошлись', report.items.find(i => i.id === 'controls')!.status === 'ok');
  ok('снимки обеих тем засчитаны', report.items.find(i => i.id === 'screenshots')!.status === 'ok');
  ok('изоляция: в тексте логики нет сети, хранилищ и записи', report.items.find(i => i.id === 'isolation')!.status === 'ok' && report.items.find(i => i.id === 'bindings')!.status === 'ok');

  console.log('Словарь');
  const dictionary = [...source.matchAll(/const DICTIONARY = `([\s\S]*?)`\.trim\(\)/g)][0][1].split('\n').filter(l => l && !l.startsWith('#')).map(l => l.split('|'));
  ok(`не меньше 300 пар (их ${dictionary.length})`, dictionary.length >= 300);
  ok('в каждой строке ровно две непустые стороны', dictionary.every(p => p.length === 2 && p[0].trim() && p[1].trim()));
  ok('русская сторона кириллицей, английская латиницей (кроме ГОСТ)', dictionary.every(([ru, en]) => /[а-яё]/i.test(ru) || ru === 'ГОСТ') && dictionary.every(([, en]) => !/[а-яё]/i.test(en)));
  const keys = (side: number) => dictionary.map(p => p[side].toLowerCase().replace(/ё/g, 'е'));
  ok('русские термины не повторяются', new Set(keys(0)).size === dictionary.length);
  ok('английские термины не повторяются: обратный перевод однозначен', new Set(keys(1)).size === dictionary.length);
  ok('в разделах есть КИПиА, трубопроводы, электрика, документация', ['# КИПиА', '# Трубопроводы', '# Электрика', '# Документация'].every(h => source.includes(h)));
  ok('словарь не тянет данные из пакета: нет чтения файлов и сети', !/\b(?:fs|fetch|require|import)\b\s*[.(]/.test(source.replace(/^\/\/.*$/gm, '')));

  console.log('Перевод');
  const run = (state: Record<string, unknown>, flux: Record<string, unknown> = {}) => translate({ v: 1, context: { projectId: 'p', entry: 'equipment', entityId: 'e' }, flux, state });
  eq('фраза из словаря RU в EN', run({ lines: ['Датчик давления'] }).column, 'Pressure sensor');
  eq('регистр первой буквы сохраняется', run({ lines: ['датчик давления'] }).column, 'pressure sensor');
  eq('окончания: «датчики температуры и расхода»', run({ lines: ['Датчики температуры и расхода'] }).column, 'Temperature sensor and flow rate');
  eq('самая длинная фраза побеждает: «шкаф управления», а не «шкаф» и «управление»', run({ lines: ['Шкаф управления DN50'] }).column, 'Control cabinet DN50');
  eq('числа, единицы и знаки остаются как есть', run({ lines: ['Пневмопривод, 24 В'] }).column, 'Pneumatic actuator, 24 В');
  eq('EN в RU, множественное число у последнего слова', run({ lines: ['Pressure sensors', 'Control valves'] }).column, 'Датчик давления\nРегулирующий клапан');
  eq('направление вручную: «ru-en» не переводит английскую строку', run({ direction: 'ru-en', lines: ['Valve'] }).column, 'Valve');
  eq('направление определяется по каждой строке отдельно', run({ lines: ['Клапан', 'Valve'] }).column, 'Valve\nКлапан');
  const batch = run({ lines: 'Клапан\r\nЗадвижка\n\n  Манометр  ' });
  eq('столбец: вставил текст по строкам — получил столько же строк, пустые отброшены, пробелы срезаны', [batch.total, batch.column], [3, 'Valve\nGate valve\nPressure gauge']);
  const mixed = run({ lines: ['Фильтр грубой очистки', 'Рассходомер ультразвуковой', 'Flange gaskit', '12345'] });
  eq('частично переведённая, непереведённая и «нечего переводить» считаются отдельно', [mixed.partial, mixed.none, mixed.skipped, mixed.full], [2, 1, 1, 0]);
  ok('слова вне словаря показаны, неизвестный алфавит и числа в них не попадают', mixed.gap1 && /gaskit/.test(mixed.gap1) && mixed.missingWords === 4 && !/12345|dn/i.test(JSON.stringify([mixed.gap1, mixed.gap2, mixed.gap3, mixed.gap4])));
  ok('подсказка похожего: опечатка «рассходомер» → «расходомер = flowmeter»', Object.keys(mixed).filter(k => /^gap\d/.test(k)).some(k => /расходомер = flowmeter/.test(mixed[k])));
  ok('подсказка похожего на английской стороне: «gaskit» → «gasket = прокладка»', /gasket = прокладка/.test(mixed.gap1));

  console.log('Поиск');
  const found = run({ query: 'датч', lines: ['Клапан'] });
  ok('по части слова найдены все датчики, первым — точная запись «датчик»', found.foundCount >= 10 && found.found1 === 'датчик = sensor' && /датчик/.test(found.found10));
  ok('«Ещё N»: что не поместилось в форму, названо', /^Ещё \d+/.test(found.moreFound));
  const english = run({ query: 'valv', direction: 'en-ru' });
  ok('по части английского слова', english.foundCount >= 6 && english.found1 === 'клапан = valve');
  const typo = run({ query: 'темпратура' });
  ok('опечатка: записей нет, но есть похожие', typo.foundCount === 0 && typo.similarCount > 0 && /температура = temperature/.test(JSON.stringify(typo)));
  eq('без запроса поиск молчит', [run({ lines: ['Клапан'] }).query, run({ lines: ['Клапан'] }).foundCount, run({ lines: ['Клапан'] }).similarCount], ['', 0, 0]);

  console.log('Откуда берутся строки');
  const equipment = {
    id: 'e', name: 'Насос центробежный', itemCode: 'Н-1', equipType: 'НАСОС', version: 1,
    params: [{ group: 'Электрика', key: 'Номинальная мощность', value: '7.5', unit: 'кВт' }, { group: 'Электрика', key: 'Степень защиты', value: 'IP55', unit: '' }],
    tags: [{ id: 't', identifier: 'P-101', name: 'Насос подачи воды', parentId: null }], composition: [],
  };
  const fromFlux = run({}, { equipment });
  eq('позиция Flux: наименование, группы, параметры и теги, без повторов; значения не переводятся', [fromFlux.source, fromFlux.total, fromFlux.row1.split(' → ')[0]], ['Позиция оборудования', 5, 'Насос центробежный']);
  ok('значения параметров («IP55», «7.5») в строки не попадают', !/IP55|7\.5/.test(JSON.stringify(fromFlux)));
  const spec = run({}, { specification: { rows: [{ id: 'a', identifier: 'V-1', name: 'Клапан', parentId: null }, { id: 'b', identifier: 'V-2', name: 'Клапан', parentId: null }] } });
  eq('спецификация проекта: одинаковые названия переводятся один раз', [spec.source, spec.total], ['Спецификация проекта', 1]);
  eq('тег', run({}, { tag: { id: 't', identifier: 'T-1', name: 'Манометр', parentId: null } }).column, 'Pressure gauge');
  eq('состояние главнее данных Flux', run({ lines: ['Клапан'] }, { equipment }).source, 'Список строк');
  eq('пусто: нет данных, ничего не падает', [run({}).source, run({}).total], ['Нет данных', 0]);
  const many = run({ lines: Array.from({ length: 305 }, (_, i) => `Клапан ${i}`) });
  ok('предел 300 строк: лишнее отброшено, об этом сказано', many.total === 300 && /300/.test(many.truncated) && many.moreRows !== '');
  ok('длинная строка обрезается до 200 знаков', run({ lines: ['Клапан'.repeat(100)] }).row1.split(' → ')[0].length === 200);
  ok('в логике нет записи и сети: расчёт чистый, входные данные не меняются', (() => { const frozen = Object.freeze({ lines: Object.freeze(['Клапан']) }); return run(frozen as any).column === 'Valve'; })());

  console.log('Форма и логика согласованы');
  const form = JSON.parse(text(files['form.json']));
  const bound = new Set<string>(form.groups.flatMap((g: any) => g.fields.map((f: any) => f.bind.replace(/^calc\.out\./, ''))));
  const sample = run({ lines: ['Клапан'], query: 'кла' });
  ok('каждая привязка формы есть в результате расчёта', [...bound].every(b => b in sample));
  const prefix = (name: string) => Object.keys(sample).filter(k => new RegExp(`^${name}\\d+$`).test(k)).length;
  eq('полей строк, слов, найденного и похожего столько же, сколько в форме', [prefix('row'), prefix('gap'), prefix('found'), prefix('similar')], ['row', 'gap', 'found', 'similar'].map(n => [...bound].filter(b => new RegExp(`^${n}\\d+$`).test(b)).length));
  ok('форма не выводит таблицы: договор v1 берёт таблицы только из данных Flux', form.tables.length === 0);
  ok('тексты формы без слова «программа»: во Flux это программы', !/программ/i.test(text(files['form.json'])) && !/программ/i.test(info.note + info.title + (info.changelog || '')));

  console.log('Мутации: проверка должна падать');
  const mutate = async (name: string, patch: ProjectFiles, id: string) => { const r = await check({ ...files, ...patch }); ok(`${name} → «не прошло»: ${id}`, failing(r).includes(id)); };
  await mutate('в словаре потеряна пара', { 'logic/main.ts': enc(source.replace('датчик давления|pressure sensor\n', '')) }, 'controls');
  await mutate('перепутан перевод', { 'logic/main.ts': enc(source.replace('клапан|valve', 'клапан|valves')) }, 'controls');
  await mutate('поиск ищет только с начала слова', { 'logic/main.ts': enc(source.replace('if (own.includes(key)) return 3;', '')) }, 'controls');
  await mutate('не режется окончание', { 'logic/main.ts': enc(source.replace('out.length > 3 &&', 'out.length > 99 &&')) }, 'controls');
  await mutate('подсказки отключены', { 'logic/main.ts': enc(source.replace('similar(word, direction, 3)', 'similar(word, direction, 0)')) }, 'controls');
  await mutate('в расчёте сетевой вызов', { 'logic/main.ts': enc(`${source}\nexport function extra() { fetch('http://x'); }`) }, 'isolation');
  await mutate('запись в данные Flux', { 'logic/main.ts': enc(`${source}\nexport function extra(api: any) { api.flux.write('x'); }`) }, 'bindings');
  await mutate('чтение каталога без объявления', { 'logic/main.ts': enc(`${source}\nexport async function extra(api: any) { await api.flux.read('catalog'); }`) }, 'bindings');
  const controls = JSON.parse(text(files['examples/controls.json']));
  controls.cases[0].expect.calc.out.row1 = 'не то';
  await mutate('контрольный пример ждёт другое', { 'examples/controls.json': enc(JSON.stringify(controls)) }, 'controls');
  const { 'store/light.png': _l, 'store/dark.png': _d, ...noShots } = files;
  ok('без снимков проверка падает', failing(await check(noShots)).includes('screenshots'));
  ok('без «что нового» проверка падает', failing(await check(files, '  ')).includes('changelog'));

  console.log('Запрос на публикацию');
  const templates = loadRuntimeTemplates(path.join(app, 'runtime'));
  const assembled = assembleRuntime(templates, manifest, files);
  ok('runtime.js собран: форма и логика внутри', !assembled.problem && assembled.runtime.includes('Перевод строк') && assembled.runtime.includes('__fluxLogic'));
  const keyring = new DeveloperKeyring(path.join(temp, 'keys'), storage);
  const dev = keyring.create();
  const rootKey = crypto.generateKeyPairSync('ed25519').privateKey, rootHex = publicHexOf(rootKey);
  const certificate = sealEnvelope('certificate', { v: 1, key: dev.publicKey, userId: 'dev-1', name: 'Разработчик', iat: Date.now() }, rootKey);
  const certs = readCertificates([certificate], rootHex, { releases: new Set(), keys: new Set() });
  const built = buildRequest(keyring, {
    moduleId: 'my-translator', version: '0.1.0', files, runtime: assembled.runtime, baseRelease: null, parentRequest: null,
    channel: 'test', changelog: info.changelog || '', comment: 'Пример для проверки пути до Store', report,
    studioVersion: '1.2.3',
  });
  const verified = verifyRequest({ signature: built.signature, bundle: built.bundle, rootHex, certificates: certs });
  ok('запрос принимает проверка сервера (синтетические ключи)', verified.ok && verified.claim.author === dev.publicKey);
  ok('в пакете код, форма, примеры, снимки и runtime', (() => { const f = unpackBundle(built.bundle); return ['manifest.json', 'form.json', 'logic/main.ts', 'examples/controls.json', 'store/light.png', 'store/dark.png', 'build/runtime.js'].every(n => f[n]); })());
  ok('подмена словаря даёт другой хеш запроса', buildRequest(keyring, {
    moduleId: 'my-translator', version: '0.1.0', files: { ...files, 'logic/main.ts': enc(source.replace('клапан|valve', 'клапан|valves')) }, runtime: assembled.runtime, baseRelease: null, parentRequest: null,
    channel: 'test', changelog: info.changelog || '', comment: '', report, studioVersion: '1.2.3',
  }).claim.sha256 !== built.claim.sha256);

  console.log(`\nFlux Studio: пример «Переводчик» — ${passed} проверок пройдено`);
}
main().then(() => fs.rmSync(temp, { recursive: true, force: true })).catch((error) => { console.error(error); process.exit(1); });
