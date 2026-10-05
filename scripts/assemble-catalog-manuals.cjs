'use strict';
// Проверенные оригиналы входят в portable; рабочие данные Каталога публикуются отдельно через БД.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
const source=path.join(root,'catalog','manual-assets');
const output=path.join(root,'public','catalog-documents');
const manifest=JSON.parse(fs.readFileSync(path.join(source,'manifest.json'),'utf8'));
if(manifest.format!=='FLUXCATALOGPDF1')throw new Error('Invalid catalog document manifest');
const digest=buffer=>crypto.createHash('sha256').update(buffer).digest('hex');
fs.mkdirSync(output,{recursive:true});
for(const item of manifest.documents){
  if(!/^[a-z]+\.pdf$/.test(item.file))throw new Error('Invalid catalog document filename');
  const target=path.join(output,item.file);
  if(fs.existsSync(target)){const previous=fs.readFileSync(target);if(previous.length===item.bytes&&digest(previous)===item.sha256)continue;}
  const chunks=item.parts.map(part=>{
    if(!/^[a-z]+-\d{2}\.pdfchunk$/.test(part.file))throw new Error('Invalid catalog document part');
    const bytes=fs.readFileSync(path.join(source,part.file));
    if(bytes.length!==part.bytes||digest(bytes)!==part.sha256)throw new Error(`Corrupted catalog document part: ${part.file}`);
    return bytes;
  });
  const document=Buffer.concat(chunks);
  if(document.length!==item.bytes||digest(document)!==item.sha256||!document.subarray(0,5).equals(Buffer.from('%PDF-')))throw new Error(`Corrupted catalog document: ${item.file}`);
  const temporary=target+'.tmp';
  try{fs.writeFileSync(temporary,document);fs.renameSync(temporary,target);}finally{fs.rmSync(temporary,{force:true});}
}
console.log(`Catalog originals verified: ${manifest.documents.length} PDF documents.`);
