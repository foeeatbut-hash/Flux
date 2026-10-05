'use strict';
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {request}=require('../src/network.cjs');
async function main(){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'flux-owner-network-'));
  const executable=path.join(directory,'fixture.exe');await fs.writeFile(executable,Buffer.alloc(4096));
  let handler;
  const server=http.createServer((req,res)=>handler(req,res));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const upload={method:'POST',file:{path:executable,size:4096},idleTimeoutMs:250,deadlineMs:1000};
  try{
    const events=[],stages=[];
    handler=(req,res)=>{req.resume();req.on('end',()=>setTimeout(()=>res.end(JSON.stringify({shared:true})),60));};
    const response=await request(origin,'/api/updates/upload?version=1.0.0',{...upload,onEvent:(event,details)=>events.push({event,...details}),onStage:stage=>stages.push(stage)});
    assert.equal(response.shared,true);assert.ok(events.some(event=>event.event==='upload.transferred'));assert.ok(events.some(event=>event.event==='request.complete'));assert.equal(stages.length,1);assert.ok(events[0].idleTimeoutMs>0);
    // Ожидание записи БД после отправки EXE получает свой код и этап.
    handler=req=>req.resume();
    await assert.rejects(request(origin,'/api/updates/upload?version=1.0.0',{...upload,idleTimeoutMs:30}),error=>error.code==='FLUX_REQUEST_IDLE_TIMEOUT'&&error.stage==='database-write');
    // Полное время ограничено даже при приходящих данных ответа.
    handler=(req,res)=>{req.resume();res.write(' ');const timer=setInterval(()=>res.write(' '),10);res.on('close',()=>clearInterval(timer));};
    await assert.rejects(request(origin,'/api/owner/challenge',{idleTimeoutMs:250,deadlineMs:60}),error=>error.code==='FLUX_REQUEST_DEADLINE');
    handler=(req,res)=>{req.resume();res.writeHead(302,{Location:'https://example.invalid'});res.end();};
    await assert.rejects(request(origin,'/api/owner/challenge'),/Перенаправление/);
    handler=(req,res)=>{req.resume();res.end('not json');};
    await assert.rejects(request(origin,'/api/owner/challenge'),/формат/);
    handler=(req,res)=>{req.resume();res.writeHead(503);res.end(JSON.stringify({error:'База обновлений недоступна'}));};
    await assert.rejects(request(origin,'/api/updates',{method:'POST',body:{version:'1.0.0'}}),/База обновлений/);
    handler=req=>req.resume();const controller=new AbortController();const pending=request(origin,'/api/owner/challenge',{signal:controller.signal});controller.abort();await assert.rejects(pending,/отменена/);
    await assert.rejects(request(origin,'/api/not-owner'),/Маршрут/);
    assert.throws(()=>request('http://external.invalid','/api/owner/challenge'),/этом компьютере/);
    console.log('Flux Owner network: delayed database confirmation, phase timeouts, total deadline, cancellation, response validation and local-only boundary passed.');
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(directory,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
