/** Перенос проектных ID проверяется на SQLite и отдельных тестовых базах провайдеров. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { setDialect } from '../server/ddl.js';
import { bootstrapLocalDatabase } from '../server/databaseBootstrap.js';
import { previewEntityIdMigration, applyEntityIdMigration, undoEntityIdMigration } from '../server/entityIdMigration.js';

const require = createRequire(import.meta.url);
const dir = mkdtempSync(join(tmpdir(), 'flux-id-migration-'));
const provider = String(process.env.FLUX_ID_MIGRATION_PROVIDER || 'sqlite') as 'sqlite' | 'mysql' | 'postgresql';
assert.ok(['sqlite', 'mysql', 'postgresql'].includes(provider), 'FLUX_ID_MIGRATION_PROVIDER must be sqlite, mysql or postgresql');
const remoteUrl = provider === 'mysql' ? String(process.env.FLUX_ID_MIGRATION_MARIA_FIXTURE_URL || '')
  : provider === 'postgresql' ? String(process.env.FLUX_ID_MIGRATION_PG_FIXTURE_URL || '') : '';
if (provider !== 'sqlite') {
  const url = new URL(remoteUrl);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'only loopback disposable provider fixtures are allowed');
  assert.ok(url.pathname.toLowerCase().includes('fixture'), 'database name must explicitly include fixture');
}
const mysql = provider === 'mysql';
const { PrismaClient } = require(provider === 'sqlite' ? '../prisma-clients/client-sqlite' : mysql ? '../prisma-clients/client-mysql' : '../prisma-clients/client-pg');
const adapter = provider === 'sqlite'
  ? new (require('@prisma/adapter-better-sqlite3').PrismaBetterSqlite3)({ url: join(dir, 'fixture.sqlite') })
  : mysql ? new (require('@prisma/adapter-mariadb').PrismaMariaDb)(remoteUrl)
    : new (require('@prisma/adapter-pg').PrismaPg)({ connectionString: remoteUrl });
const prisma = new PrismaClient({ adapter });
// Одна проба проверяет все провайдеры; PostgreSQL требует нумерованных
// параметров и кавычек у исходных имён, уже экранированные имена сохраняются.
let fixtureSql=(sql:string)=>sql;
if (provider === 'postgresql') {
  const identifiers = ['NumericReference','projectId','objectId','Project','EquipmentSystem','Monoblock','ComponentElement','parentElementId','monoblockId','itemCode','Tag','identifier','metadata','_ComponentElementToTag','A','B','Dictionary','DictionaryItem','dictionaryId','nameRu','parentId','EquipmentHistory','elementId','oldSpecs','newSpecs','changeType','EquipmentXmlSource','tagId','targetType','systemId','tagIdentifier','xmlTargetIdentity','EquipmentXmlCandidate','sourceId','revision','fileName','sha256','parsedSpecs','changes','decisions','decisionHistory','expectedVersions','EquipmentXmlApplication','batchId','candidateId','oldVersion','newVersion','targetSnapshots','beforeDecisions','afterDecisions','beforeStatus','afterStatus','CatalogRevision','entityId','snapshotJson','ConstructorDoc','bindings','DocRegister','DocRegisterItem','registerId','equipmentTags','SelectionItem','listId','dataJson','AppSetting','TagChange','field','userId','E3Project','fluxProjectId','key','E3Binding','e3ProjectId','state'];
  const identifierPattern = new RegExp(`(?<![\\w"])(${identifiers.sort((a,b)=>b.length-a.length).join('|')})(?![\\w"])`, 'g');
  const bind = (sql: string) => {
    let i = 0;
    const quoted = sql.split(/('(?:''|[^'])*')/g).map((part, index) => index % 2 ? part : part.replace(identifierPattern, '"$1"')).join('');
    return quoted.replace(/\?/g, () => `$${++i}`);
  };
  fixtureSql=bind;
}
// Преобразуем только SQL самой пробы; методы Prisma остаются в своей транзакции.
const fixtureExec=(sql:string,...values:any[])=>prisma.$executeRawUnsafe(fixtureSql(sql),...values);
const fixtureQuery=(sql:string,...values:any[])=>prisma.$queryRawUnsafe(fixtureSql(sql),...values);
let checks = 0;
const check = (label: string, condition: unknown, detail?: unknown) => { assert.ok(condition, `${label}${detail===undefined?'':` — ${String(detail)}`}`); checks++; console.log(`✓ ${label}`); };
async function main() {
  try {
  const dialect = provider === 'sqlite' ? 'sqlite' : provider;
  setDialect(dialect);
  if (provider === 'sqlite') {
    const schema = readFileSync(join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    await bootstrapLocalDatabase(join(dir, 'fixture.sqlite'), prisma, schema, () => {});
  } else {
    const { ensureRemoteSchema } = await import('../server/schema-sync.js');
    const schemaFile = mysql ? 'prisma/schema.mariadb.prisma' : 'prisma/schema.postgresql.prisma';
    const schema = readFileSync(join(process.cwd(), schemaFile), 'utf8');
    const logs: string[] = [];
    await ensureRemoteSchema(prisma, dialect, schema, message => logs.push(message));
    assert.deepEqual(logs.filter(message => /Не удалось|Пропуск|Ошибка при/.test(message)), [], `${provider} fixture schema must be created cleanly`);
  }
  await fixtureExec(mysql
    ? `CREATE TABLE NumericReference (id VARCHAR(191) PRIMARY KEY, projectId VARCHAR(191), objectId INTEGER)`
    : `CREATE TABLE NumericReference (id TEXT PRIMARY KEY, projectId TEXT, objectId INTEGER)`);
  const p='11111111-1111-4111-8111-111111111111', pB='99999999-9999-4999-8999-999999999999';
  const sys='22222222-2222-4222-8222-222222222222', sys2='22222222-2222-4222-8222-222222222223', sysB='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
  const mb='33333333-3333-4333-8333-333333333333', mb2='33333333-3333-4333-8333-333333333334', mbB='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
  const eq='44444444-4444-4444-8444-444444444444', eq2='44444444-4444-4444-8444-444444444445', eqB='cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
  const tag='55555555-5555-4555-8555-555555555555', tag2='55555555-5555-4555-8555-555555555556', tagB='dddddddd-dddd-4ddd-8ddd-ddddddddddd1';
  const dict='66666666-6666-4666-8666-666666666666', dictB='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1';
  const root='77777777-7777-4777-8777-777777777777', leaf='88888888-8888-4888-8888-888888888888';
  const rootB='ffffffff-ffff-4fff-8fff-fffffffffff1', leafB='ffffffff-ffff-4fff-8fff-fffffffffff2';
  await fixtureExec(`INSERT INTO Project(id,name) VALUES (?, 'legacy')`, p);
  await fixtureExec(`INSERT INTO Project(id,name) VALUES (?, 'legacy B')`, pB);
  await fixtureExec(`INSERT INTO NumericReference(id,projectId,objectId) VALUES ('numeric-ref',?,42)`,p);
  await fixtureExec(`INSERT INTO EquipmentSystem(id,name,projectId) VALUES (?, 's', ?)`, sys,p);
  await fixtureExec(`INSERT INTO EquipmentSystem(id,name,projectId) VALUES (?, 's2', ?)`, sys2,p);
  await fixtureExec(`INSERT INTO EquipmentSystem(id,name,projectId) VALUES (?, 'sB', ?)`, sysB,pB);
  await fixtureExec(`INSERT INTO Monoblock(id,name,systemId) VALUES (?, 'm', ?)`, mb,sys);
  await fixtureExec(`INSERT INTO Monoblock(id,name,systemId) VALUES (?, 'm2', ?)`, mb2,sys2);
  await fixtureExec(`INSERT INTO Monoblock(id,name,systemId) VALUES (?, 'mB', ?)`, mbB,sysB);
  await fixtureExec(`INSERT INTO ComponentElement(id,name,itemCode,monoblockId,specs) VALUES (?, 'e', 'e', ?, '{"value":"keep"}')`,eq,mb);
  await fixtureExec(`INSERT INTO ComponentElement(id,name,itemCode,monoblockId,parentElementId,specs) VALUES (?, 'e2', 'e2', ?, ?, '{"value":"keep child"}')`,eq2,mb2,eq);
  await fixtureExec(`INSERT INTO ComponentElement(id,name,itemCode,monoblockId,specs) VALUES (?, 'eB', 'eB', ?, '{"value":"keep B"}')`,eqB,mbB);
  await fixtureExec(`INSERT INTO Tag(id,identifier,projectId,metadata) VALUES (?, 'T', ?, ?)`,tag,p,JSON.stringify({parentId:tag2,connections:[tag2],dynamicFields:{[root]:'selected'}}));
  await fixtureExec(`INSERT INTO Tag(id,identifier,projectId,metadata) VALUES (?, 'T2', ?, ?)`,tag2,p,JSON.stringify({parentId:tag,connections:[tag],dynamicFields:{[root]:'other'}}));
  await fixtureExec(`INSERT INTO Tag(id,identifier,projectId,metadata) VALUES (?, 'TB', ?, ?)`,tagB,pB,JSON.stringify({dynamicFields:{[rootB]:'project B'}}));
  await fixtureExec(`INSERT INTO _ComponentElementToTag(A,B) VALUES (?,?)`,eq,tag);
  await fixtureExec(`INSERT INTO _ComponentElementToTag(A,B) VALUES (?,?)`,eq2,tag2);
  await fixtureExec(`INSERT INTO _ComponentElementToTag(A,B) VALUES (?,?)`,eqB,tagB);
  await fixtureExec(`INSERT INTO Dictionary(id,projectId,name) VALUES (?,?,'__tag_creation_config__')`,dict,p);
  await fixtureExec(`INSERT INTO Dictionary(id,projectId,name) VALUES (?,?,'__tag_creation_config__')`,dictB,pB);
  await fixtureExec(`INSERT INTO DictionaryItem(id,dictionaryId,code,nameRu) VALUES (?,?,'root','root')`,root,dict);
  await fixtureExec(`INSERT INTO DictionaryItem(id,dictionaryId,code,nameRu,parentId) VALUES (?,?,'leaf','leaf',?)`,leaf,dict,root);
  await fixtureExec(`INSERT INTO DictionaryItem(id,dictionaryId,code,nameRu) VALUES (?,?,'rootB','root B')`,rootB,dictB);
  await fixtureExec(`INSERT INTO DictionaryItem(id,dictionaryId,code,nameRu,parentId) VALUES (?,?,'leafB','leaf B',?)`,leafB,dictB,rootB);
  await fixtureExec(`INSERT INTO EquipmentHistory(id,elementId,version,oldSpecs,newSpecs,changeType) VALUES ('hist',?,1,'{}',?,'edit')`,eq,JSON.stringify({elementId:eq, value:'keep'}));
  await fixtureExec(`INSERT INTO EquipmentXmlSource(id,projectId,tagId,targetType,systemId,elementId,tagIdentifier,xmlTargetIdentity) VALUES ('xml',?,?,'component',?,?, 'T', ?)`,p,tag,sys,eq,JSON.stringify({elementId:eq, tagId:tag}));
  await fixtureExec(`INSERT INTO EquipmentXmlCandidate(id,sourceId,projectId,revision,fileName,sha256,parsedSpecs,changes,decisions,decisionHistory,expectedVersions) VALUES ('candidate','xml',?,'A','fixture.xml','${'a'.repeat(64)}','{}',?,'{}','[]',?)`,p,JSON.stringify([{elementId:eq}]),JSON.stringify({[eq]:1}));
  await fixtureExec(`INSERT INTO EquipmentXmlApplication(id,batchId,candidateId,sourceId,elementId,oldVersion,newVersion,oldSpecs,newSpecs,targetSnapshots,beforeDecisions,afterDecisions,beforeStatus,afterStatus) VALUES ('application','batch','candidate','xml',?,1,2,'{}','{}',?,'{}','{}','pending','complete')`,eq,JSON.stringify([{elementId:eq}]));
  await fixtureExec(`INSERT INTO CatalogRevision(id,entity,entityId,snapshotJson) VALUES ('revision','tag',?,?)`,tag,JSON.stringify({id:tag,tagId:tag, prose:'opaque prose'}));
  await fixtureExec(`INSERT INTO ConstructorDoc(id,projectId,bindings) VALUES ('constructor',?,?)`,p,JSON.stringify([{elementId:eq, note:'opaque note'}]));
  await fixtureExec(`INSERT INTO DocRegister(id,projectId,name) VALUES ('register',?,'fixture')`,p);
  await fixtureExec(`INSERT INTO DocRegisterItem(id,registerId,projectId,equipmentTags) VALUES ('vdr','register',?,?)`,p,JSON.stringify([tag]));
  await fixtureExec(`INSERT INTO SelectionItem(id,listId,projectId,dataJson) VALUES ('selection','list',?,?)`,p,JSON.stringify({tagId:tag, note:'opaque note'}));
  await prisma.appSetting.create({data:{id:'setting-layout',key:`e3_layout:${p}`,value:JSON.stringify({projectId:p, format:'fixture', placed:{[eq]:{rect:{x:10,y:20}}}, off:{[eq2]:true}})}});
  await prisma.appSetting.create({data:{id:'setting-binding',key:`equipment_catalog_binding:${eq}`,value:JSON.stringify({elementId:eq})}});
  await prisma.appSetting.create({data:{id:'setting-history',key:`equipment_catalog_history:${eq}:rev-a`,value:JSON.stringify({entityId:eq})}});
  await prisma.tagChange.create({data:{id:'tag-change',tagId:tag,projectId:p,kind:'linkAdded',field:'parentId',before:tag2,after:tag2,userId:'identity-user'}});
  await prisma.tagChange.create({data:{id:'tag-connection',tagId:tag,projectId:p,kind:'linkAdded',field:'connections',before:tag2,after:tag2}});
  await prisma.tagChange.create({data:{id:'tag-field-history',tagId:tag,projectId:p,kind:'changed',field:`dynamicFields.${root}`,before:'old',after:'selected'}});
  await prisma.e3Project.create({data:{id:'e3',fluxProjectId:p,key:'external',name:'linked'}});
  await fixtureExec(`INSERT INTO E3Binding(id,e3ProjectId,elementId,state) VALUES ('binding','e3',?,'PLACED')`,eq);

  const blocked=await previewEntityIdMigration(prisma);
  const blocker=blocked.blockers.find(x=>x.code==='E3_BOUND_PROJECT');
  let e3ApplyCode=0; try { await applyEntityIdMigration(prisma,blocked.planToken); } catch(e:any) { e3ApplyCode=e.status; }
  check('E3-bound migration is blocked with explicit mapped element information and no ID rewrite', !!blocker && blocker.details.bindings[0].newElementId !== null && e3ApplyCode===409 && await prisma.project.findUnique({where:{id:p}})!==null);
  await fixtureExec(`DELETE FROM E3Binding`); await fixtureExec(`DELETE FROM E3Project`);
  const stale=await previewEntityIdMigration(prisma);
  await fixtureExec(`UPDATE ComponentElement SET parentElementId=? WHERE id=?`,eqB,eq2);
  let staleCode=0; try { await applyEntityIdMigration(prisma,stale.planToken); } catch(e:any) { staleCode=e.status; }
  check('changed planned reference invalidates the preview before any migration write', staleCode===409 && (await prisma.project.findUnique({where:{id:p}}))!==null && (await prisma.componentElement.findUnique({where:{id:eq2}})).parentElementId===eqB);
  await fixtureExec(`UPDATE ComponentElement SET parentElementId=? WHERE id=?`,eq,eq2);

  const plan=await previewEntityIdMigration(prisma);
  const applied=await applyEntityIdMigration(prisma,plan.planToken);
  const newId=(model:string,oldId:string)=>applied.mappings.find((m:any)=>m.model===model&&m.oldId===oldId)?.newId;
  const np=newId('Project',p), npB=newId('Project',pB), ne=newId('ComponentElement',eq), ne2=newId('ComponentElement',eq2), neB=newId('ComponentElement',eqB);
  const nt=newId('Tag',tag), nt2=newId('Tag',tag2), ntB=newId('Tag',tagB), nd=newId('Dictionary',dict), nr=newId('DictionaryItem',root), nl=newId('DictionaryItem',leaf), nrB=newId('DictionaryItem',rootB);
  const assignedIds=applied.mappings.map((mapping:any)=>mapping.newId);
  check('two projects and multiple equipment branches receive unique project-scoped IDs', new Set(assignedIds).size===assignedIds.length && !!np?.startsWith('PRJ-') && !!npB?.startsWith('PRJ-') && ne?.startsWith(`${np}-EQ-`) && ne2?.startsWith(`${np}-EQ-`) && neB?.startsWith(`${npB}-EQ-`) && nt?.startsWith(`${np}-TAG-`) && ntB?.startsWith(`${npB}-TAG-`) && nd?.startsWith(`${np}-DICT-`) && nr?.startsWith(`${np}-FLD-`) && nl?.startsWith(`${np}-DI-`) && nrB?.startsWith(`${npB}-FLD-`));
  check('parentElementId and many-to-many tag links cascade to all assigned IDs', await fixtureQuery(`SELECT A,B FROM _ComponentElementToTag WHERE A=? AND B=?`,ne,nt).then((r:any[])=>r.length===1) && await fixtureQuery(`SELECT A,B FROM _ComponentElementToTag WHERE A=? AND B=?`,ne2,nt2).then((r:any[])=>r.length===1) && (await prisma.componentElement.findUnique({where:{id:ne2}})).parentElementId===ne);
  const migratedTag=JSON.parse((await prisma.tag.findUnique({where:{id:nt}})).metadata);
  check('tag parent, connection and dynamic category key map while business value remains', migratedTag.parentId===nt2 && migratedTag.connections[0]===nt2 && migratedTag.dynamicFields[nr]==='selected' && migratedTag.dynamicFields[root]===undefined);
  const migratedTagHistory=await prisma.tagChange.findUnique({where:{id:'tag-change'}});
  check('TagChange scalar parent snapshots follow the same tag mapping', migratedTagHistory.before===nt2 && migratedTagHistory.after===nt2);
  const migratedConnection=await prisma.tagChange.findUnique({where:{id:'tag-connection'}});
  const migratedFieldHistory=await prisma.tagChange.findUnique({where:{id:'tag-field-history'}});
  check('raw connections and stable field paths keep their history representation', migratedConnection.before===nt2 && migratedConnection.after===nt2 && migratedFieldHistory.field===`dynamicFields.${nr}` && migratedFieldHistory.after==='selected');
  const migratedExpectedVersions=JSON.parse((await prisma.equipmentXmlCandidate.findUnique({where:{id:'candidate'}})).expectedVersions);
  const migratedCatalogSnapshot=JSON.parse((await prisma.catalogRevision.findUnique({where:{id:'revision'}})).snapshotJson);
  check('history, XML snapshots and catalog snapshot IDs migrate while preserving prose', JSON.parse((await prisma.equipmentHistory.findUnique({where:{id:'hist'}})).newSpecs).elementId===ne && JSON.parse((await prisma.equipmentHistory.findUnique({where:{id:'hist'}})).newSpecs).value==='keep' && migratedExpectedVersions[ne]===1 && migratedExpectedVersions[eq]===undefined && migratedCatalogSnapshot.id===nt && migratedCatalogSnapshot.tagId===nt && migratedCatalogSnapshot.prose==='opaque prose');
  check('integer columns ending in Id do not fail UUID scans or get rewritten as entity references', await fixtureQuery(`SELECT projectId,objectId FROM NumericReference WHERE id='numeric-ref'`).then((rows:any[])=>rows[0]?.objectId===42&&rows[0]?.projectId===np));
  const layoutSetting = await prisma.appSetting.findUnique({ where: { id: 'setting-layout' } });
  const bindingSetting = await prisma.appSetting.findUnique({ where: { id: 'setting-binding' } });
  const historySetting = await prisma.appSetting.findUnique({ where: { id: 'setting-history' } });
  const layout = JSON.parse(layoutSetting.value);
  check('known AppSetting keys and JSON IDs migrate with VDR tag arrays and E3 placed keys', (await prisma.docRegisterItem.findUnique({where:{id:'vdr'}})).equipmentTags===JSON.stringify([nt]) && layoutSetting.key===`e3_layout:${np}` && layout.placed[ne]?.rect?.x===10 && layout.placed[eq]===undefined && layout.off[ne2]===true && layout.off[eq2]===undefined && bindingSetting.key===`equipment_catalog_binding:${ne}` && JSON.parse(bindingSetting.value).elementId===ne && historySetting.key===`equipment_catalog_history:${ne}:rev-a` && JSON.parse(historySetting.value).entityId===ne);
  const noOp=await previewEntityIdMigration(prisma);
  check('a second preview after migration proposes no ID changes', noOp.mappings.length===0);
  await prisma.tagChange.create({data:{id:'late-history',tagId:nt,projectId:np,kind:'linkAdded',field:'connections',after:nt2}});
  let newHistoryConflict=0;try {await undoEntityIdMigration(prisma,applied.migrationId);}catch(e:any){newHistoryConflict=e.status;}
  check('new raw connection history blocks undo without losing it',newHistoryConflict===409 && (await prisma.tagChange.findUnique({where:{id:'late-history'}})).after===nt2);
  await prisma.tagChange.delete({where:{id:'late-history'}});
  const undone=await undoEntityIdMigration(prisma,applied.migrationId);
  const restoredTag=JSON.parse((await prisma.tag.findUnique({where:{id:tag}})).metadata);
  const restoredLayoutSetting=await prisma.appSetting.findUnique({where:{id:'setting-layout'}});
  const restoredLayout=JSON.parse(restoredLayoutSetting.value);
  const restoredCatalogBinding=await prisma.appSetting.findUnique({where:{id:'setting-binding'}});
  const restoredCatalogHistory=await prisma.appSetting.findUnique({where:{id:'setting-history'}});
  const restoredExpectedVersions=JSON.parse((await prisma.equipmentXmlCandidate.findUnique({where:{id:'candidate'}})).expectedVersions);
  const restoredCatalogSnapshot=JSON.parse((await prisma.catalogRevision.findUnique({where:{id:'revision'}})).snapshotJson);
  const restoredChange=await prisma.tagChange.findUnique({where:{id:'tag-change'}});
  check('guarded undo restores IDs, relationships, field keys, snapshots and setting keys exactly', undone.restored && await prisma.project.findUnique({where:{id:p}})!==null && await prisma.project.findUnique({where:{id:pB}})!==null && (await prisma.componentElement.findUnique({where:{id:eq2}})).parentElementId===eq && restoredTag.parentId===tag2 && restoredTag.connections[0]===tag2 && restoredTag.dynamicFields[root]==='selected' && restoredTag.dynamicFields[nr]===undefined && restoredLayoutSetting.key===`e3_layout:${p}` && restoredLayout.placed[eq]?.rect?.x===10 && restoredLayout.off[eq2]===true && restoredCatalogBinding.key===`equipment_catalog_binding:${eq}` && JSON.parse(restoredCatalogBinding.value).elementId===eq && restoredCatalogHistory.key===`equipment_catalog_history:${eq}:rev-a` && JSON.parse(restoredCatalogHistory.value).entityId===eq && restoredExpectedVersions[eq]===1 && restoredExpectedVersions[ne]===undefined && restoredCatalogSnapshot.id===tag && restoredCatalogSnapshot.tagId===tag && restoredChange.before===tag2 && restoredChange.after===tag2 && (await prisma.tagChange.findUnique({where:{id:'tag-connection'}})).after===tag2 && (await prisma.tagChange.findUnique({where:{id:'tag-field-history'}})).field===`dynamicFields.${root}`);

  // Непрозрачный текст со старым UUID блокирует перенос, но не переписывается.
  const originalMeta=(await prisma.tag.findUnique({where:{id:tag}})).metadata;
  await prisma.tag.update({where:{id:tag},data:{metadata:JSON.stringify({...JSON.parse(originalMeta), note:p})}});
  const opaque=await previewEntityIdMigration(prisma);
  let opaqueCode=0; try { await applyEntityIdMigration(prisma,opaque.planToken); } catch(e:any) { opaqueCode=e.status; }
  check('opaque old UUID text blocks migration and remains untouched', opaque.blockers.some((item:any)=>item.code==='UNSUPPORTED_JSON'&&String(item.message).includes('note')) && opaqueCode===409 && JSON.parse((await prisma.tag.findUnique({where:{id:tag}})).metadata).note===p && await prisma.project.findUnique({where:{id:p}})!==null);
  await prisma.tag.update({where:{id:tag},data:{metadata:JSON.stringify({...JSON.parse(originalMeta), opaqueIds:{[p]:'opaque key'}})}});
  const opaqueKey=await previewEntityIdMigration(prisma);
  let opaqueKeyCode=0; try { await applyEntityIdMigration(prisma,opaqueKey.planToken); } catch(e:any) { opaqueKeyCode=e.status; }
  check('unknown ID object keys block migration without rewriting', opaqueKey.blockers.some((item:any)=>item.code==='UNSUPPORTED_JSON'&&String(item.message).includes('opaqueIds')) && opaqueKeyCode===409 && JSON.parse((await prisma.tag.findUnique({where:{id:tag}})).metadata).opaqueIds[p]==='opaque key' && await prisma.project.findUnique({where:{id:p}})!==null);
  await prisma.tag.update({where:{id:tag},data:{metadata:originalMeta}});

  // Изменённая JSON-строка после переноса запрещает отмену.
  const p3='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab', tag3='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc';
  await fixtureExec(`INSERT INTO Project(id,name) VALUES (?, 'legacy3')`,p3);
  await fixtureExec(`INSERT INTO Tag(id,identifier,projectId,metadata) VALUES (?, 'T3', ?, ?)`,tag3,p3,JSON.stringify({parentId:tag}));
  const second=await previewEntityIdMigration(prisma); const secondApply=await applyEntityIdMigration(prisma,second.planToken);
  const tag3new=secondApply.mappings.find((m:any)=>m.model==='Tag'&&m.oldId===tag3).newId;
  await fixtureExec(`UPDATE Tag SET metadata=? WHERE id=?`,JSON.stringify({parentId:tag3new, humanNote:'edited'}),tag3new);
  let undoConflict=0; try { await undoEntityIdMigration(prisma,secondApply.migrationId); } catch(e:any) { undoConflict=e.status; }
  check('undo rejects a post-migration edit without overwriting it', undoConflict===409 && JSON.parse((await prisma.tag.findUnique({where:{id:tag3new}})).metadata).humanNote==='edited');
  await fixtureExec(`UPDATE Tag SET metadata=? WHERE id=?`,JSON.stringify({parentId:tag}),tag3new);
  const p3new=secondApply.mappings.find((m:any)=>m.model==='Project'&&m.oldId===p3).newId;
  const lateTag=`${p3new}-TAG-999999`;
  await fixtureExec(`INSERT INTO Tag(id,identifier,projectId,metadata) VALUES (?, 'late', ?, '{}')`,lateTag,p3new);
  let entitySetConflict=0; try { await undoEntityIdMigration(prisma,secondApply.migrationId); } catch(e:any) { entitySetConflict=e.status; }
  check('undo refuses to orphan project-bound entities created after migration', entitySetConflict===409 && await prisma.tag.findUnique({where:{id:lateTag}})!==null && await prisma.project.findUnique({where:{id:p3new}})!==null);

  const p4='cccccccc-cccc-4ccc-8ccc-ccccccccccc4', sys4='dddddddd-dddd-4ddd-8ddd-ddddddddddd4', mb4='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee4';
  const duplicateId='ffffffff-ffff-4fff-8fff-fffffffffff4';
  await fixtureExec(`INSERT INTO Project(id,name) VALUES (?, 'duplicate identities')`,p4);
  await fixtureExec(`INSERT INTO EquipmentSystem(id,name,projectId) VALUES (?, 's4', ?)`,sys4,p4);
  await fixtureExec(`INSERT INTO Monoblock(id,name,systemId) VALUES (?, 'm4', ?)`,mb4,sys4);
  await fixtureExec(`INSERT INTO ComponentElement(id,name,itemCode,monoblockId,specs) VALUES (?, 'duplicate EQ', 'EQ4', ?, '{}')`,duplicateId,mb4);
  await fixtureExec(`INSERT INTO Tag(id,identifier,projectId,metadata) VALUES (?, 'duplicate tag', ?, '{}')`,duplicateId,p4);
  const duplicatePlan=await previewEntityIdMigration(prisma);
  let duplicateApplyCode=0; try { await applyEntityIdMigration(prisma,duplicatePlan.planToken); } catch(e:any) { duplicateApplyCode=e.status; }
  check('duplicate raw identity across target models blocks apply without partial rewrite', duplicatePlan.blockers.some((item:any)=>item.code==='AMBIGUOUS_LEGACY_ID'&&item.details.id===duplicateId) && duplicateApplyCode===409 && await prisma.componentElement.findUnique({where:{id:duplicateId}})!==null && await prisma.tag.findUnique({where:{id:duplicateId}})!==null);
  console.log(`PASS ${checks} ${provider} migration checks`);
} finally { await prisma.$disconnect(); rmSync(dir,{recursive:true,force:true}); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
