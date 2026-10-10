import { createHash } from 'node:crypto';
import { nextFieldId, nextProjectEntityId, nextProjectId } from './entityIds.js';
import { getDialect, type Dialect } from './ddl.js';

type Row = Record<string, any>;
type Table = { name: string; columns: string[]; pk: string[]; unique: string[][]; fks: Array<{ column: string; table: string; ref: string; onUpdate: string }> };
type Snapshot = { table: string; key: string[]; before: Row; after?: Row };
type IdentityRow = { model: string; id: string; projectId: string };
const MODEL_TABLES = [
  ['Project', 'Project'], ['EquipmentSystem', 'EquipmentSystem'], ['Monoblock', 'Monoblock'],
  ['ComponentElement', 'ComponentElement'], ['Tag', 'Tag'], ['Dictionary', 'Dictionary'], ['DictionaryItem', 'DictionaryItem'],
] as const;
const COUNTER_PREFIX = '__flux_entity_id_counter__';
const JOURNAL_PREFIX = 'entity_id_migration:';
const OMIT_COLUMNS = new Set(['userid','authorid','actorid','senderid','mailid','chatid','chatids','groupid','sessionid','socketid','messageid','createdbyid','updatedbyid','ownerid','assigneeid','uploadedbyid','deletedbyid','reviewerid','approverid','executorid','recipientid','fromuserid','touserid']);
const JSON_COLUMNS = new Set([
  'Tag.metadata', 'EquipmentHistory.oldSpecs', 'EquipmentHistory.newSpecs', 'EquipmentHistory.oldOverrides', 'EquipmentHistory.newOverrides',
  'TagChange.before', 'TagChange.after',
  'EquipmentXmlSource.xmlTargetIdentity', 'EquipmentXmlCandidate.parsedSpecs', 'EquipmentXmlCandidate.changes', 'EquipmentXmlCandidate.decisions', 'EquipmentXmlCandidate.decisionHistory', 'EquipmentXmlCandidate.expectedVersions',
  'EquipmentXmlApplication.oldSpecs', 'EquipmentXmlApplication.newSpecs', 'EquipmentXmlApplication.oldOverrides', 'EquipmentXmlApplication.newOverrides', 'EquipmentXmlApplication.targetSnapshots', 'EquipmentXmlApplication.beforeDecisions', 'EquipmentXmlApplication.afterDecisions',
  'CatalogRevision.snapshotJson', 'ConstructorDoc.bindings', 'DocRegisterItem.equipmentTags', 'SelectionItem.dataJson',
]);
const KNOWN_SETTING_KEYS = /^(e3_profile:|e3_layout:|equipment_catalog_binding:|equipment_catalog_history:|browser_bookmarks_|browser_project_key:|project_placed_elements:|project_off_elements:)/i;

export interface IdMigrationPlan {
  planToken: string; migrationId: string;
  mappings: Array<{ model: string; oldId: string; newId: string; projectId: string }>;
  counts: Record<string, number>;
  blockers: Array<{ code: string; message: string; projectId?: string; details?: any }>;
  projectIds: string[];
  scopeByOldId: Record<string, string>;
  rootItemIds: string[];
  identityInventory: IdentityRow[];
  before: Snapshot[];
  fingerprint: string;
}

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const quote = (dialect: Dialect, value: string) => dialect === 'mysql' ? `\`${value.replace(/`/g, '``')}\`` : `"${value.replace(/"/g, '""')}"`;
const textColumn = (dialect: Dialect, value: string) => `CAST(${quote(dialect,value)} AS ${dialect==='mysql'?'CHAR':'TEXT'})`;
const placeholders = (dialect: Dialect, values: any[]) => values.map((_, i) => dialect === 'postgresql' ? `$${i + 1}` : '?').join(',');
const parseJson = (value: unknown): any => { if (typeof value !== 'string') return null; try { return JSON.parse(value); } catch { return null; } };
const projectIdCompliant=(id:string)=>/^PRJ-\d{6,}$/.test(id);
const entityIdCompliant=(id:string,projectId:string,kind:string)=>{const prefix=`${projectId}-${kind}-`;return id.startsWith(prefix)&&/^\d{6,}$/.test(id.slice(prefix.length));};

async function schema(db: any, dialect: Dialect): Promise<Table[]> {
  if (dialect === 'sqlite') {
    const names = await db.$queryRawUnsafe("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
    const out: Table[] = [];
    for (const row of names) {
      const name = String(row.name);
      const cols = await db.$queryRawUnsafe(`PRAGMA table_info(${quote(dialect, name)})`);
      const fks = await db.$queryRawUnsafe(`PRAGMA foreign_key_list(${quote(dialect, name)})`);
      const indexes=await db.$queryRawUnsafe(`PRAGMA index_list(${quote(dialect,name)})`); const unique:string[][]=[];
      for(const index of indexes) if(Number(index.unique)) { const info=await db.$queryRawUnsafe(`PRAGMA index_info(${quote(dialect,String(index.name))})`); unique.push(info.map((c:any)=>String(c.name))); }
      const pk=cols.filter((c: any) => Number(c.pk)).sort((a: any,b: any) => Number(a.pk)-Number(b.pk)).map((c: any) => String(c.name));
      out.push({ name, columns: cols.map((c: any) => String(c.name)), pk:pk.length?pk:(unique[0]||[]),unique, fks: fks.map((f: any) => ({ column: String(f.from), table: String(f.table), ref: String(f.to), onUpdate: String(f.on_update).toUpperCase() })) });
    }
    return out;
  }
  const dbSchema = dialect === 'mysql' ? 'DATABASE()' : 'current_schema()';
  const columns = await db.$queryRawUnsafe(`SELECT table_name AS t,column_name AS c FROM information_schema.columns WHERE table_schema=${dbSchema} ORDER BY table_name,ordinal_position`);
  const fkRows = dialect === 'mysql'
    ? await db.$queryRawUnsafe(`SELECT k.table_name AS t,k.column_name AS c,k.referenced_table_name AS rt,k.referenced_column_name AS rc,r.update_rule AS u FROM information_schema.key_column_usage k JOIN information_schema.referential_constraints r ON r.constraint_schema=k.constraint_schema AND r.constraint_name=k.constraint_name WHERE k.table_schema=DATABASE() AND k.referenced_table_name IS NOT NULL`)
    : await db.$queryRawUnsafe(`SELECT tc.table_name AS t,kcu.column_name AS c,ccu.table_name AS rt,ccu.column_name AS rc,rc.update_rule AS u FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name=kcu.constraint_name AND tc.constraint_schema=kcu.constraint_schema JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name=tc.constraint_name AND ccu.constraint_schema=tc.constraint_schema JOIN information_schema.referential_constraints rc ON rc.constraint_name=tc.constraint_name AND rc.constraint_schema=tc.constraint_schema WHERE tc.constraint_type='FOREIGN KEY' AND tc.constraint_schema=current_schema()`);
  const map = new Map<string, Table>();
  for (const r of columns) { const name = String(r.t ?? r.T); if (!map.has(name)) map.set(name,{name,columns:[],pk:[],unique:[],fks:[]}); map.get(name)!.columns.push(String(r.c ?? r.C)); }
  for (const r of fkRows) { const t = map.get(String(r.t ?? r.T)); if (t) t.fks.push({column:String(r.c ?? r.C),table:String(r.rt ?? r.RT),ref:String(r.rc ?? r.RC),onUpdate:String(r.u ?? r.U).toUpperCase()}); }
  for (const t of map.values()) {
    const rows = await db.$queryRawUnsafe(`SELECT k.column_name AS c FROM information_schema.key_column_usage k JOIN information_schema.table_constraints tc ON tc.constraint_schema=k.constraint_schema AND tc.table_name=k.table_name AND tc.constraint_name=k.constraint_name WHERE k.table_schema=${dbSchema} AND k.table_name='${t.name.replace(/'/g,"''")}' AND tc.constraint_type='PRIMARY KEY' ORDER BY k.ordinal_position`);
    t.pk = rows.map((r: any) => String(r.c ?? r.C));
    const uniqueRows=await db.$queryRawUnsafe(dialect==='mysql'
      ? `SELECT index_name AS n,column_name AS c FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='${t.name.replace(/'/g,"''")}' AND non_unique=0 ORDER BY index_name,seq_in_index`
      : `SELECT tc.constraint_name AS n,kcu.column_name AS c FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name=kcu.constraint_name AND tc.constraint_schema=kcu.constraint_schema WHERE tc.constraint_type='UNIQUE' AND tc.table_schema=current_schema() AND tc.table_name='${t.name.replace(/'/g,"''")}' ORDER BY tc.constraint_name,kcu.ordinal_position`);
    const uniqueMap=new Map<string,string[]>();for(const r of uniqueRows){const n=String(r.n??r.N);if(!uniqueMap.has(n))uniqueMap.set(n,[]);uniqueMap.get(n)!.push(String(r.c??r.C));}
    t.unique=[...uniqueMap.values()];if(!t.pk.length)t.pk=t.unique[0]||[];
  }
  return [...map.values()];
}

function counter(prefix: string, scope: string) {
  const key = `${COUNTER_PREFIX}:${prefix}:${scope}`;
  const id = `${COUNTER_PREFIX}:${createHash('sha256').update(key).digest('hex')}`;
  return { key, id };
}
function candidate(prefix: string, n: number, projectId?: string) { return `${projectId ? `${projectId}-` : ''}${prefix}-${String(n).padStart(6,'0')}`; }

async function nextReadOnly(db: any, table: string, prefix: string, scope: string, projectId?: string, reservations = new Map<string,number>()): Promise<string> {
  const { id, key } = counter(prefix, scope);
  const setting = await db.appSetting.findUnique({ where: { id } });
  let value = reservations.get(id) ?? (setting ? Number(setting.value) : 0);
  if (!Number.isSafeInteger(value) || value < 0 || (setting && (setting.key !== key || setting.userId !== null))) throw new Error('Счётчик ID повреждён или занят другой настройкой; предпросмотр остановлен.');
  const delegate = db[table];
  for (let i=0;i<100000;i++) {
    value++;
    const idValue = candidate(prefix,value,projectId);
    if (!(await delegate.findUnique({where:{id:idValue},select:{id:true}}))) { reservations.set(id,value); return idValue; }
  }
  throw new Error(`Не удалось найти свободный ID для ${table}.`);
}

async function targetRows(db: any, projectIds: string[]) {
  const projects = await db.project.findMany({where:{id:{in:projectIds}},select:{id:true}});
  const systems = await db.equipmentSystem.findMany({where:{projectId:{in:projectIds}},select:{id:true,projectId:true}});
  const monoblocks = await db.monoblock.findMany({where:{system:{projectId:{in:projectIds}}},select:{id:true,systemId:true,system:{select:{projectId:true}}}});
  const elements = await db.componentElement.findMany({where:{monoblock:{system:{projectId:{in:projectIds}}}},select:{id:true,monoblockId:true,monoblock:{select:{system:{select:{projectId:true}}}}}});
  const tags = await db.tag.findMany({where:{projectId:{in:projectIds}},select:{id:true,projectId:true}});
  const dictionaries = await db.dictionary.findMany({where:{projectId:{in:projectIds}},select:{id:true,projectId:true,name:true}});
  const items = await db.dictionaryItem.findMany({where:{dictionary:{projectId:{in:projectIds}}},select:{id:true,parentId:true,dictionaryId:true,dictionary:{select:{projectId:true,name:true}}}});
  const byId=(rows:any[])=>rows.sort((a,b)=>String(a.id).localeCompare(String(b.id)));
  return {projects:byId(projects),systems:byId(systems),monoblocks:byId(monoblocks),elements:byId(elements),tags:byId(tags),dictionaries:byId(dictionaries),items:byId(items)};
}

function identityInventory(targets:Awaited<ReturnType<typeof targetRows>>):IdentityRow[] {
  const rows:IdentityRow[]=[];
  for(const r of targets.projects)rows.push({model:'Project',id:String(r.id),projectId:String(r.id)});
  for(const r of targets.systems)rows.push({model:'EquipmentSystem',id:String(r.id),projectId:String(r.projectId)});
  for(const r of targets.monoblocks)rows.push({model:'Monoblock',id:String(r.id),projectId:String(r.system.projectId)});
  for(const r of targets.elements)rows.push({model:'ComponentElement',id:String(r.id),projectId:String(r.monoblock.system.projectId)});
  for(const r of targets.tags)rows.push({model:'Tag',id:String(r.id),projectId:String(r.projectId)});
  for(const r of targets.dictionaries)rows.push({model:'Dictionary',id:String(r.id),projectId:String(r.projectId)});
  for(const r of targets.items)rows.push({model:'DictionaryItem',id:String(r.id),projectId:String(r.dictionary.projectId)});
  return rows.sort((a,b)=>a.model.localeCompare(b.model)||a.projectId.localeCompare(b.projectId)||a.id.localeCompare(b.id));
}

const ID_FIELDS=new Set(['projectId','systemId','monoblockId','elementId','tagId','dictionaryId','dictionaryItemId','parentId','sourceId','targetId','ownerId','entityId','fieldId','linkedProjectId']);
function rewriteKnownJson(table:string,col:string,row:Row,map:Map<string,string>) {
  if(table==='TagChange'&&(row.field==='parentId'||row.field==='connections')) {
    if(row.field==='parentId'&&typeof row[col]==='string'&&map.has(row[col]))return {value:map.get(row[col]),changed:true,unsupported:[]};
    if(row.field==='connections') { const parsed=parseJson(row[col]);if(Array.isArray(parsed)){let changed=false;const value=parsed.map((id:any)=>{if(typeof id==='string'&&map.has(id)){changed=true;return map.get(id);}return id;});return {value,changed,unsupported:[]};} }
  }
  const parsed=parseJson(row[col]);const unsupported:string[]=[];let changed=false;
  if(parsed===null)return {value:parsed,changed,unsupported};
  if(table==='DocRegisterItem'&&col==='equipmentTags'&&Array.isArray(parsed)) {
    const value=parsed.map((v:any)=>typeof v==='string'&&map.has(v)?(changed=true,map.get(v)):v);
    return {value,changed,unsupported};
  }
  const result=(value:any,path:string[],parentKey=''):any=>{
    if(typeof value==='string') {
      const next=map.get(value);if(!next)return value;
      const leaf=path[path.length-1]||'';
      const allowed=ID_FIELDS.has(leaf)||(['connections','tagIds','equipmentTags'].includes(parentKey)&&/^\d+$/.test(leaf))
        ||(table==='TagChange'&&((row.field==='parentId'&&leaf==='')||(row.field==='connections'&&parentKey==='')))
        ||(table==='CatalogRevision'&&leaf==='id'&&['tag','equipment'].includes(String(row.entity||'')));
      if(allowed){changed=true;return next;}
      unsupported.push(path.join('.')||'<root>');return value;
    }
    if(Array.isArray(value))return value.map((v,i)=>result(v,[...path,String(i)],parentKey));
    if(value&&typeof value==='object') {
      const out:any={};
      for(const [k,v] of Object.entries(value)) {
        const dynamicFieldKey=table==='Tag'&&col==='metadata'&&path.join('.')==='dynamicFields';
        const e3LayoutElementKey=table==='AppSetting'&&col==='value'&&['placed','off'].includes(path[0]||'');
        const xmlVersionElementKey=table==='EquipmentXmlCandidate'&&col==='expectedVersions';
        const idKey=(dynamicFieldKey||e3LayoutElementKey||xmlVersionElementKey)&&map.has(k);
        if(map.has(k)&&!idKey)unsupported.push([...path,k].join('.')||'<root-key>');
        const nextKey=idKey?map.get(k)!:k;if(idKey)changed=true;
        out[nextKey]=result(v,[...path,k],k);
      }
      return out;
    }
    return value;
  };
  const value=result(parsed,[]);
  return {value,changed,unsupported};
}

function appSettingKey(key: string, map: Map<string,string>) {
  for(const [oldId,newId] of map) {
    if(key.endsWith(`:${oldId}`))return key.slice(0,-oldId.length)+newId;
    if(key.endsWith(`_${oldId}`))return key.slice(0,-oldId.length)+newId;
    const history=`equipment_catalog_history:${oldId}:`;if(key.startsWith(history))return `equipment_catalog_history:${newId}:`+key.slice(history.length);
  }
  return key;
}

function recordSnapshot(rows:Map<string,Snapshot>,table:string,key:string[],before:Row,after:Row) {
  const identity=`${table}:${JSON.stringify(key.map(k=>before[k]))}`;const current=rows.get(identity);
  if(current){Object.assign(current.before,before);Object.assign(current.after||={},after);}
  else rows.set(identity,{table,key,before:{...before},after:{...after}});
}
function selectedColumns(key:string[],column:string,dialect:Dialect) {
  return [...new Set([...key,column])].map(c=>quote(dialect,c)).join(',');
}

/** План read-only: ID кандидаты совпадают с production allocator, counters не создаются и не двигаются. */
export async function previewEntityIdMigration(db: any): Promise<IdMigrationPlan> {
  const dialect = getDialect();
  const projects = (await db.project.findMany({where:{system:false},select:{id:true}})).sort((a:any,b:any)=>String(a.id).localeCompare(String(b.id)));
  const projectIds = projects.map((p:any)=>String(p.id)).sort();
  const targets = await targetRows(db, projectIds);
  const inventory=identityInventory(targets);
  const mapping = new Map<string,string>();
  const mappings: IdMigrationPlan['mappings'] = [];
  const scopeByOldId: Record<string,string> = {};
  const reservations=new Map<string,number>();
  const add = async (model:string, oldId:string, table:string, prefix:string, allocationProject:string, ownerProject:string, compliant:boolean) => {
    if(compliant)return;
    const id = await nextReadOnly(db,table,prefix,allocationProject,allocationProject||undefined,reservations);
    mapping.set(oldId,id); scopeByOldId[oldId]=allocationProject; mappings.push({model,oldId,newId:id,projectId:ownerProject});
  };
  for(const r of targets.projects) {
    if(projectIdCompliant(r.id)){scopeByOldId[r.id]=r.id;continue;}
    const newId=await nextReadOnly(db,'project','PRJ','global',undefined,reservations);
    mapping.set(r.id,newId);scopeByOldId[r.id]=newId;mappings.push({model:'Project',oldId:r.id,newId,projectId:r.id});
  }
  for(const r of targets.systems) {const owner=r.projectId,project=mapping.get(owner)||owner;await add('EquipmentSystem',r.id,'equipmentSystem','SYS',project,owner,entityIdCompliant(r.id,owner,'SYS')&&project===owner);}
  for(const r of targets.monoblocks) {const owner=r.system.projectId,project=mapping.get(owner)||owner;await add('Monoblock',r.id,'monoblock','MB',project,owner,entityIdCompliant(r.id,owner,'MB')&&project===owner);}
  for(const r of targets.elements) {const owner=r.monoblock.system.projectId,project=mapping.get(owner)||owner;await add('ComponentElement',r.id,'componentElement','EQ',project,owner,entityIdCompliant(r.id,owner,'EQ')&&project===owner);}
  for(const r of targets.tags) {const owner=r.projectId,project=mapping.get(owner)||owner;await add('Tag',r.id,'tag','TAG',project,owner,entityIdCompliant(r.id,owner,'TAG')&&project===owner);}
  for(const r of targets.dictionaries) {const owner=r.projectId,project=mapping.get(owner)||owner;await add('Dictionary',r.id,'dictionary','DICT',project,owner,entityIdCompliant(r.id,owner,'DICT')&&project===owner);}
  const rootItems=new Set<string>();
  for(const r of targets.items) {const owner=r.dictionary.projectId,project=mapping.get(owner)||owner;const isConfigRoot=r.dictionary.name==='__tag_creation_config__'&&!r.parentId;if(isConfigRoot)rootItems.add(r.id);const prefix=isConfigRoot?'FLD':'DI';await add('DictionaryItem',r.id,'dictionaryItem',prefix,project,owner,entityIdCompliant(r.id,owner,prefix)&&project===owner);}
  const blockers: IdMigrationPlan['blockers'] = [];
  const mappedProjectIds=[...new Set(mappings.map(m=>m.projectId))];
  const mappedElementIds=mappings.filter(m=>m.model==='ComponentElement').map(m=>m.oldId);
  const directlyBound=db.e3Project?.findMany&&mappedProjectIds.length?await db.e3Project.findMany({where:{fluxProjectId:{in:mappedProjectIds}}}):[];
  const affectedBindings=db.e3Binding?.findMany&&mappedElementIds.length?await db.e3Binding.findMany({where:{elementId:{in:mappedElementIds}},select:{id:true,e3ProjectId:true,elementId:true,state:true}}):[];
  const relatedE3Ids=[...new Set(affectedBindings.map((b:any)=>String(b.e3ProjectId)))];
  const throughBindings=db.e3Project?.findMany&&relatedE3Ids.length?await db.e3Project.findMany({where:{id:{in:relatedE3Ids}}}):[];
  const e3=[...new Map([...directlyBound,...throughBindings].map((x:any)=>[String(x.id),x])).values()];
  const e3Ids = e3.map((x:any)=>x.id);
  if(e3Ids.length) {
    const existingBindings=affectedBindings.concat(await db.e3Binding.findMany({where:{e3ProjectId:{in:e3Ids}},select:{id:true,e3ProjectId:true,elementId:true,state:true}}));
    const exports=db.e3Export?.findMany?await db.e3Export.findMany({where:{e3ProjectId:{in:e3Ids}},select:{id:true,e3ProjectId:true,state:true,planJson:true,journalJson:true}}):[];
    for(const linked of e3) blockers.push({code:'E3_BOUND_PROJECT',projectId:String(linked.fluxProjectId),message:'Проект связан с E3.series. Сначала согласуйте FLUX_PROJECT, привязки и журналы во внешнем проекте; применить миграцию автоматически нельзя.',details:{e3ProjectId:linked.id,key:linked.key,name:linked.name,bindings:existingBindings.filter((b:any)=>b.e3ProjectId===linked.id).map((b:any)=>({id:b.id,elementId:b.elementId,newElementId:mapping.get(b.elementId)||null,state:b.state})),exports:exports.filter((x:any)=>x.e3ProjectId===linked.id).map((x:any)=>({id:x.id,state:x.state}))}});
  }
  const tables=await schema(db,dialect);
  const snapshots=new Map<string,Snapshot>();
  // Все FK на переносимые сущности должны иметь ON UPDATE CASCADE, иначе смена PK разорвёт связи.
  const targetTableNames=new Set<string>(MODEL_TABLES.map((x)=>x[1]));
  for(const t of tables) for(const fk of t.fks) if(targetTableNames.has(fk.table)&&fk.onUpdate!=='CASCADE') blockers.push({code:'FK_UPDATE_UNSAFE',message:`${t.name}.${fk.column} ссылается на ${fk.table}.${fk.ref}, но ON UPDATE не CASCADE.`});
  // Находим скалярные ссылки по старому ID и исключаем домены, которые не входят в перенос.
  const knownNames=new Set(['id','projectId','systemId','monoblockId','elementId','tagId','dictionaryId','dictionaryItemId','parentId','sourceId','targetId','entityId','fluxProjectId','e3ProjectId','fileId','linkedProjectId']);
  for(const t of tables) {
    if(t.name==='E3Project') continue; // Внешнюю связь блокируем, но не переписываем.
    for(const col of t.columns) {
      const incomingTargetFk=t.fks.some(f=>f.column===col&&targetTableNames.has(f.table));
      if(OMIT_COLUMNS.has(col.toLowerCase())||col==='id'||(!incomingTargetFk&&!knownNames.has(col)&&!/(?:Id|ID|id)$/.test(col))) continue;
      if(t.name==='AppSetting'&&col==='key') continue;
      const vals=[...mapping.keys()]; if(!vals.length) continue;
      if(!t.pk.length){blockers.push({code:'ROW_KEY_UNSAFE',message:`Нельзя подготовить CAS-снимок ${t.name}: отсутствует ключ строки.`});continue;}
      for(let start=0;start<vals.length;start+=400) {
        const batch=vals.slice(start,start+400);
        const rows=await db.$queryRawUnsafe(`SELECT ${selectedColumns(t.pk,col,dialect)} FROM ${quote(dialect,t.name)} WHERE ${textColumn(dialect,col)} IN (${placeholders(dialect,batch)})`,...batch);
        for(const row of rows) {
          const old=String(row[col]);const next=mapping.get(old);if(!next)continue;
          const before:Row={},after:Row={};for(const key of t.pk){before[key]=row[key];after[key]=mapping.get(String(row[key]))||row[key];}before[col]=old;after[col]=next;
          if(t.pk.includes(col)&&!incomingTargetFk)blockers.push({code:'REFERENCE_KEY_COLLISION',message:`Поле ${t.name}.${col} входит в уникальный ключ без FK cascade.`});
          recordSnapshot(snapshots,t.name,t.pk,before,after);
        }
      }
    }
  }
  // Обрабатываем явные ключи настроек и поддержанные JSON-кодеки.
  let settings:Row[]=[];
  const jsonCandidate=/json|metadata|specs|overrides|bindings|snapshot|tags|extra|meta|config|decision/i;
  for(const t of tables) {
    if(t.name==='AppSetting') {
      if(!t.pk.length){blockers.push({code:'ROW_KEY_UNSAFE',message:'Нельзя подготовить CAS-снимок AppSetting.'});continue;}
      settings=await db.$queryRawUnsafe(`SELECT ${['id','key','userId','value'].filter(c=>t.columns.includes(c)).map(c=>quote(dialect,c)).join(',')} FROM ${quote(dialect,t.name)}`);
      for(const row of settings) {
        const key=String(row.key||'');if(key.startsWith(JOURNAL_PREFIX)||key.startsWith(COUNTER_PREFIX))continue;
        const known=KNOWN_SETTING_KEYS.test(key),keyAfter=known?appSettingKey(key,mapping):key;
        const decoded=known?rewriteKnownJson(t.name,'value',row,mapping):{value:null,changed:false,unsupported:containsMappedJson(String(row.value||''),mapping)?['<unsupported setting>']:[]};
        if(keyAfter!==key&&settings.some(other=>other.id!==row.id&&other.key===keyAfter&&other.userId===row.userId))blockers.push({code:'SETTING_KEY_COLLISION',message:`Перенос ключа настройки «${key}» создаст конфликт с существующим ключом.`});
        if(decoded.unsupported.length||(!known&&[...mapping.keys()].some(id=>key.includes(id))))blockers.push({code:'UNSUPPORTED_JSON',message:`Настройка «${key}» содержит переносимый ID в неподдерживаемом поле.`});
        if(keyAfter!==key||decoded.changed)recordSnapshot(snapshots,t.name,t.pk,{id:row.id,key:row.key,userId:row.userId,value:row.value},{id:row.id,key:keyAfter,userId:row.userId,value:decoded.changed?JSON.stringify(decoded.value):row.value});
      }
      continue;
    }
    if(!t.pk.length)continue;
    for(const col of t.columns.filter(c=>JSON_COLUMNS.has(`${t.name}.${c}`)||jsonCandidate.test(c))) {
      const select=[...new Set([...t.pk,col,...(t.name==='TagChange'?['field']:[]),...(t.name==='CatalogRevision'?['entity']:[])])].map(c=>quote(dialect,c)).join(',');
      const rows=await db.$queryRawUnsafe(`SELECT ${select} FROM ${quote(dialect,t.name)} WHERE ${quote(dialect,col)} IS NOT NULL`);
      for(const row of rows) {
        const scalarTagParent=t.name==='TagChange'&&row.field==='parentId'&&mapping.has(String(row[col]));
        if(typeof row[col]!=='string'||(!/^\s*[\[{]/.test(row[col])&&!scalarTagParent))continue;
        const decoded=rewriteKnownJson(t.name,col,row,mapping);if(!decoded.changed&&!decoded.unsupported.length)continue;
        if(!JSON_COLUMNS.has(`${t.name}.${col}`))blockers.push({code:'UNSUPPORTED_JSON',message:`${t.name}.${col} содержит переносимый ID в неподдерживаемом JSON-поле.`});
        else {
          if(decoded.unsupported.length)blockers.push({code:'UNSUPPORTED_JSON',message:`${t.name}.${col} содержит ID в неподдерживаемом JSON-пути ${decoded.unsupported[0]}.`});
          if(decoded.changed){const before:Row={},after:Row={};for(const k of t.pk){before[k]=row[k];after[k]=row[k];}before[col]=row[col];after[col]=JSON.stringify(decoded.value);recordSnapshot(snapshots,t.name,t.pk,before,after);}
        }
      }
    }
  }
  for(const m of mappings)recordSnapshot(snapshots,MODEL_TABLES.find(x=>x[0]===m.model)![1],['id'],{id:m.oldId},{id:m.newId});
  const before=[...snapshots.values()].sort((a,b)=>a.table.localeCompare(b.table)||JSON.stringify(a.before).localeCompare(JSON.stringify(b.before)));
  const refs=before.filter(s=>Object.keys(s.after||{}).some(k=>!s.key.includes(k))).length;
  const counts:Record<string,number>={projects:targets.projects.length,equipmentSystems:targets.systems.length,monoblocks:targets.monoblocks.length,componentElements:targets.elements.length,tags:targets.tags.length,dictionaries:targets.dictionaries.length,dictionaryItems:targets.items.length,scalarReferences:refs,jsonReferences:before.filter(x=>x.after&&Object.keys(x.after).some(k=>!x.key.includes(k)&&JSON_COLUMNS.has(`${x.table}.${k}`))).length};
  const fingerprint=hash({projectIds,mappings,before,blockers,inventory});
  const migrationId=`migration-${fingerprint.slice(0,24)}`;
  const planToken=hash({fingerprint});
  return {planToken,migrationId,mappings,counts,blockers,projectIds,scopeByOldId,rootItemIds:[...rootItems],identityInventory:inventory,before,fingerprint};
}

function containsMappedJson(raw:string,map:Map<string,string>) { const parsed=parseJson(raw);if(parsed===null)return false;const stack=[parsed];while(stack.length){const v=stack.pop();if(typeof v==='string'&&map.has(v))return true;if(Array.isArray(v))stack.push(...v);else if(v&&typeof v==='object')for(const [k,x]of Object.entries(v)){if(map.has(k))return true;stack.push(x);}}return false; }

function keyWhere(key: string[], row: Row, dialect: Dialect) { return key.map((k,i)=>`${quote(dialect,k)} = ${dialect==='postgresql'?`$${i+1}`:'?'}`).join(' AND '); }
async function rejectNewReferences(tx:any,dialect:Dialect,tables:Table[],journal:any) {
  const reverse=new Map<string,string>((journal.mappings||[]).map((m:any)=>[m.newId,m.oldId]));
  if(!reverse.size)return;
  const mapped=[...reverse.keys()];
  const saved=new Map<string,Snapshot>((journal.after||[]).map((s:Snapshot)=>[`${s.table}:${JSON.stringify(s.key.map(k=>s.after?.[k]))}`,s]));
  const assertSaved=(table:string,row:Row,key:string[],column:string,value:any) => {
    const snap=saved.get(`${table}:${JSON.stringify(key.map(k=>row[k]))}`);
    if(!snap?.after||!Object.prototype.hasOwnProperty.call(snap.after,column)||snap.after[column]!==value)
      throw Object.assign(new Error('Появились новые ссылки на перенесённые ID; отмена остановлена, чтобы не повредить новые данные.'),{status:409});
  };
  const knownNames=new Set(['projectId','systemId','monoblockId','elementId','tagId','dictionaryId','dictionaryItemId','parentId','sourceId','targetId','entityId','fluxProjectId','e3ProjectId','fileId','linkedProjectId']);
  for(const t of tables) {
    if(!t.pk.length)continue;
    for(const col of t.columns) {
      const incomingTargetFk=t.fks.some(f=>f.column===col&&MODEL_TABLES.some(([,name])=>name===f.table));
      if(OMIT_COLUMNS.has(col.toLowerCase())||col==='id'||(!incomingTargetFk&&!knownNames.has(col)&&!/(?:Id|ID|id)$/.test(col))||t.name==='AppSetting'&&col==='key')continue;
      for(let start=0;start<mapped.length;start+=400) {
        const batch=mapped.slice(start,start+400);
        const rows=await tx.$queryRawUnsafe(`SELECT ${selectedColumns(t.pk,col,dialect)} FROM ${quote(dialect,t.name)} WHERE ${textColumn(dialect,col)} IN (${placeholders(dialect,batch)})`,...batch);
        for(const row of rows)assertSaved(t.name,row,t.pk,col,row[col]);
      }
    }
    for(const col of t.columns.filter(c=>JSON_COLUMNS.has(`${t.name}.${c}`)||/json|metadata|specs|overrides|bindings|snapshot|tags|extra|meta|config|decision/i.test(c))) {
      const select=[...new Set([...t.pk,col])].map(c=>quote(dialect,c)).join(',');
      const rows=await tx.$queryRawUnsafe(`SELECT ${select} FROM ${quote(dialect,t.name)} WHERE ${quote(dialect,col)} IS NOT NULL`);
      for(const row of rows) {
        if(typeof row[col]!=='string'||!containsMappedJson(row[col],reverse))continue;
        assertSaved(t.name,row,t.pk,col,row[col]);
      }
    }
  }
  const settingRows=await tx.$queryRawUnsafe(`SELECT ${['id','key','userId','value'].map(c=>quote(dialect,c)).join(',')} FROM ${quote(dialect,'AppSetting')}`);
  for(const row of settingRows) {
    const key=String(row.key||'');if(key.startsWith(JOURNAL_PREFIX)||key.startsWith(COUNTER_PREFIX))continue;
    const nextKey=KNOWN_SETTING_KEYS.test(key)?appSettingKey(key,reverse):key;
    if(nextKey!==key)assertSaved('AppSetting',row,['id'],'key',row.key);
    if(containsMappedJson(String(row.value||''),reverse))assertSaved('AppSetting',row,['id'],'value',row.value);
  }
}
async function updateRow(tx:any,dialect:Dialect,table:Table,key:string[],before:Row,after:Row) {
  const cols=Object.keys(after).filter(c=>!key.includes(c)); if(!cols.length)return;
  const vals=[...cols.map(c=>after[c]),...key.map(k=>before[k])];
  const sets=cols.map((c,i)=>`${quote(dialect,c)} = ${dialect==='postgresql'?`$${i+1}`:'?'}`).join(',');
  const where=keyWhere(key,before,dialect).replace(/\$(\d+)/g,(_,n)=>`$${Number(n)+cols.length}`);
  const result=await tx.$executeRawUnsafe(`UPDATE ${quote(dialect,table.name)} SET ${sets} WHERE ${where}`,...vals);
  if(Number(result)!==1) {
    // MySQL может вернуть 0, если ON UPDATE CASCADE уже записал нужное значение FK.
    // Перед пропуском повторно сверяем только ключ и изменяемые поля.
    const projection=[...new Set([...key,...cols])];
    const rows=await tx.$queryRawUnsafe(`SELECT ${projection.map(c=>quote(dialect,c)).join(',')} FROM ${quote(dialect,table.name)} WHERE ${keyWhere(key,before,dialect)}`,...key.map(k=>before[k]));
    const row=rows[0];
    if(!row||cols.some(c=>row[c]!==after[c])) throw new Error(`Изменились строки ${table.name}; миграция остановлена без сохранения.`);
  }
}
async function movePrimaryKey(tx:any,dialect:Dialect,table:Table,oldId:string,newId:string) {
  const result=await tx.$executeRawUnsafe(`UPDATE ${quote(dialect,table.name)} SET ${quote(dialect,'id')} = ${dialect==='postgresql'?'$1':'?'} WHERE ${quote(dialect,'id')} = ${dialect==='postgresql'?'$2':'?'}`,...[newId,oldId]);
  if(Number(result)!==1)throw new Error(`Строка ${table.name} изменилась; миграция остановлена без сохранения.`);
}

export async function applyEntityIdMigration(db:any,planToken:string) {
  const dialect=getDialect();
  return db.$transaction(async(tx:any)=>{
    const fresh=await previewEntityIdMigration(tx);
    if(fresh.planToken!==planToken) throw Object.assign(new Error('Предпросмотр устарел. Сформируйте новый план.'),{status:409});
    if(fresh.blockers.length) throw Object.assign(new Error('Есть блокеры; применить весь план нельзя.'),{status:409,blockers:fresh.blockers});
    const tables=await schema(tx,dialect); const byName=new Map(tables.map(t=>[t.name,t]));
    const oldMap=new Map(fresh.mappings.map(m=>[m.oldId,m.newId]));
    // Резервируем счётчики штатными генераторами внутри транзакции и сверяем ID с предпросмотром.
    for(const m of fresh.mappings.filter(x=>x.model==='Project')) {
      const projectId=fresh.scopeByOldId[m.oldId];
      const allocated=await nextProjectId(tx,{inTransaction:true});
      if(allocated!==m.newId) throw new Error('Счётчик ID изменился после предпросмотра. Сформируйте новый план.');
    }
    // Сначала переносим проекты, чтобы генераторы сущностей увидели новые projectId.
    for(const m of fresh.mappings.filter(x=>x.model==='Project')) {const t=byName.get('Project')!;await movePrimaryKey(tx,dialect,t,m.oldId,m.newId);}
    for(const m of fresh.mappings.filter(x=>x.model!=='Project')) {
      const projectId=fresh.scopeByOldId[m.oldId];
      const allocated=m.model==='DictionaryItem'?await nextFieldId(tx,projectId,isRootItem(fresh,m.oldId),{inTransaction:true}):await nextProjectEntityId(tx,projectId,({EquipmentSystem:'SYS',Monoblock:'MB',ComponentElement:'EQ',Tag:'TAG',Dictionary:'DICT'} as any)[m.model],{inTransaction:true});
      if(allocated!==m.newId)throw Object.assign(new Error('Счётчик ID изменился после предпросмотра. Сформируйте новый план.'),{status:409});
    }
    for(const m of fresh.mappings.filter(x=>x.model!=='Project')) {const t=byName.get(MODEL_TABLES.find(x=>x[0]===m.model)![1])!;await movePrimaryKey(tx,dialect,t,m.oldId,m.newId);}
    // Применяем скалярные ссылки без FK и поддержанные JSON-поля из свежего снимка.
    for(const snap of fresh.before) if(snap.after) {const currentKey={...snap.before};for(const k of snap.key)currentKey[k]=oldMap.get(String(snap.before[k]))||snap.before[k];await updateRow(tx,dialect,byName.get(snap.table)!,snap.key,currentKey,snap.after);}
    // Сохраняем изменённые строки для безопасной отмены; счётчики и журнал сюда не входят.
    const after:Snapshot[]=[];
    const replacements=new Map(fresh.mappings.map(m=>[m.oldId,m.newId]));
    for(const snap of fresh.before) {
      const table=byName.get(snap.table)!;
      const afterKey=snap.key.map(k=>replacements.get(String(snap.before[k]))||snap.before[k]);
      const where=snap.key.map((k,i)=>`${quote(dialect,k)} = ${dialect==='postgresql'?`$${i+1}`:'?'}`).join(' AND '); const vals=afterKey;
      const fields=[...new Set([...snap.key,...Object.keys(snap.after||{})])];
      const rows=await tx.$queryRawUnsafe(`SELECT ${fields.map(c=>quote(dialect,c)).join(',')} FROM ${quote(dialect,snap.table)} WHERE ${where}`,...vals);
      if(rows.length!==1) throw new Error(`Не удалось сохранить точный снимок для отмены: ${snap.table}.`);
      after.push({...snap,after:rows[0]});
    }
    const scopeProjectIds=[...new Set(fresh.mappings.map(m=>oldMap.get(m.projectId)||m.projectId))];
    const afterInventory=fresh.identityInventory.filter(row=>scopeProjectIds.includes(oldMap.get(row.projectId)||row.projectId)).map(row=>({...row,id:oldMap.get(row.id)||row.id,projectId:oldMap.get(row.projectId)||row.projectId})).sort((a,b)=>a.model.localeCompare(b.model)||a.projectId.localeCompare(b.projectId)||a.id.localeCompare(b.id));
    const journal={version:1,migrationId:fresh.migrationId,mappings:fresh.mappings,counts:fresh.counts,before:fresh.before,after,afterInventory,scopeProjectIds,createdAt:new Date().toISOString(),state:'APPLIED'};
    await tx.appSetting.create({data:{id:`${JOURNAL_PREFIX}${fresh.migrationId}`,key:`${JOURNAL_PREFIX}${fresh.migrationId}`,userId:null,value:JSON.stringify(journal)}});
    return {migrationId:fresh.migrationId,mappings:fresh.mappings,counts:fresh.counts,undoAvailable:true};
  },{isolationLevel:'Serializable',timeout:120000});
}

function isRootItem(plan:IdMigrationPlan,id:string) { return plan.rootItemIds.includes(id); }

export async function undoEntityIdMigration(db:any,migrationId:string) {
  const dialect=getDialect();
  return db.$transaction(async(tx:any)=>{
    const journalRow=await tx.appSetting.findUnique({where:{id:`${JOURNAL_PREFIX}${migrationId}`}});
    if(!journalRow||journalRow.key!==`${JOURNAL_PREFIX}${migrationId}`||journalRow.userId!==null)throw Object.assign(new Error('Миграция не найдена.'),{status:404});
    const journal=JSON.parse(journalRow.value); if(journal.state!=='APPLIED')throw new Error('Эту миграцию уже отменили.');
    const tables=await schema(tx,dialect);const byName=new Map(tables.map((t:any)=>[t.name,t]));
    const currentInventory=identityInventory(await targetRows(tx,journal.scopeProjectIds||[]));
    if(hash(currentInventory)!==hash(journal.afterInventory||[]))throw Object.assign(new Error('Состав сущностей проекта изменился после переноса; сначала согласуйте новые или удалённые сущности.'),{status:409});
    await rejectNewReferences(tx,dialect,tables,journal);
    // Перед отменой проверяем снимок каждой изменённой строки.
    for(const snap of journal.after as Snapshot[]) {
      const projection=[...new Set([...snap.key,...Object.keys(snap.after||{})])];
      const rows=await tx.$queryRawUnsafe(`SELECT ${projection.map(c=>quote(dialect,c)).join(',')} FROM ${quote(dialect,snap.table)} WHERE ${keyWhere(snap.key,snap.after||{},dialect)}`,...snap.key.map(k=>snap.after?.[k]));
      const current=rows[0];
      const expected=Object.fromEntries(projection.map(c=>[c,snap.after?.[c]]));
      if(!current||hash(current)!==hash(expected))throw Object.assign(new Error('Данные изменились после переноса; отмена невозможна без потери правок.'),{status:409});
    }
    // Сначала возвращаем PK; ON UPDATE CASCADE восстановит значения FK.
    for(const m of [...journal.mappings].reverse()) { const table=MODEL_TABLES.find(x=>x[0]===m.model)![1];const t=byName.get(table)!;await movePrimaryKey(tx,dialect,t,m.newId,m.oldId); }
    const reverse=new Map<string,string>(journal.mappings.map((m:any)=>[m.newId,m.oldId]));
    for(const snap of journal.before as Snapshot[]) {
      const after=snap.after||snap.before;
      const restoredCurrent={...after};
      snap.key.forEach(k=>{restoredCurrent[k]=reverse.get(String(after[k]))||after[k];});
      await updateRow(tx,dialect,byName.get(snap.table)!,snap.key,restoredCurrent,snap.before);
    }
    const next={...journal,state:'UNDONE',undoneAt:new Date().toISOString()}; await tx.appSetting.update({where:{id:journalRow.id},data:{value:JSON.stringify(next)}});
    return {migrationId,mappings:journal.mappings,restored:true};
  },{isolationLevel:'Serializable',timeout:120000});
}

export async function entityIdMigrationHistory(db:any) {
  const rows=await db.appSetting.findMany({where:{key:{startsWith:JOURNAL_PREFIX},userId:null},orderBy:{updatedAt:'asc'}});
  return rows.map((r:any)=>{const j=parseJson(r.value)||{};return {migrationId:j.migrationId,state:j.state,createdAt:j.createdAt,undoneAt:j.undoneAt,undoAvailable:j.state==='APPLIED',mappings:j.mappings||[],projectIds:[...new Set((j.mappings||[]).map((m:any)=>m.projectId))],counts:j.counts||{}};}).sort((a:any,b:any)=>String(a.createdAt).localeCompare(String(b.createdAt)));
}
