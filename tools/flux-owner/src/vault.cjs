'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);
const MAX_VAULT = 8 * 1024 * 1024;
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
function passwordCheck(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 1024)
    throw new Error('Используйте фразу-пароль от 12 до 1024 символов.');
}
function publicHex(key) {
  const der = crypto.createPublicKey(key).export({ format: 'der', type: 'spki' });
  return der.subarray(-32).toString('hex');
}
function generateKey() {
  const {privateKey} = crypto.generateKeyPairSync('ed25519');
  return { privatePem: privateKey.export({format:'pem',type:'pkcs8'}).toString(), publicHex: publicHex(privateKey) };
}
function validateKey(entry) {
  if (!entry || typeof entry.privatePem !== 'string' || entry.privatePem.length > 1000 || !/^[a-f0-9]{64}$/.test(entry.publicHex || ''))
    throw new Error('Некорректный ключ в хранилище.');
  const key = crypto.createPrivateKey(entry.privatePem);
  if (key.asymmetricKeyType !== 'ed25519' || publicHex(key) !== entry.publicHex) throw new Error('Ключ и открытая половина не совпадают.');
}
function validatePayload(payload) {
  if (!payload || payload.v !== 1 || !['main','backup'].includes(payload.kind) || !payload.keys || !Array.isArray(payload.licenses) || !Array.isArray(payload.updates))
    throw new Error('Файл не является хранилищем владельца Flux.');
  for (const purpose of payload.kind === 'main' ? ['license','update','owner'] : ['owner']) validateKey(payload.keys[purpose]);
  if (Object.keys(payload.keys).some(k => !['license','update','owner'].includes(k))) throw new Error('Неизвестное назначение ключа.');
  if (payload.licenses.length > 10000 || payload.updates.length > 10000) throw new Error('Реестр слишком велик.');
  if (payload.backupOwnerPublic && !/^[a-f0-9]{64}$/.test(payload.backupOwnerPublic)) throw new Error('Некорректный запасной открытый ключ.');
  return payload;
}
function generateVaults() {
  const backup = generateKey();
  return {
    main: {v:1,kind:'main',createdAt:Date.now(),keys:{license:generateKey(),update:generateKey(),owner:generateKey()},backupOwnerPublic:backup.publicHex,licenses:[],updates:[],revocations:[]},
    backup: {v:1,kind:'backup',createdAt:Date.now(),keys:{owner:backup},licenses:[],updates:[],revocations:[]}
  };
}
async function encrypt(payload, password) {
  passwordCheck(password); validatePayload(payload);
  const plain = Buffer.from(JSON.stringify(payload));
  if (plain.length > MAX_VAULT) throw new Error('Реестр превышает лимит 8 МБ.');
  const salt = crypto.randomBytes(32), iv = crypto.randomBytes(12);
  const key = await scrypt(password, salt, 32, SCRYPT);
  try {
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from('FLUXOWNER1'));
    const data = Buffer.concat([cipher.update(plain), cipher.final()]);
    return JSON.stringify({format:'FLUXOWNER1',kdf:'scrypt-32768-8-1',salt:salt.toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')});
  } finally { key.fill(0); plain.fill(0); }
}
function decodeBase64(value, min, max) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error('Повреждённый файл хранилища.');
  const b = Buffer.from(value,'base64');
  if (b.length < min || b.length > max || b.toString('base64') !== value) throw new Error('Повреждённый файл хранилища.');
  return b;
}
function readEnvelope(serialized) {
  if (typeof serialized !== 'string' || serialized.length > MAX_VAULT * 1.5) throw new Error('Файл хранилища слишком велик.');
  let envelope;
  // Метка UTF-8 встречается после сохранения JSON средствами Windows и не меняет шифртекст.
  try { envelope = JSON.parse(serialized.replace(/^\uFEFF/, '')); }
  catch { throw new Error('Файл хранилища повреждён: не удалось прочитать JSON. Выберите другую копию .flux-owner.'); }
  if (envelope?.format === 'FLUXPUBLIC1') throw new Error('Выбран файл открытых ключей для сборки. Для входа нужен основной или запасной файл .flux-owner.');
  if (envelope?.format !== 'FLUXOWNER1') throw new Error('Этот файл не является зашифрованным хранилищем владельца Flux. Выберите файл .flux-owner.');
  if (envelope.kdf !== 'scrypt-32768-8-1') throw new Error('Способ шифрования этого хранилища не поддерживается.');
  const salt = decodeBase64(envelope.salt,32,32), iv=decodeBase64(envelope.iv,12,12), tag=decodeBase64(envelope.tag,16,16), data=decodeBase64(envelope.data,1,MAX_VAULT);
  return {salt,iv,tag,data};
}
function inspectVault(serialized) { readEnvelope(serialized); }
async function decrypt(serialized, password) {
  const {salt,iv,tag,data} = readEnvelope(serialized);
  passwordCheck(password);
  let key, plain;
  try {
    key = await scrypt(password,salt,32,SCRYPT);
    const decipher=crypto.createDecipheriv('aes-256-gcm',key,iv); decipher.setAAD(Buffer.from('FLUXOWNER1')); decipher.setAuthTag(tag);
    try { plain=Buffer.concat([decipher.update(data),decipher.final()]); }
    catch { throw new Error('Не удалось расшифровать хранилище. Проверьте пароль именно этого файла, раскладку и Caps Lock. Для запасного ключа нужен пароль запасного ключа. Файл также мог быть повреждён.'); }
    try { return validatePayload(JSON.parse(plain.toString('utf8'))); }
    catch { throw new Error('Хранилище расшифровано, но данные ключей повреждены. Выберите другую резервную копию.'); }
  }
  finally { if(key)key.fill(0); if(plain)plain.fill(0); }
}
async function readVault(file,password) {
  const st=await fs.stat(file); if(st.size > MAX_VAULT * 1.5) throw new Error('Файл хранилища слишком велик.');
  return decrypt(await fs.readFile(file,'utf8'),password);
}
async function atomicWrite(file,text) {
  await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});
  const tmp = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try { await fs.writeFile(tmp,text,{flag:'wx',mode:0o600}); await fs.rename(tmp,file); }
  finally { await fs.unlink(tmp).catch(()=>{}); }
}
module.exports={encrypt,decrypt,generateVaults,validatePayload,readVault,atomicWrite,passwordCheck,publicHex,inspectVault};
