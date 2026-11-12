/**
 * Цепочка доверия модулей без базы: подписи, пакет, проверка выпуска и
 * запроса, разница. Сквозной путь через сервер и таблицы —
 * test-modules-publishing.ts.
 *
 * Запуск: npx tsx scripts/test-modules-trust.ts
 */
import assert from 'node:assert/strict';
import { canonicalJson, openEnvelope, peekEnvelope, sealEnvelope } from '../modules/trust/envelope';
import { joinChunks, packBundle, splitChunks, unpackBundle, validBundlePath } from '../modules/trust/bundle';
import { MODULE_CHUNK_BYTES, parseReleaseClaim, releaseKey } from '../modules/trust/claims';
import { readCertificates, readRevocations, verifyRelease, verifyRequest } from '../modules/trust/verify';
import { diffFiles, diffLines, diffPermissions, manifestOf } from '../modules/trust/diff';
import { buildCertificateClaim, buildOwnerRequestClaim, buildReleaseClaim, buildRevocationClaim } from '../modules/trust/owner';
import {
  certificateEnvelope, hexOf, moduleBundle, newKey, releaseEnvelope, requestEnvelope, revocationEnvelope,
} from './fixtures/moduleTrust';

let passed = 0;
const ok = (name: string, value: unknown) => { assert.ok(value, name); passed++; };
const root = newKey(), rootHex = hexOf(root), dev = newKey(), devHex = hexOf(dev), stranger = newKey();
const none = { releases: new Set<string>(), keys: new Set<string>() };
const now = Date.now();

console.log('Подписанные записи');
{
  ok('ключи упорядочены, undefined пропущен', canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: undefined } }) === '{"a":{"d":[1,{"x":1,"y":2}]},"b":1}');
  const text = sealEnvelope('revocation', { v: 1, kind: 'key', target: devHex, reason: '', iat: 1 }, root);
  ok('своя подпись открывается', !!openEnvelope('revocation', text, rootHex));
  ok('чужой ключ не открывает', openEnvelope('revocation', text, devHex) === null);
  ok('префикс другого вида не принимается', openEnvelope('release', text.replace('FLUXMODREV1', 'FLUXMOD1'), rootHex) === null);
  const [p, body, sig] = text.split('.');
  const forged = Buffer.from(JSON.stringify({ v: 1, kind: 'key', target: '0'.repeat(64), reason: '', iat: 1 })).toString('base64url');
  ok('подмена содержимого ломает подпись', openEnvelope('revocation', `${p}.${forged}.${sig}`, rootHex) === null);
  ok('peek читает без проверки', (peekEnvelope('revocation', text) as any)?.target === devHex);
  ok('некорректный base64 отклонён', openEnvelope('revocation', `${p}.${body}=.${sig}`, rootHex) === null);
}

console.log('Пакет');
{
  const bundle = moduleBundle('1.0.0');
  const files = unpackBundle(bundle);
  ok('пакет разбирается обратно', Object.keys(files).includes('build/runtime.js') && Object.keys(files).includes('logic/main.ts'));
  ok('пакет канонический', Buffer.from(packBundle(files)).equals(Buffer.from(bundle)));
  ok('путь с .. запрещён', !validBundlePath('../evil.js') && !validBundlePath('a/../b') && !validBundlePath('/abs') && !validBundlePath('a\\b'));
  assert.throws(() => packBundle({ '../x': 'y' })); passed++;
  const reordered = Buffer.from(JSON.stringify({ v: 1, files: { 'b.txt': btoa('1'), 'a.txt': btoa('2') } }));
  assert.throws(() => unpackBundle(reordered), /каноническом/); passed++;
  const big = new Uint8Array(MODULE_CHUNK_BYTES * 2 + 5);
  ok('куски по 256 КиБ', splitChunks(big).map((c) => c.length).join() === `${MODULE_CHUNK_BYTES},${MODULE_CHUNK_BYTES},5`);
  ok('куски собираются обратно', joinChunks(splitChunks(big)).length === big.length);
}

console.log('Выпуск: запускается только подписанное владельцем');
{
  const bundle = moduleBundle('1.0.0');
  const chunks = splitChunks(bundle);
  const signature = releaseEnvelope(root, bundle, { version: '1.0.0', author: devHex });
  const good = verifyRelease({ signature, chunks, rootHex, revoked: none, now, moduleId: 'equipment-inspector', version: '1.0.0' });
  ok('подписанный владельцем выпуск проходит', good.ok && good.manifest.version === '1.0.0');
  const unsigned = verifyRelease({ signature: '', chunks, rootHex, revoked: none, now });
  ok('без подписи — нет', !unsigned.ok && /нет подписи/.test(unsigned.why));
  const devOnly = verifyRelease({ signature: releaseEnvelope(dev, bundle, { version: '1.0.0', author: devHex }), chunks, rootHex, revoked: none, now });
  ok('подписанный только разработчиком — нет', !devOnly.ok && /не владельцем/.test(devOnly.why));
  ok('без ключа в сборке — нет', !verifyRelease({ signature, chunks, rootHex: '', revoked: none, now }).ok);
  const changed = chunks.map((c) => new Uint8Array(c)); changed[0][10] ^= 1;
  const tampered = verifyRelease({ signature, chunks: changed, rootHex, revoked: none, now });
  ok('изменённый кусок — нет', !tampered.ok && /Кусок 1/.test(tampered.why));
  ok('потерянный кусок — нет', !verifyRelease({ signature, chunks: [], rootHex, revoked: none, now }).ok);
  ok('строка таблицы о другой версии — нет', !verifyRelease({ signature, chunks, rootHex, revoked: none, now, version: '2.0.0' }).ok);
  const revokedRelease = readRevocations([revocationEnvelope(root, 'release', releaseKey('equipment-inspector', '1.0.0'))], rootHex);
  ok('отозванный выпуск — нет', !verifyRelease({ signature, chunks, rootHex, revoked: revokedRelease, now }).ok);
  const revokedKey = readRevocations([revocationEnvelope(root, 'key', devHex)], rootHex);
  ok('выпуск отозванного ключа — нет', !verifyRelease({ signature, chunks, rootHex, revoked: revokedKey, now }).ok);
  const forgedRevocation = readRevocations([revocationEnvelope(stranger, 'key', devHex)], rootHex);
  ok('отзыв без подписи владельца ничего не отзывает', forgedRevocation.keys.size === 0 && verifyRelease({ signature, chunks, rootHex, revoked: forgedRevocation, now }).ok);
  const later = releaseEnvelope(root, bundle, { version: '1.0.0', author: devHex, notBefore: now + 3600_000 });
  ok('время выпуска не наступило — нет', !verifyRelease({ signature: later, chunks, rootHex, revoked: none, now }).ok);
  const wrongManifest = moduleBundle('1.0.0', {}, { version: '1.0.1' });
  const sigWrong = releaseEnvelope(root, wrongManifest, { version: '1.0.0', author: devHex });
  ok('манифест другой версии — нет', !verifyRelease({ signature: sigWrong, chunks: splitChunks(wrongManifest), rootHex, revoked: none, now }).ok);
  ok('разбор подписанного выпуска строгий', parseReleaseClaim({ ...(peekEnvelope('release', signature) as any), extra: 1 }) === null);
}

console.log('Запрос на публикацию');
{
  const bundle = moduleBundle('1.1.0');
  const certs = readCertificates([certificateEnvelope(root, devHex)], rootHex, none);
  const signature = requestEnvelope(dev, bundle, { version: '1.1.0', baseRelease: 'equipment-inspector@1.0.0' });
  const good = verifyRequest({ signature, bundle, rootHex, certificates: certs });
  ok('запрос с сертификатом проходит', good.ok && !good.byOwner);
  ok('без сертификата — нет', !verifyRequest({ signature, bundle, rootHex, certificates: new Map() }).ok);
  ok('сертификат отозванного ключа не действует', readCertificates([certificateEnvelope(root, devHex)], rootHex, readRevocations([revocationEnvelope(root, 'key', devHex)], rootHex)).size === 0);
  ok('сертификат, подписанный не владельцем, не действует', readCertificates([certificateEnvelope(stranger, devHex)], rootHex, none).size === 0);
  ok('пакет не тот, что подписан — нет', !verifyRequest({ signature, bundle: moduleBundle('1.1.0', { 'logic/main.ts': 'evil()' }), rootHex, certificates: certs }).ok);
  const owner = verifyRequest({ signature: requestEnvelope(root, bundle, { version: '1.1.0' }), bundle, rootHex, certificates: new Map() });
  ok('правка владельца подписана корнем и проходит без сертификата', owner.ok && owner.byOwner);
}

console.log('Разница');
{
  const lines = diffLines('a\nb\nc', 'a\nx\nc');
  ok('построчно', lines.map((l) => l.op + l.text).join('|') === ' a|-b|+x| c');
  const before = unpackBundle(moduleBundle('1.0.0'));
  const after = unpackBundle(moduleBundle('1.1.0', { 'logic/extra.ts': 'export {}' }, { reads: ['project', 'equipment', 'tag', 'specification', 'catalog'] }));
  const files = diffFiles(before, after);
  ok('новый файл виден', files.find((f) => f.path === 'logic/extra.ts')?.status === 'added');
  ok('манифест изменён', files.find((f) => f.path === 'manifest.json')?.status === 'changed');
  ok('форма та же', files.find((f) => f.path === 'form.json')?.status === 'same');
  const narrowed = unpackBundle(moduleBundle('1.2.0', {}, { reads: ['project'] }));
  const perms = diffPermissions(manifestOf(narrowed), manifestOf(after)!);
  ok('расширение разрешений выделено', perms.widened && perms.added.reads?.includes('equipment'));
  ok('новая программа помечена', diffPermissions(null, manifestOf(after)!).isNew);
}

console.log('Что подписывает владелец — из байт пакета');
{
  const bundle = moduleBundle('1.1.0');
  const requestSignature = requestEnvelope(dev, bundle, { version: '1.1.0' });
  const claim = buildReleaseClaim({ requestId: 'r1', requestSignature, bundle, channel: 'test', notBefore: 5 });
  const signature = sealEnvelope('release', claim, root);
  ok('выпуск из байт запроса проверяется', verifyRelease({ signature, chunks: splitChunks(bundle), rootHex, revoked: none, now }).ok && claim.author === devHex && claim.channel === 'test');
  assert.throws(() => buildReleaseClaim({ requestId: 'r1', requestSignature, bundle: moduleBundle('1.1.0', { 'logic/main.ts': 'evil()' }), channel: 'production', notBefore: 0 }), /не тот/); passed++;
  assert.throws(() => buildReleaseClaim({ requestId: 'r1', requestSignature, bundle, channel: 'beta' as any, notBefore: 0 })); passed++;
  const edited = moduleBundle('1.1.0', { 'logic/main.ts': '// правка владельца' });
  const ownerClaim = buildOwnerRequestClaim({ ownerHex: rootHex, parentSignature: requestSignature, parentRequestId: 'r1', bundle: edited, comment: 'поправил' });
  ok('правка владельца — запрос с корнем и ссылкой на запрос разработчика', ownerClaim.author === rootHex && ownerClaim.parentRequest === 'r1'
    && verifyRequest({ signature: sealEnvelope('request', ownerClaim, root), bundle: edited, rootHex, certificates: new Map() }).ok);
  assert.throws(() => buildOwnerRequestClaim({ ownerHex: rootHex, parentSignature: requestSignature, parentRequestId: 'r1', bundle: moduleBundle('2.0.0'), comment: '' }), /другой модуль или версию/); passed++;
  ok('отзыв ключа', buildRevocationClaim({ kind: 'key', target: devHex.toUpperCase(), reason: '' }).target === devHex);
  assert.throws(() => buildRevocationClaim({ kind: 'release', target: 'не выпуск', reason: '' })); passed++;
  ok('сертификат', buildCertificateClaim({ key: devHex, userId: 'u1', name: 'Иван' }).key === devHex);
  assert.throws(() => buildCertificateClaim({ key: 'abc', userId: 'u1', name: '' })); passed++;
}

console.log(`\nВСЕ ТЕСТЫ ПРОЙДЕНЫ (${passed})`);
