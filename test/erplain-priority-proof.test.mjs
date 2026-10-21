import test from 'node:test';
import assert from 'node:assert/strict';
import {assertErplainGrantSpacing} from '../scripts/erplain-priority-proof.mjs';

const grant=(start,at=0)=>({grantedAtUs:String(start),nextAllowedUs:String(BigInt(start)+100000n),at});
test('SQL spacing proof ignores delayed and reordered Node return/IPC timestamps',()=>{
 const a=grant(1700000000000000n,300),b=grant(1700000000100000n,305),c=grant(1700000000200000n,290);
 assert.deepEqual(assertErplainGrantSpacing([c,b,a],100),[a,b,c]);
});
test('SQL proof rejects a real short interval even when client return spacing looks valid',()=>{
 assert.throws(()=>assertErplainGrantSpacing([grant(1700000000000000n,0),grant(1700000000099999n,200)],100),/shared spacing.*99999us/);
});
test('SQL proof rejects missing evidence and an altered quota interval',()=>{
 assert.throws(()=>assertErplainGrantSpacing([{at:Date.now()}],100),/missing PostgreSQL/);
 assert.throws(()=>assertErplainGrantSpacing([{grantedAtUs:'1000000',nextAllowedUs:'1060000'}],100),/SQL interval/);
});
