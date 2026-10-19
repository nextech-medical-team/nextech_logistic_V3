import test from 'node:test';import assert from 'node:assert/strict';
import {tenderGlsAddress} from '../src/tender-label-fields.mjs';
import {canRetryFailedCarrier,hasUncertainCarrierHistory} from '../src/carrier-attempt-proof.mjs';
const order=()=>({channel:'tender',reference:'SYNTHETIC',parcel_count:24,parcel_index:24,erplain_label_customer:{label:'CENTRE HOSPITALIER DE READAPTATION REGIONALE'},address:{name:'PHARMACIE CENTRE READAPTATION EXEMPLE',street:'1 RUE EXEMPLE',postal:'75001',country:'FR',phone:'0123456789'},source_payload:{}});
test('four separately wrapped rows fit three GLS rows without losing client, destination or parcel number',()=>{
 const o=order(),before=JSON.stringify(o),a=tenderGlsAddress(o);assert([a.Name1,a.Name2,a.Name3].every(x=>x.length<=35));assert.equal([a.Name1,a.Name2,a.Name3].filter(Boolean).join(' '),o.erplain_label_customer.label+' '+o.address.name+' (24/24)');assert.equal(a.FixedLinePhonenumber,'0123456789');assert.equal(a.Street,'1 RUE EXEMPLE');assert.equal(JSON.stringify(o),before);
});
test('already fitting name fields retain the established exact layout',()=>{
 const o=order();o.erplain_label_customer.label='CLIENT EXEMPLE';o.address.name='PHARMACIE EXEMPLE';o.parcel_count=1;const a=tenderGlsAddress(o);assert.deepEqual([a.Name1,a.Name2,a.Name3],['CLIENT EXEMPLE','PHARMACIE EXEMPLE','']);
});
test('each parcel preserves the complete text and its own index, including address complement',()=>{
 for(const n of [1,9,24]){const o=order();o.parcel_index=n;o.address.street2='BAT A';const a=tenderGlsAddress(o);assert.equal([a.Name1,a.Name2,a.Name3].filter(Boolean).join(' '),o.erplain_label_customer.label+' '+o.address.name+' BAT A ('+n+'/24)');}
});
test('a true overflow, overlong word, invalid telephone or street remains a provider payload error',()=>{
 const long=order();long.address.name='SERVICE PHARMACIE '.repeat(12);assert.throws(()=>tenderGlsAddress(long),/trop longs/);
 const word=order();word.erplain_label_customer.label='A'.repeat(41);assert.throws(()=>tenderGlsAddress(word),/Nom trop long/);
 const phone=order();phone.address.phone='420937';assert.throws(()=>tenderGlsAddress(phone),/téléphone absent ou invalide/);
 const street=order();street.address.street='RUE '.repeat(12);assert.throws(()=>tenderGlsAddress(street),/dépasse 40/);
});
test('a published BL does not require an optional full phone; a provided extension remains printed and no number is invented',()=>{
 const o=order();o.label_bl_id='bl';o.address.phone='420937';const before=JSON.stringify(o),a=tenderGlsAddress(o);assert.equal(a.ContactPerson,'Tél : 420937');assert.equal(a.FixedLinePhonenumber,undefined);assert.equal(a.MobilePhoneNumber,undefined);assert.equal(JSON.stringify(o),before);
 o.address.phone='';const empty=tenderGlsAddress(o);assert.equal(empty.ContactPerson,undefined);assert.equal(empty.FixedLinePhonenumber,undefined);
});
test('a real 36-to-40-character word may use the documented ShipIT capacity without truncation',()=>{
 const o=order();o.erplain_label_customer.label='A'.repeat(36);o.address.name='PHARMACIE';o.parcel_count=1;const a=tenderGlsAddress(o);assert.equal(a.Name1,'A'.repeat(36));assert.equal(a.Name2,'PHARMACIE');assert([a.Name1,a.Name2,a.Name3].every(x=>x.length<=40));
});
const localError='Appels d’offres · Client et destinataire dépassent les trois lignes GLS : vérifier avant création';
const job=()=>({order_id:'o',status:'failed',attempts:1,error:localError,tracking:[],result:null,reference:null,creation_id:'allocated-at-queue',creation_started_at:null,failure_phase:null});
test('an exact first legacy name refusal may be resumed manually, preserving the job and archive',async()=>{
 const j=job(),before=JSON.stringify(j),db={query:async()=>({rows:[]})};assert.equal(await canRetryFailedCarrier(db,j,{manualRequest:true}),true);assert.equal(await canRetryFailedCarrier(db,j),false);assert.equal(JSON.stringify(j),before);
 const archive={id:'history',job:j,documents:false},snapshot=JSON.stringify(archive);assert.equal(await hasUncertainCarrierHistory({query:async()=>({rows:[archive]})},'o',{manualRequest:true}),false);assert.equal(JSON.stringify(archive),snapshot);
});
test('a provider call, result, reference, tracking, document or repeated unknown attempt never becomes retryable',async()=>{
 const db={query:async()=>({rows:[]})};for(const change of [j=>j.creation_started_at='2026-10-14T00:00:00Z',j=>j.result={ok:true},j=>j.reference='carrier-id',j=>j.tracking=['track'],j=>j.attempts=2,j=>j.error='GLS HTTP 400',j=>j.failure_phase='creation']){const j=job();change(j);assert.equal(await canRetryFailedCarrier(db,j,{manualRequest:true}),false);}
 assert.equal(await hasUncertainCarrierHistory({query:async()=>({rows:[{job:job(),documents:true}]})},'o',{manualRequest:true}),true);
});
