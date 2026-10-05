'use strict';
const http=require('node:http'), https=require('node:https'), fs=require('node:fs');
const crypto=require('node:crypto');
function serverUrl(input) {
  let u; try { u=new URL(String(input)); } catch {throw new Error('Локальное соединение Flux настроено некорректно. Переподключитесь к общей БД.');}
  if (u.username || u.password || u.search || u.hash || u.pathname !== '/') throw new Error('Локальное соединение Flux настроено некорректно.');
  const local=['localhost','127.0.0.1','[::1]'].includes(u.hostname);
  if (!local || !['http:','https:'].includes(u.protocol)) throw new Error('Обработчик Flux Owner должен работать только на этом компьютере. Подключитесь к общей БД.');
  return u.origin;
}
function endpointAllowed(route, method) {
  return (method==='GET'&&route==='/api/owner/challenge') || (method==='POST'&&['/api/owner/login','/api/updates','/api/license/revocations'].includes(route)) ||
    (method==='POST'&&/^\/api\/updates\/upload\?version=\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?$/.test(route)) ||
    (method==='DELETE'&&/^\/api\/updates\/\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?$/.test(route));
}
function challengeMessage(packet, origin, now=Date.now()) {
  if (!packet || typeof packet.nonce!=='string' || packet.nonce.length<16 || packet.nonce.length>200 || typeof packet.message!=='string' || packet.message.length>4000)
    throw new Error('Сервер вернул некорректный запрос входа.');
  let j; try {j=JSON.parse(packet.message);}catch {throw new Error('Сервер вернул некорректный запрос входа.');}
  if (j.purpose!=='flux-owner-login'||j.version!==1||j.nonce!==packet.nonce||j.expiresAt!==packet.expiresAt||j.origin!==origin||typeof j.installationId!=='string'||!j.installationId||j.installationId.length>200||!Number.isSafeInteger(j.expiresAt)||j.expiresAt<=now||j.expiresAt>now+65000)
    throw new Error('Запрос входа не относится к выбранному серверу или уже истёк.');
  return packet.message;
}
function request(origin, route, {method='GET',body=null,token='',file=null,signal=null,onProgress=()=>{},onEvent=()=>{},onStage=()=>{},idleTimeoutMs=null,deadlineMs=null}={}) {
  origin=serverUrl(origin); if(!endpointAllowed(route,method)) return Promise.reject(new Error('Маршрут недоступен программе владельца.'));
  const u=new URL(route,origin), transport=u.protocol==='https:'?https:http;
  const json=body===null?null:Buffer.from(JSON.stringify(body));
  return new Promise((resolve,reject)=> {
    let source, settled=false, deadline, phase=file?'upload':'request';
    const started=Date.now();
    const notify=(event,details={})=>{try{onEvent(event,{method,route,phase,elapsedMs:Date.now()-started,...details});}catch{}};
    const idle=idleTimeoutMs??(file?600000:method==='POST'&&route==='/api/updates'?120000:30000);
    const total=deadlineMs??(file?1200000:method==='POST'&&route==='/api/updates'?180000:60000);
    if(!Number.isFinite(idle)||idle<=0||!Number.isFinite(total)||total<=0)return reject(new Error('Некорректное время ожидания операции.'));
    notify('request.start',{size:file?.size??json?.length??0,idleTimeoutMs:idle,deadlineMs:total});
    const finish=(err,data)=>{if(settled)return;settled=true;clearTimeout(deadline);notify(err?'request.failure':'request.complete',err?{error:err}:{}); signal?.removeEventListener('abort',abort);source?.destroy();err?reject(err):resolve(data);};
    const headers={Accept:'application/json'};
    if(token)headers.Authorization=`Bearer ${token}`;
    if(json){headers['Content-Type']='application/json';headers['Content-Length']=json.length;}
    if(file){headers['Content-Type']='application/octet-stream';headers['Content-Length']=file.size;}
    const req=transport.request(u,{method,headers,timeout:idle,rejectUnauthorized:true},res=>{
      phase='response';notify('request.response',{statusCode:res.statusCode});
      let chunks=[],size=0;
      if(res.statusCode>=300&&res.statusCode<400){res.resume();return finish(new Error('Перенаправление сервера отклонено: проверьте адрес подключения.'));}
      res.on('data',chunk=>{size+=chunk.length;if(size>2*1024*1024){req.destroy();finish(new Error('Ответ сервера превышает 2 МБ.'));}else chunks.push(chunk);});
      res.on('end',()=>{let result;try{result=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return finish(new Error('Сервер вернул неверный формат ответа.'));}
        if(res.statusCode<200||res.statusCode>=300){const error=new Error(typeof result.error==='string'?result.error.slice(0,1000):`Ошибка локального обработчика ${res.statusCode}.`);error.code=`FLUX_HTTP_${res.statusCode}`;error.stage=phase;return finish(error);}finish(null,result);});
      res.on('error',finish);res.on('aborted',()=>{const error=new Error('Локальный обработчик Flux прервал ответ. Переподключитесь к общей БД.');error.code='FLUX_RESPONSE_ABORTED';finish(error);});
    });
    const abort=()=>req.destroy(new Error('Операция отменена.'));
    req.on('timeout',()=>{const error=new Error(phase==='database-write'?'Запись обновления в общую БД не завершилась вовремя. Проверьте журнал и подключение; не выпускайте ту же версию повторно, пока не проверите результат.':'Локальный обработчик Flux не ответил вовремя. Проверьте подключение к общей БД и сохраните журнал.');error.code='FLUX_REQUEST_IDLE_TIMEOUT';error.stage=phase;req.destroy(error);});
    req.on('error',error=>{if(['ECONNREFUSED','ECONNRESET','EPIPE'].includes(error.code)){const wrapped=new Error('Локальный обработчик Flux недоступен или завершился. Переподключитесь к общей БД и сохраните журнал.');wrapped.code=error.code;wrapped.stage=phase;wrapped.cause=error;finish(wrapped);}else finish(error);});
    deadline=setTimeout(()=>{const error=new Error('Превышено полное время операции. Проверьте её результат в БД перед повтором и сохраните журнал.');error.code='FLUX_REQUEST_DEADLINE';error.stage=phase;req.destroy(error);},total);
    req.once('finish',()=>{if(file){phase='database-write';notify('upload.transferred',{size:file.size});try{onStage('Запись и проверка обновления в общей БД');}catch{}}});
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)return abort();
    if(file){let sent=0;source=fs.createReadStream(file.path);source.on('error',e=>req.destroy(e));source.on('data',chunk=>{sent+=chunk.length;onProgress(sent,file.size);});source.pipe(req);}else req.end(json||undefined);
  });
}
function signChallenge(packet,origin,privatePem) {return crypto.sign(null,Buffer.from(challengeMessage(packet,origin)),crypto.createPrivateKey(privatePem)).toString('base64');}
module.exports={serverUrl,challengeMessage,signChallenge,request,endpointAllowed};
