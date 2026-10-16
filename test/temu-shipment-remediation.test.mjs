import test from 'node:test';
import assert from 'node:assert/strict';
import {readConfirmedTemuShipments,temuLabelFailure} from '../src/temu-shipment-remediation.mjs';
import {initializeTemuShipping,temuShipping} from '../src/temu-shipping.mjs';
import {createTemuExcelTestDatabase} from './support/temu-excel-db.mjs';
import {readTemuOrderDiagnostic} from '../src/temu-order-diagnostic.mjs';
const reference='PO-053-123',packages=['PK-123'];
const detail={parentOrderMap:{parentOrderSn:reference,parentOrderStatus:4},orderList:[{orderSn:'L1',skuId:10},{orderSn:'L2',skuId:11}]};
function api(overrides={}){return {async read(type,input){
 if(type==='bg.logistics.shipment.result.get')return {packageInfoResultList:[]};
 if(type==='bg.order.detail.v2.get')return structuredClone(detail);
 if(type==='bg.logistics.shipment.v2.get')return {shipmentInfoDTO:[{packageSn:'PK-123',packageDeliveryType:1,carrierName:'FedEx',trackingNumber:'TRACK123',skuId:input.orderSn==='L1'?10:11,...overrides}]};
 throw Error('Unexpected read '+type);
 },buy(){assert.fail('No purchase');},pdf(){assert.fail('No generated or downloaded PDF');}};}
test('reconcile per-line responses into one confirmed package without inventing label/payment proof',async()=>{
 const p=await readConfirmedTemuShipments(api(),reference,packages);
 assert.equal(p.length,1);assert.equal(p[0].orderSendInfoList.length,2);assert.equal(p[0].shippingLabelStatus,undefined);assert.equal(p[0].amount,undefined);
});
for(const overrides of [{trackingNumber:''},{packageDeliveryType:2},{packageSn:'PK-999'},{skuId:99},{parentOrderSn:'PO-999'},{orderSn:'OTHER'},{subPackageShipmentInfoList:[{}]}])test('reject unproven or incompatible shipment '+JSON.stringify(overrides),async()=>assert.equal(await readConfirmedTemuShipments(api(overrides),reference,packages),null));
test('empty result cannot hide an active refusal on an unshipped order',async()=>{
 const a=api(),read=a.read;a.read=async(t,i)=>t==='bg.order.detail.v2.get'?{...detail,parentOrderMap:{...detail.parentOrderMap,parentOrderStatus:2}}:read(t,i);
 assert.equal(await readConfirmedTemuShipments(a,reference,packages),null);
});
test('fallback archives the historical refusal, preserves attempt and never buys or fabricates PDF',async t=>{
 const db=await createTemuExcelTestDatabase();t.after(()=>db.close());await initializeTemuShipping(db);
 const old={packageInfoResultList:[{packageSn:'PK-123',shippingLabelStatus:2,failReasonText:'shipping address contains non-English characters'}]};
 await db.query("INSERT INTO temu_label_jobs(reference,status,attempt_id,packages,result,error) VALUES($1,'shipment_error','attempt',$2,$3,'old refusal')",[reference,JSON.stringify(packages),JSON.stringify(old)]);
 const service=temuShipping(db,api());
 for(let i=0;i<2;i++){const j=await service.recover(reference);assert.equal(j.status,'document_unavailable');assert.equal(j.attempt_id,'attempt');assert.match(j.error,/Expédition confirmée/);assert.deepEqual(j.result.previousLabelResult.result,old);assert.equal(j.result.packageInfoResultList[0].trackingNumber,'TRACK123');}
 assert.equal((await db.query('SELECT count(*) n FROM temu_label_documents')).rows[0].n,0);
 await assert.rejects(service.prepare(reference),/tentative ou expédition/);
});
test('address refusal gets actionable diagnosis; unrelated dimensions refusal stays distinct',()=>{
 const raw='Unable to create order. The shipping address contains non-English characters.';
 assert.match(temuLabelFailure(raw),/Étiquette refusée : adresse.*aucun rachat/);
 assert.ok(temuLabelFailure(raw).endsWith('Motif exact TEMU : '+raw));
 assert.match(temuLabelFailure(raw),/ne précise pas ici quel caractère/);
 assert.match(temuLabelFailure('Invalid parcel dimensions'),/Étiquette refusée : Invalid parcel dimensions/);
});

test('destination refusal is distinguished only when TEMU explicitly identifies coverage',()=>{
 const raw='Destination is not supported by this shipping service.';
 assert.match(temuLabelFailure(raw),/destination non desservie/);
 assert.ok(temuLabelFailure(raw).endsWith(raw));
 assert.doesNotMatch(temuLabelFailure('Unable to create order. Check address.'),/non desservie/);
 const long='Provider detail: '+ 'x'.repeat(400)+' END';
 assert.ok(temuLabelFailure(long).endsWith(long),'original reason must not be truncated');
});
test('read-only diagnostic reports confirmed shipment, never a label or payment inferred from tracking',async()=>{
 const diagnostic=await readTemuOrderDiagnostic(api(),reference,{knownPackages:packages});
 assert.deepEqual(diagnostic.errors,[]);assert.match(diagnostic.message,/confirme l’expédition/);assert.doesNotMatch(diagnostic.message,/étiquette\(s\) disponible/);
 assert.match(diagnostic.message,/paiement ne sont pas prouvés/);
});
