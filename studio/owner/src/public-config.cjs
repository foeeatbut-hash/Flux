'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {atomicWrite}=require('./vault.cjs');
function withConstant(source,name,hex) {
  if(!/^[a-f0-9]{64}$/.test(hex))throw new Error('Некорректный открытый ключ.');
  const pattern=new RegExp(`(export\\s+const\\s+${name}\\s*=\\s*)['\"]([^'\"]*)['\"]`);
  const match=source.match(pattern);
  if(match&&match[2]&&match[2]!==hex)throw new Error(`В исходниках уже закреплён другой ${name}. Смена действующих ключей требует отдельного перехода и не выполняется автоматически.`);
  if(match)return source.replace(pattern,(_,prefix)=>`${prefix}'${hex}'`);
  return `${source.trimEnd()}\n\n/** Открытый ключ владельца; закрытая половина хранится отдельно. */\nexport const ${name} = '${hex}';\n`;
}
async function applyPublicConfig(folder,config) {
  if(config?.format!=='FLUXPUBLIC1')throw new Error('Неизвестный формат открытых ключей.');
  const root=await fs.realpath(folder),owner=path.join(root,'license','ownerKey.ts'),update=path.join(root,'electron','updateKey.ts');
  for(const file of [owner,update]){const actual=await fs.realpath(file);if(!actual.startsWith(root+path.sep)||(await fs.lstat(file)).isSymbolicLink())throw new Error('Файлы открытых ключей должны находиться внутри выбранных исходников Flux.');}
  const originalOwner=await fs.readFile(owner,'utf8'),originalUpdate=await fs.readFile(update,'utf8');
  let ownerNext=withConstant(originalOwner,'OWNER_PUBLIC_KEY_HEX',config.owner);
  ownerNext=withConstant(ownerNext,'OWNER_BACKUP_PUBLIC_KEY_HEX',config.ownerBackup);
  ownerNext=withConstant(ownerNext,'LICENSE_SIGNING_PUBLIC_KEY_HEX',config.license);
  const updateNext=withConstant(originalUpdate,'UPDATE_PUBLIC_KEY_HEX',config.update);
  await atomicWrite(owner,ownerNext);
  try{await atomicWrite(update,updateNext);}catch(e){await atomicWrite(owner,originalOwner);throw e;}
  return {files:[owner,update]};
}
module.exports={applyPublicConfig,withConstant};
