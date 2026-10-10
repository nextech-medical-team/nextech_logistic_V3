import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {readFile} from 'node:fs/promises';import {createHash} from 'node:crypto';
const run=promisify(execFile);
// Read-only Linux probe. Deployment/stop remains exclusively Section7.
// requiredUnits must come from the verified current writer inventory.
export function systemdWriterPauseProbe({requiredUnits,execute=run,read=readFile}={}){
 if(!Array.isArray(requiredUnits)||!requiredUnits.length||new Set(requiredUnits).size!==requiredUnits.length||requiredUnits.some(u=>!/^nextech-[a-z0-9-]+\.service$/.test(u)))throw Error('Inventaire writers explicite requis');
 return async()=>{
  const states=[];const boot=String(await read('/proc/sys/kernel/random/boot_id','utf8')).trim();
  if(!/^[a-f0-9-]{36}$/.test(boot))throw Error('Identité démarrage inconnue');
  for(const unit of [...requiredUnits].sort()){
   const {stdout}=await execute('systemctl',['show',unit,'--no-pager','--property=Id,LoadState,ActiveState,SubState,MainPID,Result,ControlGroup,InactiveEnterTimestampMonotonic'],{timeout:10000,maxBuffer:65536});
   const p=Object.fromEntries(String(stdout).trim().split('\n').map(l=>{const i=l.indexOf('=');return [l.slice(0,i),l.slice(i+1)];}));
   if(p.Id!==unit||p.LoadState!=='loaded'||p.ActiveState!=='inactive'||p.SubState!=='dead'||p.MainPID!=='0'||p.Result!=='success'||!/^\d+$/.test(p.InactiveEnterTimestampMonotonic||'')||p.InactiveEnterTimestampMonotonic==='0')return {paused:false,reason:'Service non arrêté proprement: '+unit};
   if(p.ControlGroup){if(!/^\/[a-zA-Z0-9_./@:-]+$/.test(p.ControlGroup)||p.ControlGroup.split('/').includes('..'))throw Error('Cgroup non valide');const processes=String(await read('/sys/fs/cgroup'+p.ControlGroup+'/cgroup.procs','utf8')).trim();if(processes)return {paused:false,reason:'Processus writer encore présents: '+unit};}
   states.push({unit,stoppedAt:p.InactiveEnterTimestampMonotonic});
  }
  return {paused:true,epoch:createHash('sha256').update(JSON.stringify({boot,states})).digest('hex'),checkedAt:new Date().toISOString(),requiredUnits:[...requiredUnits],scope:'Declared current writer units only; inventory completeness requires Section7 evidence'};
 };
}
