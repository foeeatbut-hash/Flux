'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
// Чтение хранилища (расшифровка и проверка) общее с входом владельца в Flux и Flux Studio: studio/shared/vaultRead.cjs.
// Здесь остаются создание ключей, шифрование и запись — то, чего нет в сборке разработчика.
const { MAX_VAULT, SCRYPT, scrypt, passwordCheck, publicHex, validatePayload, inspectVault, decrypt } = require('../../shared/vaultRead.cjs');
function generateKey() {
  const {privateKey} = crypto.generateKeyPairSync('ed25519');
  return { privatePem: privateKey.export({format:'pem',type:'pkcs8'}).toString(), publicHex: publicHex(privateKey) };
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
