import test from 'node:test';
import assert from 'node:assert/strict';
import {recordedBcFingerprint,recordedBcPreparationAuthority} from '../src/existing-bc-execution.mjs';
const line=(id,quantity,shipped=0)=>({id,type:'normal',quantity,shipped_quantity:shipped,variant:{id,sku:'SKU-'+id},location:{id:'warehouse'}});
const bc=()=>({id:'bc',status:'active',line_items:[line('already-sent',100,100),line('remaining',900)]});
test('remaining BL preparation keeps the full recorded BC authority and separate shipment scope',()=>{
 const document=bc(),before=structuredClone(document),remaining=document.line_items.slice(1);
 const scopeFingerprint=recordedBcFingerprint({...document,line_items:remaining});
 const proof=recordedBcPreparationAuthority(document);
 assert.notEqual(proof.fingerprint,scopeFingerprint);
 assert.deepEqual(proof,{kind:'recorded_bc',bcId:'bc',fingerprint:recordedBcFingerprint(document)});
 assert.deepEqual(document,before);assert.equal(remaining[0].quantity,900);
});
test('full shipment proof remains identical when all BC lines are prepared',()=>{
 const document=bc();document.line_items[0].shipped_quantity=0;
 assert.equal(recordedBcPreparationAuthority(document).fingerprint,recordedBcFingerprint({...document,line_items:document.line_items}));
});
test('proof still detects changes to shipped lines, pending lines, product, warehouse and BC identity',()=>{
 const document=bc(),proof=recordedBcPreparationAuthority(document);
 for(const mutate of [b=>b.line_items[0].quantity++,b=>b.line_items[1].quantity++,b=>b.line_items[1].variant.id='other',b=>b.line_items[1].location.id='other',b=>b.id='other',b=>b.line_items.pop()]){
  const changed=structuredClone(document);mutate(changed);assert.notEqual(proof.fingerprint,recordedBcFingerprint(changed));
 }
});
test('line reordering and normalized quantities preserve complete BC identity',()=>{
 const document=bc(),proof=recordedBcPreparationAuthority(document);document.line_items.reverse();document.line_items.forEach(l=>l.quantity=String(l.quantity));
 assert.deepEqual(recordedBcPreparationAuthority(document),proof);
});
test('incomplete recorded BC cannot silently get a valid authority',()=>{
 for(const patch of [{line_items:[]},{line_items:[line('x',null)]},{line_items:[{...line('x',1),location:null}]}])assert.throws(()=>recordedBcPreparationAuthority({...bc(),...patch}));
});
