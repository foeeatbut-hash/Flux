/**
 * «Запустить во Flux», сторона Studio: файлы папки обмена против настоящей проверки Flux.
 *
 * Что доказывается:
 * - то, что записал Studio (run.json, lease.txt, package.bin), проходит `verifyDevRun` из modules/trust/devRun.ts с тестовым корнем —
 *   на каждом языке заготовки (TypeScript, Python, C, C++, Rust, Go, C#), страница и форма;
 * - пакет — ровно тот, что уходит владельцу (`buildPackage`), подписан ключом разработчика, userId — вошедшего человека;
 * - отказы словами: нет входа, нет ключа, повреждённый ключ, нет сертификата, сертификат чужого ключа или человека, пакет не собран,
 *   Flux на компьютере не найден, ключ другой учётной записи Windows, папку нельзя записать;
 * - Flux отказывает на подмене: другой человек вошёл, другой корень, чужой ключ, протухшая аренда, подменённый пакет;
 * - запись: временный файл + rename, `package.bin` и `run.json` раньше `lease.txt`, продление меняет только аренду;
 * - уборка трогает только `dev-run/<moduleId>/` и только свои осиротевшие папки; config.json Flux и чужие папки целы.
 * Набор обязан падать на мутациях модуля: подмена userId в записи, чужой автор в записи, сертификат без сверки (проверено вручную при сдаче).
 *
 * Запуск: npx tsx scripts/test-studio-dev-run.ts
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DeveloperKeyring, type SafeStorageLike } from '../studio/shared/keyring';
import { createFromTemplate, TEMPLATE_IDS, type ProjectFiles } from '../studio/shared/templates';
import { DevRunFolder, DevRunRefused, findFluxDataDir, prepareDevRun, renewLease, sweepOrphans } from '../studio/shared/devRun';
import { DEV_LEASE_RENEW_MS, DEV_LEASE_TTL_MS, DEV_RUN_FILES, verifyDevRun, type DevRunFile } from '../modules/trust/devRun';
import http from 'node:http';
import { DevRunHost } from '../studio/shell/devRunHost';
import { DeveloperService } from '../studio/shell/developer';
import { createControlsEngine } from '../studio/shared/controlsEngine';
import { ALL_ACTIONS } from '../studio/shell/actions';
import { buildPackage } from '../studio/shared/publish';
import { describeBundle } from '../modules/trust/verify';
import { hexOf, newKey, certificateEnvelope } from './fixtures/moduleTrust';

const { buildDeveloperAssets } = require('../studio/build-assets.cjs');
import esbuild from 'esbuild';

let passed = 0;
const ok = (name: string, value: unknown) => { assert.ok(value, name); passed++; console.log(`  ✓ ${name}`); };
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-studio-devrun-'));
const NOW = 1_800_000_000_000;

function storageFor(account: string): SafeStorageLike {
  const key = crypto.createHash('sha256').update(`account:${account}`).digest();
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv); const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), body]); },
    decryptString: (data) => { const d = crypto.createDecipheriv('aes-256-gcm', key, data.subarray(0, 12)); d.setAuthTag(data.subarray(12, 28)); return Buffer.concat([d.update(data.subarray(28)), d.final()]).toString('utf8'); },
  };
}
const refusal = (fn: () => unknown, pattern: RegExp) => { try { fn(); } catch (e: any) { return e instanceof DevRunRefused && pattern.test(e.message); } return false; };
const noRevoked = { keys: new Set<string>(), releases: new Set<string>() } as any;

async function main() {
  const app = path.join(temp, 'app');
  await buildDeveloperAssets({ app, esbuild });
  const templatesRoot = path.join(app, 'templates');

  const root = newKey(), rootHex = hexOf(root);
  const keyDir = path.join(temp, 'studio-data');
  const keyring = new DeveloperKeyring(keyDir, storageFor('windows-user-1'));
  keyring.create();
  const devHex = keyring.info().publicKey;
  const certificate = certificateEnvelope(root, devHex, 'dev-1');
  const flux = path.join(temp, 'AppData', 'pdm-app');
  fs.mkdirSync(flux, { recursive: true });
  fs.writeFileSync(path.join(flux, 'config.json'), '{"current_db_type":"LOCAL"}');

  const pageFiles = (template: string, id: string): ProjectFiles => createFromTemplate(templatesRoot, template as any, { id, name: `Программа ${template}`, author: 'Разработчик' }, 'page');
  const verify = (p: { runJson: string; bundle: Uint8Array; lease: string }, over: Record<string, any> = {}) => {
    const file = JSON.parse(p.runJson) as DevRunFile;
    return verifyDevRun({ run: file.run, lease: p.lease, certificate: file.certificate, bundle: p.bundle, rootHex, revoked: noRevoked, now: NOW + 1000, userId: 'dev-1', ...over });
  };
  const base = (id: string, template: string, over: Record<string, any> = {}) => ({
    keyring, certificate, userId: 'dev-1', moduleId: id, version: '0.1.0', files: pageFiles(template, id), runtime: '', now: NOW, ...over,
  });

  console.log('Файлы проходят проверку Flux: каждый язык');
  for (const template of TEMPLATE_IDS.filter(t => t !== 'translator')) {
    const id = `page-${template}`;
    const prepared = prepareDevRun(base(id, template));
    const verdict = verify(prepared);
    ok(`${template}: verifyDevRun принимает (${verdict.ok ? 'ok' : (verdict as any).why})`, verdict.ok);
    if (verdict.ok) ok(`${template}: пакет разработки, а не выпуск; автор — ключ разработчика, человек — вошедший`, verdict.dev.author === devHex && verdict.dev.userId === 'dev-1' && verdict.claim.request === 'dev-run' && verdict.developer === 'Разработчик');
  }
  const same = prepareDevRun(base('page-python', 'python'));
  ok('пакет тот же, что уходит владельцу (buildPackage), по хешу', describeBundle(same.bundle).sha256 === describeBundle(buildPackage(pageFiles('python', 'page-python'), '')).sha256);

  console.log('Форма с runtime (TypeScript)');
  {
    const { assembleRuntime, loadRuntimeTemplates } = await import('../studio/shared/runtime');
    const files = createFromTemplate(templatesRoot, 'typescript', { id: 'form-ts', name: 'Форма', author: 'Разработчик' });
    const manifest = JSON.parse(Buffer.from(files['manifest.json']).toString('utf8'));
    const built = assembleRuntime(loadRuntimeTemplates(path.join(app, 'runtime')), manifest, files);
    ok('runtime форм собран', !built.problem && built.runtime.length > 0);
    const prepared = prepareDevRun(base('form-ts', 'typescript', { files, runtime: built.runtime }));
    const verdict = verify(prepared);
    ok(`форма с runtime принимается (${verdict.ok ? 'ok' : (verdict as any).why})`, verdict.ok);
  }

  console.log('Отказы Studio словами');
  ok('не вошёл — просит войти', refusal(() => prepareDevRun(base('page-go', 'go', { userId: '' })), /войдите в Studio/));
  const empty = new DeveloperKeyring(path.join(temp, 'empty'), storageFor('windows-user-1'));
  ok('нет ключа', refusal(() => prepareDevRun(base('page-go', 'go', { keyring: empty })), /Ключа разработчика нет/));
  const damagedDir = path.join(temp, 'damaged');
  fs.mkdirSync(damagedDir, { recursive: true });
  fs.writeFileSync(path.join(damagedDir, 'developer-key.json'), '{oops');
  ok('ключ повреждён', refusal(() => prepareDevRun(base('page-go', 'go', { keyring: new DeveloperKeyring(damagedDir, storageFor('windows-user-1')) })), /повреждён/));
  ok('нет сертификата', refusal(() => prepareDevRun(base('page-go', 'go', { certificate: '' })), /нет сертификата владельца/));
  ok('сертификат не читается', refusal(() => prepareDevRun(base('page-go', 'go', { certificate: 'мусор' })), /не читается/));
  ok('сертификат чужого ключа', refusal(() => prepareDevRun(base('page-go', 'go', { certificate: certificateEnvelope(root, hexOf(newKey()), 'dev-1') })), /другому ключу/));
  ok('сертификат другого человека', refusal(() => prepareDevRun(base('page-go', 'go', { certificate: certificateEnvelope(root, devHex, 'dev-2') })), /другому человеку/));
  ok('вошёл другой человек, чем в сертификате', refusal(() => prepareDevRun(base('page-go', 'go', { userId: 'dev-2' })), /другому человеку/));
  ok('пакет не собрался (больше 32 МБ)', refusal(() => prepareDevRun(base('page-go', 'go', { files: { ...pageFiles('go', 'page-go'), 'big.bin': new Uint8Array(crypto.randomBytes(33 * 1024 * 1024)) } })), /Пакет не собран: .*32 М/));
  const otherAccount = new DeveloperKeyring(keyDir, storageFor('windows-user-2'));
  ok('ключ другой учётной записи Windows', refusal(() => prepareDevRun(base('page-go', 'go', { keyring: otherAccount })), /не расшифровался/));
  ok('Flux не найден', refusal(() => findFluxDataDir({ env: { APPDATA: path.join(temp, 'none') }, platform: 'linux', home: path.join(temp, 'nohome') }), /Flux на этом компьютере не найден/));
  ok('папка данных Flux найдена по APPDATA', findFluxDataDir({ env: { APPDATA: path.join(temp, 'AppData') }, platform: 'linux', home: path.join(temp, 'nohome') }) === flux);

  console.log('Flux отказывает на подмене');
  const good = prepareDevRun(base('page-c', 'c'));
  const bad = (name: string, v: any, pattern: RegExp) => ok(name, !v.ok && pattern.test(v.why));
  bad('вошёл другой человек', verify(good, { userId: 'dev-2' }), /другим человеком|другой/);
  bad('никто не вошёл', verify(good, { userId: '' }), /войдите/i);
  bad('чужой корень владельца', verify(good, { rootHex: hexOf(newKey()) }), /сертификата владельца/);
  bad('ключ отозван', verify(good, { revoked: { keys: new Set([devHex]), releases: new Set() } }), /отозван/);
  bad('аренда протухла', verify(good, { now: NOW + DEV_LEASE_TTL_MS + 1 }), /Studio закрыта/);
  const swapped = prepareDevRun(base('page-c', 'c', { files: { ...pageFiles('c', 'page-c'), 'notes.txt': new TextEncoder().encode('другой') } }));
  bad('подменённый пакет при чужой подписи', verify({ ...good, bundle: swapped.bundle }), /не совпадает/);
  // Чужой ключ: пакет и аренда подписаны не тем ключом, что в сертификате
  const stranger = new DeveloperKeyring(path.join(temp, 'stranger'), storageFor('windows-user-1'));
  stranger.create();
  const forged = prepareDevRun({ ...base('page-c', 'c'), keyring: stranger, certificate: certificateEnvelope(root, stranger.info().publicKey, 'dev-1') });
  const forgedFile = JSON.parse(forged.runJson) as DevRunFile;
  bad('подпись чужого ключа с сертификатом владельца на другой', verify({ ...forged, runJson: JSON.stringify({ ...forgedFile, certificate }) }), /Подпись пакета разработки/);

  console.log('Продление аренды');
  const later = renewLease(keyring, good.claim, NOW + DEV_LEASE_RENEW_MS);
  ok('после продления запуск разрешён там, где старая аренда протухла', verify(good, { now: NOW + DEV_LEASE_TTL_MS + 1 }).ok === false
    && verify({ ...good, lease: later }, { now: NOW + DEV_LEASE_TTL_MS + 1 }).ok);
  ok('продление не меняет пакет и run.json', JSON.parse(good.runJson).run === JSON.parse(good.runJson).run && later !== good.lease);

  console.log('Папка обмена: запись');
  const dataDir = flux;
  const renames: string[] = [];
  const realRename = fs.renameSync;
  (fs as any).renameSync = (from: string, to: string) => { renames.push(path.basename(to)); return realRename(from, to); };
  const folder = new DevRunFolder(dataDir, 'page-c');
  try { folder.write(good); } finally { (fs as any).renameSync = realRename; }
  ok('порядок записи: package.bin и run.json раньше lease.txt', renames.indexOf(DEV_RUN_FILES.bundle) >= 0 && renames.indexOf(DEV_RUN_FILES.run) >= 0
    && renames.indexOf(DEV_RUN_FILES.lease) > renames.indexOf(DEV_RUN_FILES.bundle) && renames.indexOf(DEV_RUN_FILES.lease) > renames.indexOf(DEV_RUN_FILES.run));
  ok('временных файлов не осталось', !fs.readdirSync(folder.dir).some(n => n.endsWith('.tmp')));
  const read = () => ({ run: fs.readFileSync(path.join(folder.dir, 'run.json'), 'utf8'), lease: fs.readFileSync(path.join(folder.dir, 'lease.txt'), 'utf8'), bundle: new Uint8Array(fs.readFileSync(path.join(folder.dir, 'package.bin'))) });
  const onDisk = read();
  ok('с диска Flux читает то же, и оно проходит проверку', verify({ runJson: onDisk.run, lease: onDisk.lease, bundle: onDisk.bundle }).ok);
  folder.renew(later);
  ok('renew меняет только lease.txt', read().lease === later && read().run === onDisk.run && Buffer.compare(read().bundle, onDisk.bundle) === 0);
  // Пересборка заменяет пакет; в момент записи старой аренды нет
  const rebuilt = prepareDevRun(base('page-c', 'c', { files: { ...pageFiles('c', 'page-c'), 'notes.txt': new TextEncoder().encode('новая сборка') }, now: NOW + 5000 }));
  folder.write(rebuilt);
  ok('пересборка заменила пакет целиком', verify({ runJson: read().run, lease: read().lease, bundle: read().bundle }, { now: NOW + 6000 }).ok && JSON.parse(read().run).run !== JSON.parse(onDisk.run).run);
  const blocker = path.join(temp, 'blocked');
  fs.mkdirSync(blocker);
  fs.writeFileSync(path.join(blocker, 'dev-run'), 'файл на месте папки');
  ok('папку нельзя записать — понятный отказ', refusal(() => new DevRunFolder(blocker, 'page-c').write(good), /Не удалось записать пакет в папку Flux/));
  ok('некорректный идентификатор — отказ', refusal(() => new DevRunFolder(dataDir, '../evil'), /идентификатор/));

  console.log('Уборка');
  const neighbour = new DevRunFolder(dataDir, 'neighbour');
  fs.mkdirSync(neighbour.dir, { recursive: true });
  fs.writeFileSync(path.join(neighbour.dir, 'keep.txt'), 'чужое');
  folder.remove();
  ok('«Убрать» удаляет свою папку', !folder.exists());
  ok('чужая папка и config.json Flux целы', fs.existsSync(path.join(neighbour.dir, 'keep.txt')) && fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8') === '{"current_db_type":"LOCAL"}');
  ok('повторное «Убрать» не падает', (() => { folder.remove(); return true; })());
  // Осиротевшие: прежний запуск Studio (процесса уже нет), живой чужой экземпляр, папка без отметки
  const mk = (name: string, pid?: string) => {
    const dir = path.join(dataDir, 'dev-run', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'lease.txt'), 'x');
    if (pid !== undefined) fs.writeFileSync(path.join(dir, 'studio.pid'), pid);
    return dir;
  };
  const dead = mk('orphan', '111'), alive = mk('alive-other', '222'), unmarked = mk('unmarked');
  fs.mkdirSync(path.join(dataDir, 'dev-run', 'Bad Name'), { recursive: true });
  const removed = sweepOrphans(dataDir, (pid) => pid === 222);
  ok('осиротевшая папка убрана', removed.includes('orphan') && !fs.existsSync(dead));
  ok('папка живого чужого экземпляра Studio, без отметки и с недопустимым именем — на месте', fs.existsSync(alive) && fs.existsSync(unmarked) && fs.existsSync(path.join(dataDir, 'dev-run', 'Bad Name')) && !removed.includes('alive-other'));
  ok('нет папки dev-run — уборка молчит', sweepOrphans(path.join(temp, 'no-such')).length === 0);


  console.log('Главный процесс: аренда и уборка (DevRunHost)');
  {
    const hostDir = path.join(temp, 'host-flux');
    fs.mkdirSync(hostDir, { recursive: true });
    let clock = NOW;
    const host = new DevRunHost({ keyring, dataDir: () => hostDir, now: () => clock, renewMs: 40 });
    const input = { certificate, userId: 'dev-1', moduleId: 'page-rust', version: '0.1.0', files: pageFiles('rust', 'page-rust'), runtime: '' };
    const state = host.start(input);
    ok('состояние после запуска', state.running && state.moduleId === 'page-rust' && state.version === '0.1.0' && state.builtAt === NOW && state.problem === '');
    const leaseFile = path.join(hostDir, 'dev-run', 'page-rust', 'lease.txt');
    const first = fs.readFileSync(leaseFile, 'utf8');
    clock += 30_000;
    await new Promise(r => setTimeout(r, 200));
    const renewed = fs.readFileSync(leaseFile, 'utf8');
    ok('аренда продлевается по таймеру', renewed !== first);
    const folderNow = path.join(hostDir, 'dev-run', 'page-rust');
    const onDisk2 = { run: JSON.parse(fs.readFileSync(path.join(folderNow, 'run.json'), 'utf8')).run, bundle: new Uint8Array(fs.readFileSync(path.join(folderNow, 'package.bin'))) };
    const at = (now: number) => verifyDevRun({ ...onDisk2, lease: renewed, certificate, rootHex, revoked: noRevoked, now, userId: 'dev-1' }).ok;
    ok('продлённая аренда свежа спустя 30 с после первой и протухает через срок', at(clock + 1000) && !at(clock + DEV_LEASE_TTL_MS + 1));
    host.start({ ...input, moduleId: 'page-go', files: pageFiles('go', 'page-go') });
    ok('другая программа заменяет запуск: старая папка убрана, новая на месте', !fs.existsSync(folderNow) && fs.existsSync(path.join(hostDir, 'dev-run', 'page-go', 'lease.txt')));
    fs.rmSync(path.join(hostDir, 'dev-run', 'page-go'), { recursive: true, force: true });
    await new Promise(r => setTimeout(r, 150));
    ok('Flux убрал папку — продление сообщает о проблеме, а не падает', host.state().running && host.state().problem.length > 0);
    host.stop();
    ok('stop: состояние «не запущено», таймер остановлен, повторный stop безвреден', !host.state().running && (() => { host.stop(); return true; })());
    host.start(input);
    host.dispose();
    ok('dispose (выход из Studio) убирает папку', !fs.existsSync(folderNow));
    // Вылет Studio: папка осталась с отметкой мёртвого процесса — следующий старт её убирает
    host.start(input);
    fs.writeFileSync(path.join(folderNow, 'studio.pid'), '999999999');
    const next = new DevRunHost({ keyring, dataDir: () => hostDir });
    ok('при старте Studio осиротевшая папка прежнего запуска убирается', next.sweep().includes('page-rust') && !fs.existsSync(folderNow));
    host.stop();
  }

  console.log('Служба разработчика: действия devRunStart / devRunStop / devRunState');
  {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://x');
      res.setHeader('Content-Type', 'application/json');
      if (url.pathname === '/api/studio/certificate' && url.searchParams.get('key') === devHex && served.cert) res.end(JSON.stringify({ status: 'issued', name: 'Разработчик', certificate: served.cert }));
      else res.end(JSON.stringify({ status: 'none', name: '' }));
    });
    const served = { cert: certificate };
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    const origin = `http://127.0.0.1:${(server.address() as any).port}`;
    const fluxHome = path.join(temp, 'svc-flux');
    fs.mkdirSync(fluxHome, { recursive: true });
    fs.writeFileSync(path.join(fluxHome, 'config.json'), '{"current_db_type":"REMOTE"}');
    const state: { user: { id: string; name: string } | null; flux: boolean } = { user: { id: 'dev-1', name: 'Разработчик' }, flux: true };
    const service = new DeveloperService({
      dir: keyDir, storage: storageFor('windows-user-1'), version: '1.0.0',
      session: () => state.user ? { origin, token: 'token-dev-long-enough', user: state.user, owner: false } : null,
      assets: { templatesRoot, runtimeDir: path.join(app, 'runtime') },
      engine: createControlsEngine({ workerFile: path.join(app, 'controls-worker.cjs'), timeoutMs: 5000 }),
      home: path.join(temp, 'projects'),
      fluxDataDir: () => { if (!state.flux) throw new DevRunRefused('Flux на этом компьютере не найден: запустите Flux хотя бы раз, затем повторите.'); return fluxHome; },
    });
    const call = (action: string, args: Record<string, unknown> = {}): Promise<any> => service.handle(action as never, args);
    const fails = async (action: string, args: Record<string, unknown>, pattern: RegExp) => { try { await call(action, args); } catch (e: any) { return pattern.test(e.message); } return false; };
    ok('действия объявлены в списке окна', ['devRunStart', 'devRunStop', 'devRunState'].every(a => ALL_ACTIONS.includes(a)));
    await call('draftCreate', { template: 'python', id: 'svc-py', name: 'Питон', kind: 'page' });
    const folder = path.join(fluxHome, 'dev-run', 'svc-py');
    const started = await call('devRunStart', { id: 'svc-py' });
    ok('запуск: состояние и три файла в папке Flux', started.running && started.moduleId === 'svc-py' && ['run.json', 'lease.txt', 'package.bin'].every(n => fs.existsSync(path.join(folder, n))));
    const file = JSON.parse(fs.readFileSync(path.join(folder, 'run.json'), 'utf8')) as DevRunFile;
    const verdict = verifyDevRun({ run: file.run, lease: fs.readFileSync(path.join(folder, 'lease.txt'), 'utf8'), certificate: file.certificate, bundle: new Uint8Array(fs.readFileSync(path.join(folder, 'package.bin'))), rootHex, revoked: noRevoked, now: Date.now(), userId: 'dev-1' });
    ok(`Python проходит проверку Flux (${verdict.ok ? 'ok' : (verdict as any).why})`, verdict.ok);
    ok('состояние читается отдельно', (await call('devRunState')).running === true);
    await call('draftSave', { id: 'svc-py', path: 'README.md', content: 'правка' }).catch(() => {});
    const again = await call('devRunStart', { id: 'svc-py' });
    ok('повторный запуск (пересборка) заменяет пакет', again.running && again.builtAt >= started.builtAt);
    await call('projectUnwatch');
    ok('закрытие проекта убирает папку', !fs.existsSync(folder) && (await call('devRunState')).running === false);
    await call('devRunStart', { id: 'svc-py' });
    ok('«Убрать» убирает папку', (await call('devRunStop')).running === false && !fs.existsSync(folder));
    await call('devRunStart', { id: 'svc-py' });
    service.dispose();
    ok('выход из Studio (dispose) убирает папку', !fs.existsSync(folder));

    state.user = null;
    ok('не вошёл — отказ словами', await fails('devRunStart', { id: 'svc-py' }, /Войдите/));
    state.user = { id: 'dev-1', name: 'Разработчик' };
    state.flux = false;
    ok('Flux не найден — отказ словами', await fails('devRunStart', { id: 'svc-py' }, /Flux на этом компьютере не найден/));
    state.flux = true;
    served.cert = '';
    ok('сертификата нет — отказ словами', await fails('devRunStart', { id: 'svc-py' }, /нет сертификата владельца/));
    served.cert = certificate;
    state.user = { id: 'dev-2', name: 'Другой' };
    ok('вошёл другой человек — отказ словами', await fails('devRunStart', { id: 'svc-py' }, /другому человеку/));
    state.user = { id: 'dev-1', name: 'Разработчик' };
    ok('ничего не осталось в папке Flux после отказов', !fs.existsSync(folder));
    ok('config.json Flux не тронут', fs.readFileSync(path.join(fluxHome, 'config.json'), 'utf8') === '{"current_db_type":"REMOTE"}');
    server.close();
  }

  fs.rmSync(temp, { recursive: true, force: true });
  console.log(`\nПройдено проверок: ${passed}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error('✗', e?.stack || e); process.exit(1); });
