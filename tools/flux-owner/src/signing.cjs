'use strict';
const fs=require('node:fs/promises'), crypto=require('node:crypto');
const {createReadStream}=require('node:fs');
const core=require('./vendor/license-core.ts');
const update=require('./vendor/updateSignature.ts');
const {publicHex}=require('./vault.cjs');
function keyFor(vault,purpose) { if(!vault?.keys?.[purpose])throw new Error('В этом хранилище нет ключа для выбранной операции.');return crypto.createPrivateKey(vault.keys[purpose].privatePem);}
function safeRequest(code) {
  if(typeof code!=='string'||code.length>1024*1024)throw new Error('Код запроса превышает 1 МБ.');
  const req=core.readRequest(code);
  if(!req || !req.inst || req.inst.length>200 || req.people.length<1 || req.people.length>10000 || req.people.some(p=>p.login.length>200||p.name.length>300))throw new Error('Некорректный код FLUXREQ1.');
  const unique=new Map(); for(const p of req.people)unique.set(core.normLogin(p.login),p);
  return {...req,org:req.org.slice(0,200),people:[...unique.values()]};
}
function issueLicense(vault,{code,logins,org,expiresAt}) {
  const req=safeRequest(code), exp=Number(expiresAt);
  if(!Array.isArray(logins)||!logins.length||logins.length>10000||!Number.isSafeInteger(exp)||exp<=Date.now()||exp>Date.now()+10*366*86400000)throw new Error('Выберите сотрудников и дату окончания не далее 10 лет.');
  const allowed=new Set(req.people.map(p=>core.normLogin(p.login))), selected=[...new Set(logins.map(core.normLogin))];
  if(selected.some(login=>!allowed.has(login)))throw new Error('В лицензии есть сотрудник, отсутствующий в запросе.');
  const signed=core.signLicense({inst:req.inst,org:String(org||req.org).slice(0,200),logins:selected,exp},keyFor(vault,'license'));
  const payload=core.readLicense(signed,vault.keys.license.publicHex); if(!payload)throw new Error('Проверка выпущенной лицензии не пройдена.');
  vault.licenses.push({...payload,code:signed});return {code:signed,payload};
}
function revokeLicenses(vault,{inst,ids}) {
  if(typeof inst!=='string'||!inst||inst.length>200||!Array.isArray(ids)||!ids.length||ids.length>10000)throw new Error('Выберите лицензии одной установки для отзыва.');
  const known=new Set(vault.licenses.filter(p=>p.inst===inst).map(p=>p.id));
  if(ids.some(id=>!known.has(id)))throw new Error('Лицензия не найдена в реестре этой установки.');
  vault.revocations ||= [];
  const previous=vault.revocations.filter(p=>p.inst===inst).sort((a,b)=>b.seq-a.seq)[0];
  const payload={v:1,inst,ids:[...new Set([...(previous?.ids||[]),...ids])].sort(),iat:Date.now(),seq:(previous?.seq||0)+1};
  const signed=`FLUXREV1.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  const code=`${signed}.${crypto.sign(null,Buffer.from(signed),keyFor(vault,'license')).toString('base64url')}`;
  vault.revocations.push({...payload,code});return {code,payload};
}
async function inspectExe(file,onProgress=()=>{},signal=null) {
  const stat=await fs.stat(file);
  if(!stat.isFile()||stat.size<5*1024*1024||stat.size>800*1024*1024||!file.toLowerCase().endsWith('.exe'))throw new Error('Выберите EXE размером от 5 до 800 МБ.');
  const handle=await fs.open(file,'r');try{const header=Buffer.alloc(2);await handle.read(header,0,2,0);if(header.toString('ascii')!=='MZ')throw new Error('Выбранный файл не является Windows EXE.');}finally{await handle.close();}
  const h=crypto.createHash('sha256'), stream=createReadStream(file);let read=0;
  const abort=()=>stream.destroy(new Error('Операция отменена.'));signal?.addEventListener('abort',abort,{once:true});
  try{if(signal?.aborted)abort();for await(const chunk of stream){h.update(chunk);read+=chunk.length;onProgress(read,stat.size);}}finally{signal?.removeEventListener('abort',abort);stream.destroy();}
  const after=await fs.stat(file);if(after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||after.ino!==stat.ino)throw new Error('EXE изменился во время проверки. Выберите его заново.');
  return {path:file,size:stat.size,mtimeMs:stat.mtimeMs,sha256:h.digest('hex')};
}
function signUpdate(vault,exe,version) {
  if(!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?$/.test(String(version))||version.length>40)throw new Error('Введите версию в виде 1.2.3 (до 40 символов).');
  const payload={version,size:exe.size,sha256:exe.sha256,iat:Date.now()};
  const signed=`FLUXUPD1.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  const signature=`${signed}.${crypto.sign(null,Buffer.from(signed),keyFor(vault,'update')).toString('base64url')}`;
  if(!update.readUpdateSignature(signature,vault.keys.update.publicHex))throw new Error('Проверка подписи обновления не пройдена.');
  return {signature,payload};
}
function publicConfig(vault) {
  if(vault.kind!=='main')throw new Error('Запасной файл используется только для входа владельца.');
  return {format:'FLUXPUBLIC1',license:vault.keys.license.publicHex,update:vault.keys.update.publicHex,owner:vault.keys.owner.publicHex,ownerBackup:vault.backupOwnerPublic};
}
function updateDelegationRequest(code) {
  if(typeof code!=='string'||code.length>8192||!code.startsWith('FLUXUPDAUTHREQ1.'))throw new Error('Вставьте запрос на разрешение из раздела «Сотрудники» в Flux.');
  let req;try{req=JSON.parse(Buffer.from(code.slice('FLUXUPDAUTHREQ1.'.length),'base64').toString('utf8'));}catch{throw new Error('Запрос на разрешение повреждён.');}
  if(req?.v!==1||![req.inst,req.userId].every(s=>typeof s==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(s))||!/^[a-f0-9]{64}$/i.test(req.publicKey))throw new Error('В запросе отсутствует установка, профиль или открытый ключ компьютера.');
  return {v:1,inst:req.inst,userId:req.userId,publicKey:req.publicKey};
}
function signUpdateDelegation(vault,{code,days,maxTargets,maxMinutes}) {
  const req=updateDelegationRequest(code);
  if(!Number.isInteger(days)||days<1||days>365||!Number.isInteger(maxTargets)||maxTargets<1||maxTargets>2000||!Number.isInteger(maxMinutes)||maxMinutes<5||maxMinutes>1440)throw new Error('Проверьте срок и ограничения разрешения.');
  const issuedAt=Date.now(),payload={...req,id:crypto.randomUUID(),issuedAt,expiresAt:issuedAt+days*86400000,maxTargets,maxMinutes};
  const body=`FLUXUPDAUTH1.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  return {code:`${body}.${crypto.sign(null,Buffer.from(body),keyFor(vault,'update')).toString('base64url')}`,payload};
}
module.exports={safeRequest,issueLicense,revokeLicenses,inspectExe,signUpdate,publicConfig,keyFor,updateDelegationRequest,signUpdateDelegation};
