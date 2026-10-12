import test from 'node:test';import assert from 'node:assert/strict';
import {publicationReceipt} from './publication-phase.mjs';
const receipt=()=>({status:'verified',commit:'a'.repeat(40),environmentHash:'b'.repeat(64),controlsRestored:true,backup:'/var/backups/nextech/test',files:{'src/a.mjs':'c'.repeat(64)}});
test('recipe receipt preserves verified publication separately',()=>{const p=receipt();assert.deepEqual(publicationReceipt({publication:p}),p);});
test('missing, unsafe and incomplete receipts fail closed',()=>{
 for(const change of [p=>delete p.commit,p=>p.controlsRestored=false,p=>p.files={},p=>p.files={'../secret':'c'.repeat(64)},p=>p.environmentHash='bad',p=>p.backup='/tmp/test']){const p=receipt();change(p);assert.throws(()=>publicationReceipt({publication:p}));}
 assert.throws(()=>publicationReceipt({}));
});
