/**
 * Проект подпрограммы в Studio: заготовки, черновики, тестовая база, проверка перед отправкой, запрос.
 *
 * Что доказывается:
 * - заготовка каждого из 7 языков создаёт проект, который проходит проверку перед отправкой
 *   (контрольные примеры выполняются на настоящих рабочих потоках; Python честно «не проверяется автоматически»);
 * - проверка падает на: сломанном расчёте, зависшем расчёте (по времени), неизвестной привязке, чтении без объявления,
 *   запрещённом обращении, испорченном .wasm, пустом «что нового», отсутствии снимков и контрольных примеров;
 * - тестовая база создаётся, сбрасывается, отдаёт данные по схеме договора и ничего не знает о рабочей базе;
 * - runtime.js собирается без esbuild и содержит форму; запрос подписан ключом разработчика и принимается
 *   serverной проверкой verifyRequest с сертификатом владельца, без отчёта «выполнено» не собирается;
 * - черновик не принимает пути вне проекта.
 *
 * Запуск: npx tsx scripts/test-studio-project.ts
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import esbuild from 'esbuild';
import ts from 'typescript';
import Ajv from 'ajv';
import { runChecks, type CheckReport } from '../studio/shared/checks';
import { createControlsEngine } from '../studio/shared/controlsEngine';
import { DeveloperKeyring, type SafeStorageLike } from '../studio/shared/keyring';
import { Drafts, DraftFailure } from '../studio/shared/drafts';
import { buildPackage, buildRequest, PublishRefused } from '../studio/shared/publish';
import { assembleRuntime, loadRuntimeTemplates } from '../studio/shared/runtime';
import { createFromTemplate, TEMPLATE_IDS, TEMPLATES, type ProjectFiles, type TemplateId } from '../studio/shared/templates';
import { TestBase } from '../studio/shared/testBase';
import { dataSchemas } from '../modules/schemas';
import { unpackBundle } from '../modules/trust/bundle';
import { publicHexOf, sealEnvelope } from '../modules/trust/envelope';
import { readCertificates, verifyRequest } from '../modules/trust/verify';
import { resources } from '../modules/contract';

const { buildDeveloperAssets } = require('../studio/build-assets.cjs');
let passed = 0;
const ok = (name: string, value: unknown) => { assert.ok(value, name); passed++; console.log(`  ✓ ${name}`); };
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-studio-project-'));
const text = (bytes: Uint8Array) => Buffer.from(bytes).toString('utf8');
const enc = (value: string) => new TextEncoder().encode(value);

const storage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(plain, 'utf8').reverse(),
  decryptString: (data) => Buffer.from(data).reverse().toString('utf8'),
};
const SHOTS = { 'store/light.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6]), 'store/dark.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 7]) };
/** Проект готов к отправке: заготовка плюс снимки обеих тем */
function withShots(files: ProjectFiles): ProjectFiles {
  const manifest = JSON.parse(text(files['manifest.json']));
  manifest.store = { ...manifest.store, screenshots: Object.keys(SHOTS) };
  return { ...files, ...SHOTS, 'manifest.json': enc(JSON.stringify(manifest, null, 2)) };
}
const patchManifest = (files: ProjectFiles, patch: Record<string, unknown>): ProjectFiles =>
  ({ ...files, 'manifest.json': enc(JSON.stringify({ ...JSON.parse(text(files['manifest.json'])), ...patch })) });
const failing = (report: CheckReport) => report.items.filter(i => i.status === 'fail').map(i => i.id);

async function main() {
  console.log('Сборка заготовок Studio');
  const app = path.join(temp, 'app');
  const metafiles = await buildDeveloperAssets({ app, esbuild });
  ok('окно подпрограммы, Worker, рабочий поток и заготовки собраны', ['runtime/frame.js', 'runtime/worker.js', 'runtime/index.html', 'runtime/flux.css', 'controls-worker.cjs', 'templates/stats/form.json'].every(f => fs.existsSync(path.join(app, f))));
  ok('карты сборки есть для проверки бандла', Object.keys(metafiles).length === 3);
  const templatesRoot = path.join(app, 'templates');
  const engine = createControlsEngine({ workerFile: path.join(app, 'controls-worker.cjs'), timeoutMs: 4000 });
  const check = (files: ProjectFiles, changelog = 'Первая версия') => runChecks({ files, changelog, studioVersion: '1.0.0', engine });

  console.log('Заготовки: проект каждого языка проходит проверку');
  const created: Record<string, ProjectFiles> = {};
  for (const id of TEMPLATE_IDS) {
    const files = created[id] = createFromTemplate(templatesRoot, id, { id: `demo-${id}`, name: `Пример ${id}`, author: 'Разработчик' });
    const manifest = JSON.parse(text(files['manifest.json']));
    ok(`${id}: manifest с нужным идентификатором, версией 0.1.0 и языком`, manifest.id === `demo-${id}` && manifest.version === '0.1.0' && (manifest.language ?? 'typescript') === TEMPLATES.find(t => t.id === id)!.language);
    const report = await check(withShots(files));
    ok(`${id}: проверка проходит (${report.items.map(i => `${i.id}:${i.status}`).join(' ')})`, report.ok && failing(report).length === 0);
    const controls = report.items.find(i => i.id === 'controls')!;
    ok(`${id}: контрольные примеры ${id === 'python' ? 'честно «не проверяются автоматически»' : 'выполнены и сошлись'}`, controls.status === (id === 'python' ? 'manual' : 'ok'));
    ok(`${id}: исходники рядом с .wasm`, TEMPLATES.find(t => t.id === id)!.language !== 'wasm' || Object.keys(files).some(f => /src\/|Program\.cs|main\.go/.test(f)));
  }
  ok('идентификатор с заглавными буквами отклоняется', (() => { try { createFromTemplate(templatesRoot, 'c', { id: 'Bad', name: 'x', author: 'y' }); } catch { return true; } return false; })());

  console.log('Мутации: проверка должна падать');
  const base = withShots(created.typescript);
  const logic = text(base['logic/main.ts']);
  const mutate = (name: string, files: ProjectFiles, id: string, changelog?: string) => check(files, changelog).then(r => ok(`${name} → «не прошло»: ${id}`, failing(r).includes(id)));
  await mutate('расчёт возвращает не то', { ...base, 'logic/main.ts': enc(logic.replace('sum / count', 'sum / count + 1')) }, 'controls');
  await mutate('расчёт зависает', { ...base, 'logic/main.ts': enc(logic.replace('export function compute(input: Input) {', 'export function compute(input: Input) { for (;;) {}')) }, 'controls');
  await mutate('расчёт выбрасывает ошибку', { ...base, 'logic/main.ts': enc(logic.replace('export function compute(input: Input) {', 'export function compute(input: Input) { throw new Error("x");')) }, 'controls');
  await mutate('логика не компилируется', { ...base, 'logic/main.ts': enc(`${logic}\nexport const = ;`) }, 'controls');
  await mutate('подключён другой файл логики', { ...base, 'logic/main.ts': enc(`import { x } from './other';\n${logic}\nexport const y = x;`) }, 'controls');
  const form = JSON.parse(text(base['form.json']));
  form.groups[0].fields[0].bind = 'flux.equipment.нет_такого';
  await mutate('неизвестная привязка в форме', { ...base, 'form.json': enc(JSON.stringify(form)) }, 'bindings');
  await mutate('чтение без объявления в reads', { ...base, 'logic/main.ts': enc(`${logic}\nexport async function setup(api: any) { await api.flux.read('catalog'); }`) }, 'bindings');
  await mutate('запись в данные Flux', { ...base, 'logic/main.ts': enc(`${logic}\nexport function setup(api: any) { api.flux.write('x'); }`) }, 'bindings');
  await mutate('сетевой вызов', { ...base, 'logic/main.ts': enc(`${logic}\nexport function setup() { fetch('http://x'); }`) }, 'isolation');
  await mutate('доступ к localStorage', { ...base, 'logic/main.ts': enc(`${logic}\nexport const k = localStorage;`) }, 'isolation');
  await mutate('манифест не по договору', patchManifest(base, { entries: 'нет' }), 'contract');
  await mutate('нет файла логики', Object.fromEntries(Object.entries(base).filter(([k]) => k !== 'logic/main.ts')), 'contract');
  await mutate('нет контрольных примеров', Object.fromEntries(Object.entries(base).filter(([k]) => k !== 'examples/controls.json')), 'controls');
  await mutate('нет «что нового»', base, 'changelog', '   ');
  await mutate('нет снимков', created.typescript, 'screenshots');
  await mutate('снимок не PNG', { ...base, 'store/light.png': enc('не картинка') }, 'screenshots');
  form.groups[0].fields[0].bind = 'flux.equipment.name'; form.groups[0].title = 'ПРИТОЧНЫЙ ВЕНТИЛЯТОР';
  await mutate('заголовок заглавными буквами (методология)', { ...base, 'form.json': enc(JSON.stringify(form)) }, 'methodology');
  form.groups[0].title = 'Мгновенный расчёт';
  await mutate('рекламное слово в заголовке (методология)', { ...base, 'form.json': enc(JSON.stringify(form)) }, 'methodology');
  const wasm = withShots(created.rust);
  await mutate('испорченный .wasm', { ...wasm, 'logic/main.wasm': new Uint8Array(wasm['logic/main.wasm'].slice(0, 40)) }, 'isolation');
  const controls = JSON.parse(text(wasm['examples/controls.json'])); controls.cases[0].expect.calc.out.sum += 1;
  await mutate('.wasm даёт не то, что ждёт контрольный пример', { ...wasm, 'examples/controls.json': enc(JSON.stringify(controls)) }, 'controls');
  const slow = await check({ ...base, 'logic/main.ts': enc(logic.replace('export function compute(input: Input) {', 'export function compute(input: Input) { for (;;) {}')) });
  ok('зависший расчёт назван по коду TIMEOUT', /TIMEOUT/.test(slow.items.find(i => i.id === 'controls')!.detail) && failing(slow).includes('limits'));

  console.log('Договор раздела «Редактор»');
  // Типовая проверка: компонент раздела обязан принимать EditorProps. Настоящий раздел — когда он есть в репозитории; заглушка — всегда
  const contractProblems = (component: string): string[] => {
    const probe = path.join(root, 'studio', 'renderer', '__editorsContract.check.tsx');
    const rel = './' + path.relative(path.dirname(probe), component).replace(/\\/g, '/').replace(/\.tsx?$/, '');
    fs.writeFileSync(probe, `import type { ComponentType } from 'react';\nimport type { EditorProps } from '../shared/editorContract';\nimport Real from '${rel}';\nexport const accepted: ComponentType<EditorProps> = Real;\n`);
    try {
      const config = ts.getParsedCommandLineOfConfigFile(path.join(root, 'tsconfig.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
      const program = ts.createProgram([probe], { ...config!.options, noEmit: true });
      return ts.getPreEmitDiagnostics(program, program.getSourceFile(probe)).map(d => ts.flattenDiagnosticMessageText(d.messageText, ' '));
    } finally { fs.rmSync(probe, { force: true }); }
  };
  ok('заглушка «Редактор» принимает EditorProps', contractProblems(path.join(root, 'studio/renderer/editorsStub.tsx')).length === 0);
  ok('проверка умеет падать: компонент с чужим договором не проходит', (() => {
    const wrong = path.join(root, 'studio', 'renderer', '__wrongEditors.tsx');
    fs.writeFileSync(wrong, "import React from 'react';\nexport default function Wrong(props: { form: number }) { return <div>{props.form}</div>; }\n");
    try { return contractProblems(wrong).length > 0; } finally { fs.rmSync(wrong, { force: true }); }
  })());
  const realEditors = path.join(root, 'studio/renderer/editors/index.tsx');
  if (fs.existsSync(realEditors)) ok('настоящий studio/renderer/editors/index.tsx принимает EditorProps', contractProblems(realEditors).length === 0);
  else console.log('  · настоящего раздела редакторов ещё нет: проверяется заглушка');

  console.log('Тестовая база');
  const testBase = new TestBase(path.join(temp, 'data'));
  ok('создаётся при первом обращении и лежит в каталоге данных', testBase.ensure() === true && fs.existsSync(path.join(temp, 'data', 'test-base.sqlite')));
  const counts = testBase.counts();
  ok('образцы: проекты, теги, системы, установки, оборудование, файлы, спецификации, ВДР', Object.values(counts).every(n => n > 0));
  const projects = testBase.context();
  ok('контекст запуска: проекты с позициями и тегами', projects.length === 2 && projects[0].equipment.length === 3 && projects[0].tags.length === 5);
  const ajv = new Ajv({ strict: false });
  const ctx = { projectId: 'p1', entry: 'equipment' as const, entityId: 'p1-e-fan' };
  for (const resource of resources) {
    const data = testBase.read(resource, resource === 'tag' ? { ...ctx, entry: 'tag', entityId: 'p1-t-fan' } : ctx);
    ok(`чтение «${resource}» соответствует схеме договора`, ajv.validate((dataSchemas as any)[resource], data));
  }
  const fan = testBase.read('equipment', ctx)!;
  ok('позиция: параметры, теги и состав', fan.params.length === 5 && fan.tags.length === 1 && fan.composition.length === 2);
  ok('иерархия тегов: у «V1.01.M1» родитель «V1.01»', (() => { const t = testBase.read('tag', { ...ctx, entityId: 'p1-t-fan' })!; return t.parentId === 'p1-t-unit'; })());
  ok('чужой проект не отдаёт позицию', testBase.read('equipment', { ...ctx, projectId: 'p2' }) === null);
  ok('без проекта проект не читается', testBase.read('project', { projectId: null, entry: 'start', entityId: null }) === null);
  ok('эквивалент SQL-инъекции в идентификаторе ничего не отдаёт', testBase.read('equipment', { ...ctx, entityId: "x' OR '1'='1" }) === null);
  const marker = path.join(temp, 'data', 'test-base.sqlite');
  fs.appendFileSync(marker, ''); testBase.reset();
  ok('сброс возвращает образцы', testBase.exists() && JSON.stringify(testBase.counts()) === JSON.stringify(counts));
  ok('в каталоге тестовой базы нет данных рабочей базы', fs.readdirSync(path.join(temp, 'data')).every(f => f.startsWith('test-base')));

  console.log('Черновики');
  const drafts = new Drafts(path.join(temp, 'data'));
  drafts.create('demo-c', created.c, { template: 'c' });
  ok('черновик создан и виден в списке', drafts.list().map(d => d.id).join() === 'demo-c' && drafts.list()[0].language === 'c');
  ok('файлы читаются побайтно', Buffer.from(drafts.files('demo-c')['logic/main.wasm']).equals(Buffer.from(created.c['logic/main.wasm'])));
  const refusedDraft = (fn: () => void) => { try { fn(); } catch (e) { return e instanceof DraftFailure; } return false; };
  ok('путь вне проекта отклоняется', refusedDraft(() => drafts.writeFile('demo-c', '../outside.txt', 'x')) && refusedDraft(() => drafts.writeFile('demo-c', 'a/../../x.txt', 'x')));
  ok('служебный каталог build/ не записывается', refusedDraft(() => drafts.writeFile('demo-c', 'build/runtime.js', 'x')));
  ok('manifest.json удалять нельзя', refusedDraft(() => drafts.deleteFile('demo-c', 'manifest.json')));
  ok('второй проект с тем же идентификатором отклоняется', refusedDraft(() => drafts.create('demo-c', created.c, { template: 'c' })));
  drafts.writeFile('demo-c', 'notes/todo.txt', 'проверить');
  ok('новый файл сохранён', text(drafts.files('demo-c')['notes/todo.txt']) === 'проверить');
  drafts.setState('demo-c', { changelog: 'Исправил' });
  ok('состояние хранится рядом', drafts.state('demo-c').changelog === 'Исправил');
  const refusedBig = (fn: () => void) => { try { fn(); } catch (e) { return e instanceof DraftFailure && /не больше|больше 32/.test(e.message); } return false; };
  for (let i = 0; i < 20; i++) drafts.writeFile('demo-c', `notes/n${i}.txt`, 'x');
  const count = Object.keys(drafts.files('demo-c')).length;
  drafts.create('many-files', Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`f/${i}.txt`, new Uint8Array([1])])), { template: 'x' });
  ok('предел числа файлов действует и при правке', refusedBig(() => drafts.writeFile('many-files', 'f/extra.txt', 'x')) && count > 20);
  ok('перезапись существующего файла при полном проекте разрешена', (() => { drafts.writeFile('many-files', 'f/0.txt', 'y'); return true; })());
  drafts.remove('many-files');
  drafts.create('big-size', { 'a.bin': new Uint8Array(20 * 1024 * 1024) }, { template: 'x' });
  ok('предел суммарного размера действует и при правке', refusedBig(() => drafts.writeFile('big-size', 'b.bin', new Uint8Array(20 * 1024 * 1024))));
  drafts.remove('big-size');
  drafts.remove('demo-c');
  ok('удаление убирает проект', drafts.list().length === 0);

  console.log('runtime.js и запрос на публикацию');
  const templates = loadRuntimeTemplates(path.join(app, 'runtime'));
  const ready = withShots(created.typescript);
  const assembled = assembleRuntime(templates, JSON.parse(text(ready['manifest.json'])), ready);
  ok('runtime.js собран без esbuild: форма и логика внутри, меток нет', !assembled.problem && assembled.runtime.includes('Статистика числовых параметров') && !/@@FLUX_MODULE/.test(assembled.runtime) && assembled.runtime.includes('__fluxLogic'));
  ok('логика с ошибкой не даёт runtime', assembleRuntime(templates, JSON.parse(text(ready['manifest.json'])), { ...ready, 'logic/main.ts': enc('export const = ;') }).problem !== '');
  const wasmReady = withShots(created.go);
  ok('runtime.js для .wasm не несёт Worker логики', (() => { const r = assembleRuntime(templates, JSON.parse(text(wasmReady['manifest.json'])), wasmReady); return !r.problem && !r.runtime.includes('__fluxLogic=('); })());

  const keyring = new DeveloperKeyring(path.join(temp, 'keys'), storage);
  const dev = keyring.create();
  const root_ = crypto.generateKeyPairSync('ed25519').privateKey, rootHex = publicHexOf(root_);
  const certificate = sealEnvelope('certificate', { v: 1, key: dev.publicKey, userId: 'dev-1', name: 'Разработчик', iat: Date.now() }, root_);
  const certs = readCertificates([certificate], rootHex, { releases: new Set(), keys: new Set() });
  const goodReport = await check(ready);
  const input = {
    moduleId: 'demo-typescript', version: '0.1.0', files: ready, runtime: assembled.runtime, baseRelease: null, parentRequest: null,
    channel: 'test' as const, changelog: 'Первая версия', comment: 'Проверьте расчёт', report: goodReport, studioVersion: '1.2.3',
  };
  const built = buildRequest(keyring, input);
  const verified = verifyRequest({ signature: built.signature, bundle: built.bundle, rootHex, certificates: certs });
  ok('запрос принимается проверкой сервера с сертификатом владельца', verified.ok && verified.claim.author === dev.publicKey && verified.claim.meta.changelog === 'Первая версия');
  ok('в пакете исходники, форма, примеры, снимки и runtime', (() => { const f = unpackBundle(built.bundle); return ['manifest.json', 'form.json', 'logic/main.ts', 'examples/controls.json', 'store/light.png', 'store/dark.png', 'build/runtime.js'].every(n => f[n]); })());
  ok('отчёт проверок приложен к запросу', JSON.parse(built.claim.meta.checks).items.length === goodReport.items.length && JSON.parse(built.claim.meta.checks).ok === true);
  ok('в запросе нет закрытого ключа', !built.signature.includes(JSON.parse(fs.readFileSync(path.join(temp, 'keys', 'developer-key.json'), 'utf8')).secret));
  const noCert = verifyRequest({ signature: built.signature, bundle: built.bundle, rootHex, certificates: new Map() });
  ok('без сертификата владельца запрос не принимается', !noCert.ok);
  const refusedBuild = (patch: Record<string, unknown>) => { try { buildRequest(keyring, { ...input, ...patch } as any); } catch (e) { return e instanceof PublishRefused; } return false; };
  ok('мутация: отчёт «не прошло» — запрос не собирается', refusedBuild({ report: { ...goodReport, ok: false } }));
  ok('мутация: пустое «что нового» — запрос не собирается', refusedBuild({ changelog: '  ' }));
  ok('мутация: версия не по формату — запрос не собирается', refusedBuild({ version: '1.0' }));
  ok('без ключа запрос не собирается', (() => { try { buildRequest(new DeveloperKeyring(path.join(temp, 'nokeys'), storage), input); } catch (e) { return e instanceof PublishRefused; } return false; })());
  ok('пакет подмены: другой runtime даёт другой хеш', buildRequest(keyring, { ...input, runtime: assembled.runtime + ' ' }).claim.sha256 !== built.claim.sha256);
  ok('build/ из проекта в пакет не попадает', !text(unpackBundle(buildPackage({ ...ready, 'build/runtime.js': enc('evil') }, 'real'))['build/runtime.js']).includes('evil'));

  console.log(`\nFlux Studio: проект подпрограммы — ${passed} проверок пройдено`);
}
main().then(() => fs.rmSync(temp, { recursive: true, force: true })).catch((error) => { console.error(error); process.exit(1); });
