import test from 'node:test';
import assert from 'node:assert/strict';
import {validateSubstitution} from '../src/stock-substitution.mjs';
import {queueResolutionRequest} from '../src/resolution-request.mjs';
const request=()=>({id:'o',requestId:'r',action:'replace-equivalent',sku:'A',replacementSku:'B',replaceQuantity:1,replacementQuantity:1,scope:'order',confirmEquivalent:true,verifyAndApply:true});
test('direct replacement requires explicit selection and consent; legacy preview remains protected',()=>{
 assert.doesNotThrow(()=>validateSubstitution(request(),true));
 for(const patch of [{confirmEquivalent:false},{verifyAndApply:false},{verifyAndApply:'true'},{replacementQuantity:0},{replacementSku:'A'}])assert.throws(()=>validateSubstitution({...request(),...patch},true));
 const legacy=request();delete legacy.verifyAndApply;assert.throws(()=>validateSubstitution(legacy,true));assert.doesNotThrow(()=>validateSubstitution({...legacy,previewFingerprint:'a'.repeat(64)},true));
});
test('same direct request after durable journal returns original job; changed choices are refused',async()=>{
 const b=request(),previous={id:'job',payload:{...b,previewFingerprint:'a'.repeat(64),substitutionAttempt:{phase:'mutation_started'}}};
 const db={query:async()=>({rows:[previous]}),transaction:()=>assert.fail('must not enqueue another job')};
 assert.deepEqual(await queueResolutionRequest(db,b,{email:'synthetic'}),{id:'job'});
 for(const patch of [{replacementSku:'C'},{replacementQuantity:2},{scope:'permanent'},{confirmEquivalent:false}])await assert.rejects(queueResolutionRequest(db,{...b,...patch},{email:'synthetic'}),/autre intervention/);
});
