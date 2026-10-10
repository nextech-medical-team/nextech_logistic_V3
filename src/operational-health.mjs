export function assessOperationalHealth({workers=[],now=Date.now(),backupAt,disk,httpOk,mode='hosted'}){
 const checks=[],required=mode==='hosted'?['web','worker']:['all'];
 for(const role of required){const candidates=workers.filter(w=>w.role===role),active=candidates.filter(w=>{const age=now-Date.parse(w.heartbeat);return Number.isFinite(age)&&age>=-30000&&age<=30000&&!w.state?.stopping;});
  checks.push({name:'process-'+role,ok:active.length>0});
  checks.push({name:'tasks-'+role,ok:active.length>0&&active.every(w=>(w.state?.tasks||[]).every(t=>!t.error))});
 }
 const backupAge=now-Date.parse(backupAt);checks.push({name:'backup',ok:Number.isFinite(backupAge)&&backupAge>=-30000&&backupAge<=2*60*60*1000});
 checks.push({name:'disk',ok:!!disk&&Number.isFinite(disk.free)&&Number.isFinite(disk.total)&&disk.total>0&&disk.free>=10*1024**3&&disk.free/disk.total>=.1});
 checks.push({name:'http',ok:httpOk===true});
 return {ok:checks.every(c=>c.ok),checks};
}
