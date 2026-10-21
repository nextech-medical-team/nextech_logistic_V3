import assert from 'node:assert/strict';

// Test evidence only: PostgreSQL's persisted deadline is the authority, rather
// than a Node process's return time after transaction/queue cleanup or IPC.
export function assertErplainGrantSpacing(grants,intervalMs){
 const intervalUs=BigInt(intervalMs)*1000n;
 for(const grant of grants){
  assert.match(grant.grantedAtUs||'',/^\d+$/,'missing PostgreSQL admission timestamp');
  assert.match(grant.nextAllowedUs||'',/^\d+$/,'missing PostgreSQL deadline');
  assert.equal(BigInt(grant.nextAllowedUs)-BigInt(grant.grantedAtUs),intervalUs,'SQL interval must remain unchanged');
 }
 const ordered=[...grants].sort((a,b)=>BigInt(a.grantedAtUs)<BigInt(b.grantedAtUs)?-1:BigInt(a.grantedAtUs)>BigInt(b.grantedAtUs)?1:0);
 for(let i=1;i<ordered.length;i++){
  const gap=BigInt(ordered[i].grantedAtUs)-BigInt(ordered[i-1].grantedAtUs);
  assert.ok(BigInt(ordered[i].grantedAtUs)>=BigInt(ordered[i-1].nextAllowedUs),`shared spacing must hold across pools: SQL grants ${i-1}/${i} are ${gap}us apart, required ${intervalUs}us`);
 }
 return ordered;
}
