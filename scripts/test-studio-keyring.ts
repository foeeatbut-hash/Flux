/**
 * Ключ разработчика Studio: закрытая часть только в защищённом хранилище ОС.
 *
 * Что доказывается:
 * - ключ создаётся, открытая часть видна, подпись запроса проверяется открытым ключом;
 * - закрытой части нет ни в файле на диске открытым текстом, ни в ответе для окна, ни в запросе сертификата;
 * - без защищённого хранилища (в том числе `basic_text` на Linux) ключ не создаётся и не хранится открытым текстом;
 * - ключ из чужой учётной записи (другое хранилище) не расшифровывается — подпись отказывает, а не подписывает чем-то другим;
 * - повторное создание ключа отказывает (замена — только через владельца);
 * - запрос сертификата разбирается обратно и несёт именно открытый ключ.
 * Мутации в конце показывают, что проверки падают, если ключ утекает.
 *
 * Запуск: npx tsx scripts/test-studio-keyring.ts
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DeveloperKeyring, KeyringFailure, parseCertificateRequest, type SafeStorageLike } from '../studio/shared/keyring';
import { openEnvelope } from '../modules/trust/envelope';

let passed = 0;
const ok = (name: string, value: unknown) => { assert.ok(value, name); passed++; console.log(`  ✓ ${name}`); };
const refused = (fn: () => unknown, pattern: RegExp) => { try { fn(); } catch (e: any) { return e instanceof KeyringFailure && pattern.test(e.message); } return false; };

/** Хранилище с настоящим шифрованием (AES-GCM, ключ — «учётная запись»): расшифровать можно только тем же ключом */
function storageFor(account: string, backend?: string, available = true): SafeStorageLike {
  const key = crypto.createHash('sha256').update(`account:${account}`).digest();
  return {
    isEncryptionAvailable: () => available,
    ...(backend ? { getSelectedStorageBackend: () => backend } : {}),
    encryptString: (plain) => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv); const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), body]); },
    decryptString: (data) => { const d = crypto.createDecipheriv('aes-256-gcm', key, data.subarray(0, 12)); d.setAuthTag(data.subarray(12, 28)); return Buffer.concat([d.update(data.subarray(28)), d.final()]).toString('utf8'); },
  };
}

/** Закрытый ключ читается из файла: и открытым текстом, и под base64 (так он лежал бы при выключенном шифровании) */
const leaks = (fileText: string) => fileText.includes('PRIVATE KEY') || Buffer.from(String(JSON.parse(fileText).secret), 'base64').toString('latin1').includes('PRIVATE KEY');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-studio-keyring-'));
try {
  console.log('Создание и подпись');
  const ring = new DeveloperKeyring(dir, storageFor('alice'));
  ok('до создания ключа нет', ring.info().exists === false && ring.info().publicKey === '');
  const created = ring.create();
  ok('ключ создан, открытая часть — 64 шестнадцатеричных знака', created.exists && /^[0-9a-f]{64}$/.test(created.publicKey));
  const file = fs.readFileSync(path.join(dir, 'developer-key.json'), 'utf8');
  ok('на диске нет закрытого ключа ни открытым текстом, ни под base64', !leaks(file));
  ok('ответ для окна не содержит закрытой части', !JSON.stringify(ring.info()).includes(JSON.parse(file).secret));
  const signature = ring.sign('request', { hello: 'мир' });
  ok('подпись проверяется открытым ключом', JSON.stringify(openEnvelope('request', signature, created.publicKey)) === '{"hello":"мир"}');
  ok('подпись не проверяется чужим ключом', openEnvelope('request', signature, crypto.randomBytes(32).toString('hex')) === null);
  ok('подпись не выдаёт закрытую часть', !signature.includes(JSON.parse(file).secret));

  console.log('Отказы');
  ok('повторное создание отказывает и предупреждает про сертификат', refused(() => ring.create(), /сертификат прежнего ключа перестанет подходить/));
  ok('отказ не изменил ключ', ring.info().publicKey === created.publicKey);
  const other = new DeveloperKeyring(dir, storageFor('bob'));
  ok('чужая учётная запись: ключ не расшифровывается, подпись отказывает', refused(() => other.sign('request', {}), /не расшифровался/));
  const noStore = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-studio-keyring-no-'));
  for (const [label, storage] of [['хранилище недоступно', storageFor('x', undefined, false)], ['basic_text на Linux', storageFor('x', 'basic_text')]] as const) {
    const bare = new DeveloperKeyring(noStore, storage);
    ok(`${label}: ключ не создан`, refused(() => bare.create(), /хранить его открытым текстом нельзя/));
    ok(`${label}: на диске ничего нет`, fs.readdirSync(noStore).length === 0);
    ok(`${label}: об этом сказано окну`, bare.info().available === false);
  }
  ok('до создания запрос сертификата невозможен', refused(() => new DeveloperKeyring(noStore, storageFor('x')).certificateRequest({ userId: 'u', name: 'n' }), /Сначала создайте/));
  ok('до создания подпись невозможна', refused(() => new DeveloperKeyring(noStore, storageFor('x')).sign('request', {}), /Ключа разработчика нет/));
  // Подмена файла: открытая часть от другого ключа не должна пройти за свою
  const forged = JSON.parse(file); forged.publicKey = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(path.join(dir, 'developer-key.json'), JSON.stringify(forged));
  ok('подменённая открытая часть: подпись отказывает', refused(() => ring.sign('request', {}), /повреждён/));
  fs.writeFileSync(path.join(dir, 'developer-key.json'), file);

  console.log('Замена и повреждённый файл');
  const before = fs.readFileSync(path.join(dir, 'developer-key.json'), 'utf8');
  const replaced = ring.create(true);
  ok('явная замена создаёт новый ключ', replaced.exists && replaced.publicKey !== created.publicKey);
  ok('прежний файл ключа сохранён копией рядом', fs.readdirSync(dir).some((f) => f.endsWith('.bak') && fs.readFileSync(path.join(dir, f), 'utf8') === before));
  const good = fs.readFileSync(path.join(dir, 'developer-key.json'), 'utf8');
  fs.writeFileSync(path.join(dir, 'developer-key.json'), '{ не json');
  ok('повреждённый файл: окну сказано, ключа «нет», но он помечен повреждённым', ring.info().damaged === true && ring.info().exists === false);
  ok('повреждённый файл не перезаписывается созданием ключа', refused(() => ring.create(), /повреждён/) && refused(() => ring.create(true), /повреждён/) && fs.readFileSync(path.join(dir, 'developer-key.json'), 'utf8') === '{ не json');
  ok('повреждённый файл: подпись и запрос сертификата отказывают', refused(() => ring.sign('request', {}), /повреждён/) && refused(() => ring.certificateRequest({ userId: 'u', name: 'n' }), /повреждён/));
  fs.writeFileSync(path.join(dir, 'developer-key.json'), good);
  const created2 = replaced;
  void created2;

  console.log('Запрос сертификата');
  const request = ring.certificateRequest({ userId: 'dev-1', name: 'Иван Разработчик' });
  const parsed = parseCertificateRequest(request);
  ok('запрос разбирается: ключ, профиль и имя', parsed?.key === replaced.publicKey && parsed.userId === 'dev-1' && parsed.name === 'Иван Разработчик');
  ok('в запросе нет закрытой части', !Buffer.from(request.split('.')[1], 'base64url').toString().includes(JSON.parse(good).secret));
  ok('чужой формат не принимается', parseCertificateRequest('FLUXMODREQ1.abc.def') === null && parseCertificateRequest('') === null);

  console.log('Мутации: проверки должны падать, если ключ утекает');
  const leaking: SafeStorageLike = { ...storageFor('mallory'), encryptString: (plain) => Buffer.from(plain, 'utf8') };
  const leakDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-studio-keyring-leak-'));
  new DeveloperKeyring(leakDir, leaking).create();
  const leaked = fs.readFileSync(path.join(leakDir, 'developer-key.json'), 'utf8');
  ok('мутация «шифрование выключено»: проверка утечки это замечает', leaks(leaked));
  fs.rmSync(leakDir, { recursive: true, force: true }); fs.rmSync(noStore, { recursive: true, force: true });
  console.log(`\nКлюч разработчика Studio — ${passed} проверок пройдено`);
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
