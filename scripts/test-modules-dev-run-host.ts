/**
 * «Запустить во Flux», главный процесс без Electron: чтение папки обмена, проверка, память, согласие, срок аренды,
 * «Убрать» и разделение решений о подключениях (electron/moduleDevRuns.ts, electron/moduleGrants.ts).
 * Сквозной путь через настоящий протокол и окно — test-modules-dev-run-native.ts.
 *
 * Запуск: npx tsx scripts/test-modules-dev-run-host.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ModuleDevRuns } from '../electron/moduleDevRuns';
import { ModuleGrants } from '../electron/moduleGrants';
import { DEV_LEASE_TTL_MS, DEV_RUN_FILES } from '../modules/trust/devRun';
import { unpackBundle } from '../modules/trust/bundle';
import { MODULE_BUNDLE_MAX } from '../modules/trust/claims';
import { ENVELOPE_MAX } from '../modules/trust/envelope';
import { permissionsDigest } from '../modules/permissions/registry';
import { readRevocations } from '../modules/trust/verify';
import { certificateEnvelope, devLeaseEnvelope, devRunEnvelope, hexOf, moduleBundle, newKey, revocationEnvelope } from './fixtures/moduleTrust';

let passed = 0;
const ok = (name: string, value: unknown) => { assert.ok(value, name); passed++; };
const root = newKey(), rootHex = hexOf(root), dev = newKey(), devHex = hexOf(dev), other = newKey();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-dev-run-host-'));
const exchange = path.join(temp, 'dev-run');
let clock = Date.now();
let user = 'dev-user';
let revoked: Set<string> = new Set();
let changes = 0;
const runs = new ModuleDevRuns({
  dir: exchange, rootHex: () => rootHex, revoked: async () => ({ releases: new Set(), keys: revoked }), userId: () => user,
  reserved: ['builtin-example'], changed: () => { changes++; }, now: () => clock, platform: 'linux',
});

const ID = 'equipment-inspector';
/** Кладёт папку обмена так, как это делает Studio */
function place(moduleId: string, p: { bundle?: Uint8Array; userId?: string; certUser?: string; key?: ReturnType<typeof newKey>; leaseAt?: number; version?: string; lease?: boolean } = {}) {
  const bundle = p.bundle ?? moduleBundle(p.version ?? '1.0.0');
  const key = p.key ?? dev;
  const dir = path.join(exchange, moduleId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, DEV_RUN_FILES.bundle), bundle);
  fs.writeFileSync(path.join(dir, DEV_RUN_FILES.run), JSON.stringify({
    v: 1, certificate: certificateEnvelope(root, hexOf(key), p.certUser ?? 'dev-user'),
    run: devRunEnvelope(key, bundle, { moduleId, version: p.version ?? '1.0.0', userId: p.userId ?? 'dev-user', iat: clock }),
  }));
  if (p.lease !== false) fs.writeFileSync(path.join(dir, DEV_RUN_FILES.lease), devLeaseEnvelope(key, bundle, { iat: p.leaseAt ?? clock }));
  return dir;
}
const moduleManifestOf = () => JSON.parse(Buffer.from(unpackBundle(moduleBundle('1.0.0'))['manifest.json']).toString('utf8'));
const item = (id = ID) => runs.list().find(i => i.moduleId === id);
const settle = async () => { clock += 2000; await runs.scan(); };

async function main() {
console.log('Чтение папки обмена');
{
  await runs.scan();
  ok('папки обмена нет — список пуст', runs.list().length === 0 && runs.active().size === 0);
  place(ID);
  await runs.scan();
  const it = item()!;
  ok('годный пакет виден и проверен', it.live && it.version === '1.0.0' && it.developer === 'Разработчик' && it.why === '' && !!it.manifest && it.sha256.length === 64);
  ok('без согласия не запускается', !it.accepted && runs.active().size === 0 && !runs.isActive(ID));
  ok('о появлении сообщено', changes > 0);
}

console.log('Согласие на разрешения');
{
  const it = item()!, manifest = it.manifest!, digest = permissionsDigest(manifest);
  const before = changes;
  ok('чужой отпечаток разрешений не принимается', !runs.accept(ID, it.sha256, 'другой').ok && runs.active().size === 0);
  ok('чужой хеш сборки не принимается', !runs.accept(ID, 'a'.repeat(64), digest).ok);
  ok('несуществующая программа не принимается', !runs.accept('no-such', it.sha256, digest).ok);
  ok('верное согласие принято', runs.accept(ID, it.sha256, digest).ok && runs.isActive(ID) && item()!.accepted);
  ok('принятое отдаётся как запускаемое: проверенный пакет, не выпуск', runs.active().get(ID)!.claim.request === 'dev-run' && changes > before);
  // Опрос без изменений ничего не меняет и не шумит
  const quiet = changes; await settle();
  ok('продление аренды без изменений не шумит', changes === quiet && runs.isActive(ID));
}

console.log('Срок аренды');
{
  const e = path.join(exchange, ID, DEV_RUN_FILES.lease);
  // Studio закрыта: аренда не продлевается, время идёт
  const quiet = changes;
  clock += DEV_LEASE_TTL_MS + 1000; await runs.scan();
  ok('просроченное убрано из запускаемых, окно извещено', !runs.isActive(ID) && !item()!.live && /Studio закрыта/.test(item()!.why) && changes > quiet);
  ok('у просроченного нет манифеста для окна', item()!.manifest === null);
  ok('на просроченное согласие не принимается', !runs.accept(ID, item()!.sha256, 'x').ok && !runs.accept(ID, item()!.sha256, permissionsDigest(moduleManifestOf())).ok);
  // Studio вернулась и продлила: тот же пакет оживает, согласие на эту сборку сохраняется (в памяти)
  const bundle = fs.readFileSync(path.join(exchange, ID, DEV_RUN_FILES.bundle));
  fs.writeFileSync(e, devLeaseEnvelope(dev, new Uint8Array(bundle), { iat: clock }));
  await runs.scan();
  ok('продлённая аренда возвращает запуск той же сборки', runs.isActive(ID));
  // Аренда пропала (Studio стирает её первой при «Убрать»)
  fs.rmSync(e);
  await runs.scan();
  ok('нет lease.txt — не запускается', !runs.isActive(ID) && /Аренда пакета разработки не подтверждена/.test(item()!.why));
  fs.writeFileSync(e, devLeaseEnvelope(dev, new Uint8Array(bundle), { iat: clock }));
  await runs.scan();
  ok('аренда вернулась', runs.isActive(ID));
  // Аренда не от этого пакета
  fs.writeFileSync(e, devLeaseEnvelope(dev, moduleBundle('1.0.0', { 'logic/main.ts': 'x()' }), { iat: clock }));
  await runs.scan();
  ok('чужая аренда не оживляет пакет', !runs.isActive(ID));
  fs.writeFileSync(e, devLeaseEnvelope(dev, new Uint8Array(bundle), { iat: clock }));
  await runs.scan();
}

console.log('Человек');
{
  user = 'someone-else';
  await runs.scan();
  ok('у другого вошедшего не запускается и не показывается', !runs.isActive(ID) && !item());
  user = '';
  await runs.scan();
  ok('без входа не запускается', !runs.isActive(ID));
  user = 'dev-user';
  await runs.scan();
  ok('вернулся свой человек — согласие на эту сборку в памяти действует', runs.isActive(ID));
  // Сертификат выдан другому: чужой пакет у этого человека виден лишь как отказ тому, чей он, и не запускается
  place('other-owner', { certUser: 'someone-else', userId: 'someone-else' });
  await runs.scan();
  ok('пакет другого разработчика не показывается и не запускается', !item('other-owner') && !runs.active().has('other-owner'));
  place('mixed-owner', { certUser: 'dev-user', userId: 'someone-else' });
  await runs.scan();
  ok('сертификат свой, а пакет собран другим — отказ с причиной', !item('mixed-owner')!.live && /другим человеком/.test(item('mixed-owner')!.why));
}

console.log('Что не читается');
{
  fs.mkdirSync(path.join(exchange, 'Bad_Name'), { recursive: true });
  fs.mkdirSync(path.join(exchange, '..sneaky'), { recursive: true });
  await runs.scan();
  ok('папки с неподходящим именем не читаются', !item('Bad_Name') && !item('..sneaky'));
  place('windows-only', { bundle: moduleBundle('1.0.0', {}, { id: 'windows-only', platform: 'windows' }) });
  await runs.scan();
  ok('только для Windows на другой системе не запускается', !item('windows-only')!.live && /только для Windows/.test(item('windows-only')!.why));
  place('builtin-example');
  await runs.scan();
  ok('встроенное имя занято и не подменяется', !item('builtin-example')!.live && /встроенным примером/.test(item('builtin-example')!.why) && !runs.active().has('builtin-example'));
  // Пакет лежит в папке с чужим именем
  const wrong = place(ID, {}); fs.cpSync(wrong, path.join(exchange, 'renamed-program'), { recursive: true });
  await runs.scan();
  ok('папка названа не по программе пакета', !item('renamed-program')!.live && /названа не по программе/.test(item('renamed-program')!.why));
  // Слишком большие файлы не читаются целиком
  const huge = path.join(exchange, 'huge-run'); fs.mkdirSync(huge, { recursive: true });
  fs.writeFileSync(path.join(huge, DEV_RUN_FILES.run), Buffer.alloc(ENVELOPE_MAX * 3));
  await runs.scan();
  ok('слишком большой run.json отклонён', !item('huge-run')!.live);
  const bigPkg = path.join(exchange, 'big-package'); fs.mkdirSync(bigPkg, { recursive: true });
  const real = path.join(exchange, ID);
  fs.copyFileSync(path.join(real, DEV_RUN_FILES.run), path.join(bigPkg, DEV_RUN_FILES.run));
  fs.copyFileSync(path.join(real, DEV_RUN_FILES.lease), path.join(bigPkg, DEV_RUN_FILES.lease));
  const fd = fs.openSync(path.join(bigPkg, DEV_RUN_FILES.bundle), 'w'); fs.ftruncateSync(fd, MODULE_BUNDLE_MAX + 1); fs.closeSync(fd);
  await runs.scan();
  ok('пакет больше предела отклонён без чтения', !item('big-package')!.live && /package\.bin/.test(item('big-package')!.why));
  // Символические ссылки
  if (process.platform !== 'win32') {
    const linked = path.join(exchange, 'linked-file'); fs.mkdirSync(linked, { recursive: true });
    fs.symlinkSync(path.join(real, DEV_RUN_FILES.run), path.join(linked, DEV_RUN_FILES.run));
    fs.symlinkSync(path.join(real, DEV_RUN_FILES.lease), path.join(linked, DEV_RUN_FILES.lease));
    fs.symlinkSync(path.join(real, DEV_RUN_FILES.bundle), path.join(linked, DEV_RUN_FILES.bundle));
    await runs.scan();
    ok('файлы-ссылки не читаются, даже если по ссылке настоящий пакет', !item('linked-file')!.live && !runs.active().has('linked-file'));
    fs.symlinkSync(real, path.join(exchange, 'linked-dir'), 'dir');
    await runs.scan();
    ok('папка-ссылка не читается', !item('linked-dir') || !item('linked-dir')!.live);
    // Папка обмена сама оказалась ссылкой на настоящую папку с годным пакетом
    place('sym-prog', { bundle: moduleBundle('1.0.0', {}, { id: 'sym-prog' }) }); await runs.scan(); ok('такой же пакет в обычной папке запускается', item('sym-prog')!.live); fs.renameSync(path.join(exchange, 'sym-prog'), path.join(temp, 'moved-prog')); fs.symlinkSync(path.join(temp, 'moved-prog'), path.join(exchange, 'sym-prog'), 'dir');
    await runs.scan();
    ok('папка-ссылка на годный пакет не запускается', !item('sym-prog') || !item('sym-prog')!.live);
    const outside = path.join(temp, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'keep.txt'), 'x');
    fs.symlinkSync(outside, path.join(exchange, 'to-outside'), 'dir');
    const removal = await runs.remove('to-outside');
    ok('«Убрать» по ссылке не трогает то, на что она указывает', fs.existsSync(path.join(outside, 'keep.txt')) && removal.ok);
  }
  ok('мусорные имена не попали в список вообще', runs.list().every(i => /^[a-z][a-z0-9-]*$/.test(i.moduleId)));
}

console.log('Новая сборка и отзыв');
{
  const it = item()!;
  // Studio собрала новую версию: другой хеш, согласие на неё нужно заново
  place(ID, { version: '1.0.1', bundle: moduleBundle('1.0.1', { 'logic/main.ts': 'export default {}' }) });
  await settle();
  const next = item()!;
  ok('новая сборка проверена, но согласия на неё нет', next.live && next.version === '1.0.1' && next.sha256 !== it.sha256 && !next.accepted && !runs.isActive(ID));
  ok('старое согласие на новую сборку не переносится', !runs.accept(ID, it.sha256, permissionsDigest(next.manifest!)).ok);
  ok('согласие на новую сборку принято', runs.accept(ID, next.sha256, permissionsDigest(next.manifest!)).ok && runs.isActive(ID));
  // Подменили байты пакета при прежнем run.json
  const pkg = path.join(exchange, ID, DEV_RUN_FILES.bundle);
  const bytes = Buffer.from(fs.readFileSync(pkg)); bytes[bytes.length - 3] ^= 1;
  fs.writeFileSync(pkg, bytes);
  await settle();
  ok('подменённый пакет не запускается', !runs.isActive(ID) && /не совпадает с подписанным/.test(item()!.why));
  place(ID, { version: '1.0.1', bundle: moduleBundle('1.0.1', { 'logic/main.ts': 'export default {}' }) });
  await settle();
  ok('восстановленный пакет проверен заново, согласие в памяти сохранилось', runs.isActive(ID));
  // Отозванный ключ разработчика
  revoked = new Set([devHex]);
  await settle();
  ok('отозванный ключ останавливает запуск без нового пакета', !runs.isActive(ID) && /отозван/.test(item()!.why));
  revoked = new Set();
  await settle();
  ok('отзыв снят — запуск вернулся', runs.isActive(ID));
  // Пакет, подписанный не тем ключом, что в сертификате
  place(ID, { key: dev, version: '1.0.1', bundle: moduleBundle('1.0.1', { 'logic/main.ts': 'export default {}' }) });
  const run = JSON.parse(fs.readFileSync(path.join(exchange, ID, DEV_RUN_FILES.run), 'utf8'));
  run.certificate = certificateEnvelope(other, devHex, 'dev-user');
  fs.writeFileSync(path.join(exchange, ID, DEV_RUN_FILES.run), JSON.stringify(run));
  await settle();
  ok('сертификат не от владельца — не запускается', !runs.isActive(ID) && /нет сертификата владельца/.test(item()!.why));
  ok('отзыв, подписанный не владельцем, не читается как отзыв', readRevocations([revocationEnvelope(other, 'key', devHex)], rootHex).keys.size === 0);
}

console.log('«Убрать»');
{
  place(ID, { version: '1.0.1', bundle: moduleBundle('1.0.1', { 'logic/main.ts': 'export default {}' }) });
  await settle();
  runs.accept(ID, item()!.sha256, permissionsDigest(item()!.manifest!));
  ok('перед удалением программа запущена', runs.isActive(ID));
  const result = await runs.remove(ID);
  ok('убрана из памяти и с диска', result.ok && !runs.isActive(ID) && !item() && !fs.existsSync(path.join(exchange, ID)));
  await settle();
  ok('после опроса не вернулась', !item());
  place(ID, { version: '1.0.1', bundle: moduleBundle('1.0.1', { 'logic/main.ts': 'export default {}' }) });
  await settle();
  ok('та же сборка, положенная заново, снова просит согласия: удаление забыло его', item()!.live && !item()!.accepted);
  ok('неверное имя в «Убрать» отклонено', !(await runs.remove('../etc')).ok);
  // Studio убрала папку сама
  fs.rmSync(path.join(exchange, ID), { recursive: true, force: true });
  await settle();
  ok('папка исчезла — запись исчезла', !item());
}

console.log('Решения о подключениях не смешиваются с выпуском');
{
  const grants = new ModuleGrants(path.join(temp, 'grants.json'));
  await grants.load();
  let devActive = false;
  grants.setDevScope(id => devActive && id === 'calc');
  const spec = 'https://api.example.com GET';
  await grants.decide('u1', 'calc', 'api', spec, 's1', 'always');
  ok('решение выпуска записано', grants.state('u1', 'calc', 'api', spec, 's1') === 'allowed');
  devActive = true;
  ok('пакет разработки того же имени этого решения не наследует', grants.state('u1', 'calc', 'api', spec, 's1') === 'ask');
  await grants.decide('u1', 'calc', 'api', spec, 's1', 'always');
  ok('своё решение у разработки есть', grants.state('u1', 'calc', 'api', spec, 's1') === 'allowed');
  await grants.decide('u1', 'calc', 'api', spec, 's1', 'never');
  devActive = false;
  ok('запрет в разработке выпуск не затрагивает', grants.state('u1', 'calc', 'api', spec, 's1') === 'allowed');
  devActive = true;
  ok('и наоборот: разработка помнит свой запрет', grants.state('u1', 'calc', 'api', spec, 's1') === 'denied');
  ok('в списке решений человека только выпуск', grants.list('u1').length === 1 && grants.list('u1')[0].decision === 'always');
  const saved = JSON.parse(fs.readFileSync(path.join(temp, 'grants.json'), 'utf8'));
  ok('решения разработки в файл не пишутся', Object.keys(saved.rows).every((k: string) => !k.startsWith('dev:')) && Object.keys(saved.rows).length === 1);
  // Подложенная в файл строка «разработки» не читается
  fs.writeFileSync(path.join(temp, 'forged.json'), JSON.stringify({ rows: { 'dev:u1|calc|api': { decision: 'always', spec, at: 1 } } }));
  const forged = new ModuleGrants(path.join(temp, 'forged.json')); await forged.load(); forged.setDevScope(() => true);
  ok('подложенное в файле решение разработки не действует', forged.state('u1', 'calc', 'api', spec, 's1') === 'ask');
  grants.dropDevExcept(new Set());
  ok('когда пакет остановлен, его решения забыты', grants.state('u1', 'calc', 'api', spec, 's1') === 'ask');
  await grants.decide('u1', 'calc', 'api', spec, 's1', 'always');
  await grants.resetAll('u1', 'calc');
  ok('сброс решений человека сбрасывает и разработку', grants.state('u1', 'calc', 'api', spec, 's1') === 'ask');
  devActive = false;
  ok('и выпуск', grants.state('u1', 'calc', 'api', spec, 's1') === 'ask');
}

runs.stop();
fs.rmSync(temp, { recursive: true, force: true });
console.log(`\nВСЕ ТЕСТЫ ПРОЙДЕНЫ (${passed})`);
}
main().catch(e => { console.error(e); process.exit(1); });
