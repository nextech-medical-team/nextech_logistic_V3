import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import path from 'node:path';
import {validateCancelledImportScope,readCancelledImportScope} from '../src/cancelled-import-scope.mjs';
const scope={orderIds:['00000000-0000-4000-8000-000000000001'],receiptId:'00000000-0000-4000-8000-000000000002',receivedAt:'2026-10-08T08:22:41.500934Z'};
test('private scope retains exact PostgreSQL microseconds and only validated identifiers',()=>{
 assert.deepEqual(validateCancelledImportScope(scope),scope);
 assert.equal(validateCancelledImportScope(null),null);
 for(const change of [{orderIds:[]},{orderIds:["x') OR true --"]},{receiptId:'anything'},{receivedAt:"2026-10-08'; DELETE FROM orders; --"}])assert.throws(()=>validateCancelledImportScope({...scope,...change}),/invalide/);
});
test('missing private scope stays disabled; malformed configuration is never silently broadened',async()=>{
 const folder=await mkdtemp(path.join(tmpdir(),'nextech-private-scope-'));try{const filename=path.join(folder,'scope.json');assert.equal(readCancelledImportScope(filename),null);await writeFile(filename,JSON.stringify(scope));assert.deepEqual(readCancelledImportScope(filename),scope);await writeFile(filename,'{');assert.throws(()=>readCancelledImportScope(filename),/illisible/);}finally{await rm(folder,{recursive:true,force:true});}
});
