/** Actual PDF + Rust XLSX host save/CAS/SaveAs checks using isolated synthetic Windows files. */
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import JSZip from 'jszip';
import { WindowsFilesService } from '../electron/filesystem/service';
import { LocalOfficeSessions } from '../electron/localOfficeSessions';
import { makePdf, makeXlsx } from './officeHarness';

async function main() {
 const testRoot = await mkdtemp(join(tmpdir(),'flux-local-office-native-'));
 const desktop = join(testRoot,'desktop'), userData=join(testRoot,'private');
 await mkdir(desktop); await mkdir(userData);
 const files=await WindowsFilesService.create({userData,knownFolders:{desktop},trashItem:async()=>{},showItemInFolder:()=>{},openPath:async()=>''});
 const rootId=(await files.roots())[0].id;
 const ref=(name:string)=>({rootId,relativePath:name});
 const auth={mayRead:()=>true,mayWrite:()=>true};
 let manager:LocalOfficeSessions;
 let pdfPath=''; let pdfEdits:any; const eventWork:Promise<unknown>[]=[];
 manager=new LocalOfficeSessions({files,userData,resourcesDir:resolve('genoffice-server'),onEvent(owner,event){
  if(event.channel==='pdf:save-as-request') eventWork.push((async()=>{
   let ok=false;
   try { const saved=await manager.handle(owner,{action:'invoke',session:event.session,channel:'pdf:save',args:[{...pdfEdits,path:pdfPath,targetPath:event.args[0]}]},auth); ok=saved?.ok===true; }
   finally { await manager.handle(owner,{action:'send',session:event.session,channel:'pdf:save-as-result',args:[ok]},auth); }
  })());
 }});
 let checks=0;
 const check=(name:string,value:unknown)=>{assert.ok(value,name);checks++;console.log('✓ '+name);};
 const invoke=(owner:number,session:number,channel:string,args?:unknown[],copyName?:string)=>manager.handle(owner,{action:'invoke',session,channel,args,copyName},auth);
 const pdfLib = createRequire(resolve('.cache/genoffice/apps/pdf/package.json'))('pdf-lib');
 const hasHighlight = async (bytes: Buffer) => { const doc = await pdfLib.PDFDocument.load(bytes); return doc.getPages().some((page:any) => { const annotations = page.node.Annots(); return annotations?.asArray().some((item:any) => doc.context.lookup(item).get(pdfLib.PDFName.of('Subtype'))?.toString() === '/Highlight'); }); };
 const xml=async(bytes:Buffer,part:string)=> (await JSZip.loadAsync(bytes)).file(part)!.async('string');
 const payload=(book:any,edits:any[])=>({sessionId:book.sessionId,mode:'save',edits,structuralOps:[],chartEdits:[],visualEdits:[],visualAdditions:[],tableAdditions:[],pivotAdditions:[],sheetOps:[],sheetOrder:[],filterStates:[],hyperlinkEdits:[],cfStates:[],dvStates:[],pageSetupStates:[],noteStates:[],formulaValues:[],pivotCacheRefreshPaths:[],pivotRefreshUpdates:[],sheetProtections:[],definedNamesState:null});
 try {
  const originalXlsx=await makeXlsx();
  await writeFile(join(desktop,'equipment.xlsx'),originalXlsx);
  const x=await manager.handle(1,{action:'open',app:'sheets',ref:ref('equipment.xlsx')},auth);
  let book=await invoke(1,x.session,'workbook:select');
  check('Actual Rust sidecar opens two-sheet workbook',!!book?.sessionId && book.sheets.length===2);
  const sheet=book.sheets[0];
  const sheetId=sheet.id ?? sheet.sheetId;
  const edit={sheetId,row:1,column:1,writeValue:true,value:11};
  const saveRequest=payload(book,[edit]); saveRequest.formulaValues=[{sheetId,row:3,column:1,value:15}] as any;
  const saved=await invoke(1,x.session,'workbook:save',[saveRequest]);
  check('Native workbook save replaces native session after capability persistence',!saved.canceled && saved.file.sessionId!==book.sessionId);
  book=saved.file;
  const savedBytes=await readFile(join(desktop,'equipment.xlsx'));
  const savedSheet=await xml(savedBytes,'xl/worksheets/sheet1.xml');
  check('Actual XLSX has edited B2 value',/<c\b[^>]*r="B2"[^>]*>[\s\S]*?<v>11<\/v>/.test(savedSheet));
  check('Formula remains SUM(B2:B3) and cached total 15',savedSheet.includes('SUM(B2:B3)') && savedSheet.includes('<v>15</v>'));
  check('Other sheet and customXml remain byte-for-byte',await xml(savedBytes,'xl/worksheets/sheet2.xml')===await xml(originalXlsx,'xl/worksheets/sheet2.xml') && await xml(savedBytes,'customXml/item1.xml')===await xml(originalXlsx,'customXml/item1.xml'));
  const dirs=await readdir(join(userData,'local-office'));
  const oneDir=join(userData,'local-office',dirs[0]);
  check('Native workbook snapshots are beneath its private view', (await readdir(join(oneDir,'temp','genoffice-sheets-sessions'))).length===1);
  const nextRequest=payload(book,[{...edit,value:19}]);
  await writeFile(join(desktop,'equipment.xlsx'),originalXlsx);
  await assert.rejects(()=>invoke(1,x.session,'workbook:save',[nextRequest]),(e:any)=>e.code==='CONFLICT'); checks++; console.log('✓ Actual native save sees external Windows change');
  const copied=await invoke(1,x.session,'workbook:save',[{...nextRequest,mode:'save-as'}],'my equipment.xlsx');
  check('SaveAs works with same native UUID after CAS refusal',!!copied.copy && copied.fluxCopySaved && (await xml(await readFile(join(desktop,'my equipment.xlsx')),'xl/worksheets/sheet1.xml')).includes('<v>19</v>'));
  check('Conflicted source stays unchanged',Buffer.compare(await readFile(join(desktop,'equipment.xlsx')),originalXlsx)===0);
  const recovery=await invoke(1,x.session,'workbook:write-recovery',[nextRequest]);
  check('Actual native recovery writes only private file',recovery.ok && (await stat(join(oneDir,'recovery.xlsx'))).isFile() && !(await readdir(desktop)).includes('recovery.xlsx'));
  // A second view keeps its own snapshot dir under concurrent native invokes.
  await writeFile(join(desktop,'second.xlsx'),originalXlsx);
  const x2=await manager.handle(2,{action:'open',app:'sheets',ref:ref('second.xlsx')},auth);
  await writeFile(join(desktop,'third.xlsx'),originalXlsx);
  const x3=await manager.handle(4,{action:'open',app:'sheets',ref:ref('third.xlsx')},auth);
  const [secondBook,thirdBook]=await Promise.all([invoke(2,x2.session,'workbook:select'),invoke(4,x3.session,'workbook:select')]);
  check('Second actual native view has distinct workbook session',secondBook.sessionId!==book.sessionId);
  const dirs2=await readdir(join(userData,'local-office'));
  check('Per-view native temp folders do not share snapshots',dirs2.length===3 && secondBook.sessionId!==thirdBook.sessionId && (await Promise.all(dirs2.map(async d=>(await readdir(join(userData,'local-office',d,'temp','genoffice-sheets-sessions'))).length))).every(n=>n===1));
  const originalPdf=makePdf(['Flux local PDF native check']);
  await writeFile(join(desktop,'document.pdf'),originalPdf);
  const p=await manager.handle(3,{action:'open',app:'pdf',ref:ref('document.pdf')},auth);
  check('Initial PDF signature library is available without an unsupported-channel error',Array.isArray(await invoke(3,p.session,'pdf:list-signatures')));
  pdfPath=await invoke(3,p.session,'pdf:consume-pending');
  check('PDF native open reads private bytes',Buffer.compare(Buffer.from(await invoke(3,p.session,'pdf:read-file',[pdfPath])),originalPdf)===0);
  pdfEdits={markups:[{pageIndex:0,type:'highlight',color:[1,1,0],quads:[[60,796,260,796,60,775,260,775]]}],drawings:[],formValues:[],stamps:[]};
  const copy=await manager.handle(3,{action:'copy',session:p.session,name:'document copy.pdf'},auth);
  await Promise.all(eventWork);
  check('Actual PDF native reentrant SaveAs completes',!!copy.copy && await hasHighlight(await readFile(join(desktop,'document copy.pdf'))));
  check('PDF SaveAs preserves original source bytes',Buffer.compare(await readFile(join(desktop,'document.pdf')),originalPdf)===0);
  const pdfSaved=await invoke(3,p.session,'pdf:save',[{...pdfEdits,path:pdfPath}]);
  check('Actual PDF annotation persists to original Windows file',pdfSaved.ok && await hasHighlight(await readFile(join(desktop,'document.pdf'))));
  await manager.closeOwner(1); await manager.closeOwner(2); await manager.closeOwner(3); await manager.closeOwner(4);
  check('Native owner shutdown removes private views and snapshots',(await readdir(join(userData,'local-office'))).length===0);
  console.log(`${checks} actual PDF/XLSX native checks passed`);
 } finally { await manager.dispose(); files.close(); await rm(testRoot,{recursive:true,force:true}); }
}
void main().then(()=>process.exit(0),e=>{console.error(e);process.exit(1);});
