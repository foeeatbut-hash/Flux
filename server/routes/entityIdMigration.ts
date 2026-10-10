import type { Express, Request, Response } from 'express';
import { broadcast, getPrisma } from '../context.js';
import { isPrivilegedUser } from '../accessPolicy.js';
import { canSeeProject } from './members.js';
import { applyEntityIdMigration, entityIdMigrationHistory, previewEntityIdMigration, undoEntityIdMigration } from '../entityIdMigration.js';

function admin(req:Request,res:Response) {
  const actor=(req as any).authUser;
  if(!actor?.id){res.status(401).json({error:'Требуется вход'});return false;}
  if(actor.role!=='OWNER'){res.status(403).json({error:'Перенос идентификаторов доступен только владельцу программы'});return false;}
  return true;
}
function fail(res:Response,error:any) { res.status(Number(error?.status)||500).json({error:error?.message||String(error),blockers:error?.blockers||undefined}); }

export function registerEntityIdMigrationRoutes(app:Express) {
  app.post('/api/settings/entity-id-migration/preview',async(req:Request,res:Response)=>{
    try { if(!admin(req,res))return; const plan=await previewEntityIdMigration(getPrisma()); res.json({planToken:plan.planToken,migrationId:plan.migrationId,mappings:plan.mappings,counts:plan.counts,blockers:plan.blockers,projectIds:plan.projectIds}); }
    catch(error:any){fail(res,error);}
  });
  app.post('/api/settings/entity-id-migration/apply',async(req:Request,res:Response)=>{
    try {
      if(!admin(req,res))return;
      const token=String(req.body?.planToken||''); if(!/^[a-f0-9]{64}$/.test(token))return res.status(400).json({error:'Нужен действующий токен предпросмотра'});
      const result=await applyEntityIdMigration(getPrisma(),token);
      broadcast('entity:ids:migrated',{migrationId:result.migrationId,state:'APPLIED'});
      res.json({...result,state:'APPLIED'});
    } catch(error:any){fail(res,error);}
  });
  app.post('/api/settings/entity-id-migration/undo',async(req:Request,res:Response)=>{
    try {
      if(!admin(req,res))return;
      const id=String(req.body?.migrationId||''); if(!/^migration-[a-f0-9]{24}$/.test(id))return res.status(400).json({error:'Нужен migrationId'});
      const result=await undoEntityIdMigration(getPrisma(),id);
      broadcast('entity:ids:migrated',{migrationId:result.migrationId,state:'UNDONE'});
      res.json(result);
    } catch(error:any){fail(res,error);}
  });
  app.get('/api/settings/entity-id-migration/history',async(req:Request,res:Response)=>{
    try {
      const actor=(req as any).authUser;
      if(!actor?.id)return res.status(401).json({error:'Требуется вход'});
      const migrations=await entityIdMigrationHistory(getPrisma());
      const privileged=isPrivilegedUser(actor);
      for(const migration of migrations) {
        const projectMap=new Map<string,string>(migration.mappings.filter((m:any)=>m.model==='Project').map((m:any)=>[m.oldId,m.newId]));
        const visible:string[]=[];
        for(const oldId of migration.projectIds) {
          const currentId=migration.state==='UNDONE'?oldId:(projectMap.get(oldId)||oldId);
          if(await canSeeProject(String(actor.id),currentId,privileged))visible.push(oldId);
        }
        migration.mappings=migration.mappings.filter((m:any)=>visible.includes(m.projectId));
        migration.projectIds=visible;
        if(!privileged)migration.counts={};
      }
      res.json({migrations});
    }
    catch(error:any){fail(res,error);}
  });
}
