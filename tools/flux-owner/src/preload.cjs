const {contextBridge,ipcRenderer}=require('electron');
const allowed=['exportDiagnostics','reportDiagnostic','state','chooseSetupFolder','setup','verifySetup','showSetupFolder','openBackup','create','unlock','lock','import','export','changePassword','publicExport','publicApply','request','issue','revoke','copy','chooseExe','signUpdate','connect','disconnect','publish','publishRevocation','withdrawUpdate','cancel','openFlux'];
contextBridge.exposeInMainWorld('owner',Object.freeze({
  exportDiagnostics:()=>ipcRenderer.invoke('owner:action','exportDiagnostics'),
  reportDiagnostic:(event,details={})=>ipcRenderer.invoke('owner:action','reportDiagnostic',{event,details}),
  call:(action,args={})=>allowed.includes(action)?ipcRenderer.invoke('owner:action',action,args):Promise.resolve({ok:false,error:'Недоступное действие.'}),
  onProgress:fn=>{if(typeof fn!=='function')return()=>{};const listener=(_e,data)=>fn(data);ipcRenderer.on('owner:progress',listener);return()=>ipcRenderer.removeListener('owner:progress',listener);},
  onDisconnected:fn=>{if(typeof fn!=='function')return()=>{};const listener=()=>fn();ipcRenderer.on('owner:disconnected',listener);return()=>ipcRenderer.removeListener('owner:disconnected',listener);},
  onLocked:fn=>{if(typeof fn!=='function')return()=>{};const listener=()=>fn();ipcRenderer.on('owner:locked',listener);return()=>ipcRenderer.removeListener('owner:locked',listener);}
}));
