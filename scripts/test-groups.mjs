import {spawnSync} from 'node:child_process';

// PGlite fixtures are memory/CPU intensive. Do not size their concurrency from
// the host's CPU count: the build may share a much smaller server CPU quota.
export function runTestGroups(groups,{concurrency=2,timeoutMs=300_000,log=console.log}={}){
 for(const [index,args] of groups.entries()){
  const files=args.filter(arg=>!arg.startsWith('--'));
  const label=`[tests ${index+1}/${groups.length}]`;
  log(`${label} START concurrency=${concurrency} timeout=${timeoutMs}ms ${files.join(' ')}`);
  const started=Date.now();
  // A timed-out fixture may still own a timer/socket. Once Node has reported
  // the completed/failed tests, release the runner rather than waiting forever.
  const result=spawnSync(process.execPath,[`--test-concurrency=${concurrency}`,`--test-timeout=${timeoutMs}`,'--test-force-exit','--test-reporter=spec',...args],{stdio:'inherit'});
  if(result.error||result.signal||result.status!==0){
   log(`${label} FAIL after ${Date.now()-started}ms (${result.error?.code||result.signal||result.status}) ${files.join(' ')}`);
   return result.status||1;
  }
  log(`${label} PASS after ${Date.now()-started}ms`);
 }
 return 0;
}
