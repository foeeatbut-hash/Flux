/**
 * «Запустить во Flux» из Studio, ядро доверия: verifyDevRun и leaseProblem (modules/trust/devRun.ts).
 * Пакет разработки запускается, только когда сходится ВСЁ: сертификат владельца, вошедший человек, подписи ключом
 * разработчика, свежая аренда, байты пакета и манифест. Каждая строка ниже — отдельный способ обмана, и каждый должен
 * быть отклонён по своей причине (а не по первой попавшейся).
 *
 * Запуск: npx tsx scripts/test-modules-dev-run.ts
 */
import assert from 'node:assert/strict';
import { DEV_LEASE_TTL_MS, leaseProblem, verifyDevRun } from '../modules/trust/devRun';
import { describeBundle, readRevocations } from '../modules/trust/verify';
import { packBundle, unpackBundle } from '../modules/trust/bundle';
import { parseDevRunClaim } from '../modules/trust/claims';
import { peekEnvelope, sealEnvelope } from '../modules/trust/envelope';
import { certificateEnvelope, devLeaseEnvelope, devRunEnvelope, hexOf, moduleBundle, newKey, releaseEnvelope, requestEnvelope, revocationEnvelope } from './fixtures/moduleTrust';

let passed = 0;
const ok = (name: string, value: unknown) => { assert.ok(value, name); passed++; };
const root = newKey(), rootHex = hexOf(root), dev = newKey(), devHex = hexOf(dev), other = newKey(), otherHex = hexOf(other);
const none = { releases: new Set<string>(), keys: new Set<string>() };
const now = Date.now();
const bundle = moduleBundle('1.0.0');
const certificate = certificateEnvelope(root, devHex, 'dev-user');
const run = devRunEnvelope(dev, bundle, { version: '1.0.0', userId: 'dev-user', iat: now });
const lease = devLeaseEnvelope(dev, bundle, { iat: now });
const base = { run, lease, certificate, bundle, rootHex, revoked: none, now, userId: 'dev-user' };
/** Отказ с причиной, в которой есть этот текст: «не прошло» без причины не годится */
const refused = (name: string, patch: Partial<Parameters<typeof verifyDevRun>[0]>, why: RegExp) => {
  const r = verifyDevRun({ ...base, ...patch });
  ok(`${name}: ${r.ok ? 'ПРОШЛО' : r.why}`, !r.ok && why.test(r.why));
};
/** Пакет с другим содержимым, подписанный по всем правилам: проверяются только манифест и формат */
const signed = (b: Uint8Array) => ({ run: devRunEnvelope(dev, b, { version: '1.0.0', userId: 'dev-user', iat: now }), lease: devLeaseEnvelope(dev, b, { iat: now }), bundle: b });

console.log('Годный пакет');
{
  const r = verifyDevRun(base);
  ok('годный пакет проходит', r.ok);
  if (r.ok) {
    ok('запись выпуска собрана из пакета разработки, а не из подписи владельца', r.claim.request === 'dev-run' && r.claim.channel === 'test' && r.claim.author === devHex && r.signature === run);
    ok('разработчик назван по сертификату', r.developer === 'Разработчик' && r.dev.userId === 'dev-user' && r.manifest.id === 'equipment-inspector');
  }
  ok('ОС проверяется, если указана', verifyDevRun({ ...base, hostPlatform: 'linux' }).ok);
}

console.log('Кто и чей ключ');
{
  refused('другой вошедший человек', { userId: 'someone-else' }, /другим человеком/);
  refused('никто не вошёл', { userId: '' }, /войдите/i);
  refused('нет ключа владельца в сборке', { rootHex: '' }, /нет ключа владельца/);
  refused('сертификат подписан не владельцем', { certificate: certificateEnvelope(other, devHex, 'dev-user') }, /нет сертификата владельца/);
  refused('сертификат на чужой ключ: подпись пакета не сходится', { certificate: certificateEnvelope(root, otherHex, 'dev-user') }, /Подпись пакета разработки не сходится/);
  refused('сертификат выдан другому человеку', { certificate: certificateEnvelope(root, devHex, 'dev-other') }, /другим человеком/);
  refused('сертификат пуст', { certificate: '' }, /нет сертификата/);
  refused('ключ разработчика отозван', { revoked: readRevocations([revocationEnvelope(root, 'key', devHex)], rootHex) }, /отозван/);
  const forged = readRevocations([revocationEnvelope(other, 'key', devHex)], rootHex);
  ok('отзыв не от владельца ничего не отзывает', verifyDevRun({ ...base, revoked: forged }).ok);
  // userId в самой записи пакета другой, хотя сертификат — вошедшего: сертификат нельзя использовать, чтобы «перенаправить» чужой пакет
  refused('в пакете другой userId, в сертификате — вошедший', { run: devRunEnvelope(dev, bundle, { version: '1.0.0', userId: 'dev-other', iat: now }) }, /другим человеком/);
  // Запись говорит «автор — разработчик», но подпись чужая: сверка автора это не поймает, ловит только проверка подписи
  const claimOf = (kind: 'devRun' | 'devLease', text: string) => peekEnvelope(kind, text) as any;
  refused('пакет с подделанной подписью (автор — разработчик, ключ чужой)', { run: sealEnvelope('devRun', claimOf('devRun', run), other) }, /Подпись пакета разработки не сходится/);
  refused('аренда с подделанной подписью (автор — разработчик, ключ чужой)', { lease: sealEnvelope('devLease', claimOf('devLease', lease), other) }, /Аренда пакета разработки не подтверждена/);
  refused('сертификат с подделанной подписью (подпись не владельца)', { certificate: sealEnvelope('certificate', peekEnvelope('certificate', certificate), other) }, /нет сертификата владельца/);
  refused('пакет подписан другим ключом', { run: devRunEnvelope(other, bundle, { version: '1.0.0', userId: 'dev-user', iat: now }) }, /Подпись пакета разработки не сходится/);
  refused('в записи пакета чужой автор при подписи разработчика', { run: devRunEnvelope(dev, bundle, { version: '1.0.0', userId: 'dev-user', author: otherHex, iat: now }) }, /Подпись пакета разработки не сходится/);
}

console.log('Конверт не того вида');
{
  const release = releaseEnvelope(dev, bundle, { version: '1.0.0', author: devHex });
  const request = requestEnvelope(dev, bundle, { version: '1.0.0' });
  refused('конверт выпуска вместо пакета разработки', { run: release }, /Подпись пакета разработки не сходится/);
  refused('конверт запроса вместо пакета разработки', { run: request }, /Подпись пакета разработки не сходится/);
  refused('конверт аренды вместо пакета', { run: lease }, /Подпись пакета разработки не сходится/);
  refused('конверт выпуска вместо аренды', { lease: release }, /Аренда пакета разработки не подтверждена/);
  refused('пакет разработки вместо аренды', { lease: run }, /Аренда пакета разработки не подтверждена/);
  refused('пустая аренда', { lease: '' }, /Аренда пакета разработки не подтверждена/);
  ok('пакет разработки читается только строгим разбором', parseDevRunClaim({ ...(peekEnvelope('devRun', run) as any), extra: 1 }) === null);
}

console.log('Аренда');
{
  refused('аренда подписана другим ключом', { lease: devLeaseEnvelope(other, bundle, { iat: now }) }, /Аренда пакета разработки не подтверждена/);
  refused('аренда с чужим автором при подписи разработчика', { lease: devLeaseEnvelope(dev, bundle, { author: otherHex, iat: now }) }, /Аренда пакета разработки не подтверждена/);
  refused('аренда от другого пакета', { lease: devLeaseEnvelope(dev, moduleBundle('1.0.0', { 'logic/main.ts': 'other()' }), { iat: now }) }, /Аренда пакета разработки не подтверждена/);
  refused('аренда старше срока', { lease: devLeaseEnvelope(dev, bundle, { iat: now - DEV_LEASE_TTL_MS - 1000 }) }, /Studio закрыта/);
  ok('аренда на границе срока ещё действует', verifyDevRun({ ...base, lease: devLeaseEnvelope(dev, bundle, { iat: now - DEV_LEASE_TTL_MS + 1000 }) }).ok);
  refused('аренда из будущего', { lease: devLeaseEnvelope(dev, bundle, { iat: now + 10 * 60_000 }) }, /Аренда пакета разработки не подтверждена/);
  ok('небольшой уход часов допускается', verifyDevRun({ ...base, lease: devLeaseEnvelope(dev, bundle, { iat: now + 20_000 }) }).ok);
  refused('время ушло вперёд: аренда состарилась без продления', { now: now + DEV_LEASE_TTL_MS + 5000 }, /Studio закрыта/);
  // Отдельная проверка аренды (главный процесс перечитывает её чаще пакета)
  const claim = parseDevRunClaim(peekEnvelope('devRun', run))!;
  ok('leaseProblem: свежая аренда — без замечаний', leaseProblem({ lease, run: claim, now }) === '');
  ok('leaseProblem: старая аренда', /Studio закрыта/.test(leaseProblem({ lease, run: claim, now: now + DEV_LEASE_TTL_MS + 1 })));
  ok('leaseProblem: чужой ключ', leaseProblem({ lease: devLeaseEnvelope(other, bundle, { iat: now }), run: claim, now }) !== '');
  ok('leaseProblem: чужой пакет', leaseProblem({ lease: devLeaseEnvelope(dev, bundle, { iat: now, sha256: 'a'.repeat(64) }), run: claim, now }) !== '');
  ok('leaseProblem: из будущего', leaseProblem({ lease: devLeaseEnvelope(dev, bundle, { iat: now + 3_600_000 }), run: claim, now }) !== '');
}

console.log('Пакет и манифест');
{
  const tampered = new Uint8Array(bundle); tampered[tampered.length - 5] ^= 1;
  refused('подменён байт пакета', { bundle: tampered }, /не совпадает с подписанным/);
  refused('пакет короче', { bundle: bundle.slice(0, bundle.length - 1) }, /не совпадает с подписанным/);
  refused('манифест другой версии', signed(moduleBundle('1.0.0', {}, { version: '1.0.1' })), /другой модуль или версию/);
  refused('манифест другого id', signed(moduleBundle('1.0.0', {}, { id: 'another-program' })), /другой модуль или версию/);
  refused('манифест не читается', signed(moduleBundle('1.0.0', { 'manifest.json': '{ не json' })), /manifest\.json/);
  // Подписано по всем правилам, но содержимое то же, что принял бы выпуск: те же проверки формата и исполнения
  const garbage = new Uint8Array([1, 2, 3]);
  refused('подписанный мусор вместо пакета', signed(garbage), /./);
  const files = unpackBundle(bundle); delete files['build/runtime.js'];
  refused('у формы нет runtime.js', signed(packBundle(files)), /runtime\.js/);
  refused('Python без logic/main.py', signed(moduleBundle('1.0.0', {}, { language: 'python', logic: 'logic/main.py' })), /logic\/main\.py/);
  // Размер в подписи не тот, а хэш верный: сверяются оба
  const claimSize = { ...(peekEnvelope('devRun', run) as any), size: describeBundle(bundle).size + 1 };
  refused('размер в подписи не тот', { run: sealEnvelope('devRun', claimSize, dev) }, /не совпадает с подписанным/);
  const winOnly = signed(moduleBundle('1.0.0', {}, { platform: 'windows' }));
  const onWindows = verifyDevRun({ ...base, ...winOnly, hostPlatform: 'win32' });
  const onLinux = verifyDevRun({ ...base, ...winOnly, hostPlatform: 'linux' });
  ok('программа только для Windows: на Linux отказ именно по системе, на Windows — не по ней',
    !onLinux.ok && /только для Windows/.test(onLinux.why) && !(!onWindows.ok && /только для Windows/.test(onWindows.why)));
}

console.log(`\nВСЕ ТЕСТЫ ПРОЙДЕНЫ (${passed})`);
