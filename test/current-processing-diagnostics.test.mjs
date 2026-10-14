import test from 'node:test';import assert from 'node:assert/strict';import {PGlite} from '@electric-sql/pglite';import {processingRows} from '../src/order-priority.mjs';
const old="TEMU · Import incomplet : coordonnées ou détail indisponibles, reprise après nouvelle lecture TEMU";
const sourceOld='TEMU refuse l’opération : 180020006 The current order status cannot be viewed.';
const reason='TEMU · Autorisation API des montants manquante (3000032) · Boutique à réautoriser';
async function fixture(){const db=new PGlite();await db.waitReady;await db.exec(`
CREATE TABLE orders(id text PRIMARY KEY,reference text,channel text,archived boolean,source_payload jsonb,erp_live jsonb,suspension jsonb,issue text,resolution_pending_resume boolean,processing_priority_at timestamptz,tracking_status text,label_status text,transport_choice text);
CREATE TABLE erp_live_jobs(order_id text,status text,error text,state_since timestamptz,updated_at timestamptz);
CREATE TABLE carrier_jobs(order_id text,status text,error text,state_since timestamptz,updated_at timestamptz,carrier text,stock_override jsonb,attempts integer,manual_bl_request jsonb,creation_id text);
CREATE TABLE resolution_jobs(order_id text,status text,error text,state_since timestamptz,updated_at timestamptz,created_at timestamptz,action text,result jsonb,stage text);
CREATE TABLE temu_label_jobs(reference text,status text,error text,state_since timestamptz,updated_at timestamptz);
CREATE TABLE temu_sync_jobs(reference text,status text,started_at timestamptz,updated_at timestamptz);
CREATE TABLE lines(order_id text,target_sku text);`);const at=new Date(Date.now()-60000).toISOString(),before=new Date(Date.now()-120000).toISOString();
const source={visibilityHold:true,temuCatchupPartial:{currentReason:reason,checkedAt:at,coverage:{detail:true,version:true,consistency:true}}};
await db.query("INSERT INTO orders VALUES('A','PO-TARGET','temu',false,$1,'{}','{}',$2,false,null,'not_shipped','blocked',null)",[source,sourceOld]);
await db.query("INSERT INTO erp_live_jobs VALUES('A','review',$1,$2,$2)",[old,before]);
return {db,at,before};}
for(const mode of ['current partial','independent error','newer error','cancelled','suspended','missing partial','deferred label unread','uncertain label preserved'])test('processing SQL preserves business state and displays '+mode,async()=>{
const {db,at}=await fixture();try{
 if(mode==='independent error')await db.query("UPDATE erp_live_jobs SET error='Stock insuffisant'");
 if(mode==='newer error')await db.query('UPDATE erp_live_jobs SET updated_at=$1',[new Date(Date.parse(at)+1000).toISOString()]);
 if(mode==='cancelled')await db.query("UPDATE orders SET label_status='cancelled'");
 if(mode==='suspended')await db.query("UPDATE orders SET suspension='{"+ '"active":true,"reason":"Validation humaine requise"' +"}'");
 if(mode==='missing partial')await db.query("UPDATE orders SET source_payload='{"+'"visibilityHold":true'+"}'");
 if(mode==='uncertain label preserved'){
  await db.query("UPDATE orders SET label_status='cancelled'");
  await db.query("INSERT INTO temu_label_jobs VALUES('PO-TARGET','uncertain','Achat précédent à rapprocher',$1,$1)",[at]);
 }
 if(mode==='deferred label unread'){
  const deferredReason='Facture · Vérification fiscale en attente';
  await db.exec("ALTER TABLE orders ADD COLUMN invoice_status text; UPDATE orders SET invoice_status='paid'");
  await db.query('UPDATE orders SET issue=$1,source_payload=$2',[deferredReason,{platformChangeReconciliation:{kind:'temu_address_masking',verified:true,addressFrozen:true,labelsPreserved:true,deferredBilling:true,deferredLabelRead:true,deferredReason}}]);
  await db.query("UPDATE erp_live_jobs SET error='Commande modifiée sur la plateforme'");
 }
 const before=JSON.stringify({orders:(await db.query('SELECT * FROM orders')).rows,jobs:(await db.query('SELECT * FROM erp_live_jobs')).rows});
 const rows=await processingRows(db,['A']);assert.equal(rows.length,1);const erp=rows[0].activities.find(x=>x.service==='Erplain');
 assert.equal(erp.reason,mode==='current partial'||mode==='suspended'?reason:mode==='independent error'?'Stock insuffisant':['cancelled','uncertain label preserved'].includes(mode)?null:mode==='deferred label unread'?'Facture · Vérification fiscale en attente':old);
 if(mode==='uncertain label preserved')assert.equal(rows[0].activities.find(x=>x.service==='TEMU').reason,'Achat précédent à rapprocher');
 if(mode==='suspended')assert(rows[0].activities.some(x=>x.reason==='Validation humaine requise'));
 assert.equal(JSON.stringify({orders:(await db.query('SELECT * FROM orders')).rows,jobs:(await db.query('SELECT * FROM erp_live_jobs')).rows}),before);
 assert(!Object.hasOwn(rows[0],'diagnostic_order'),'full order remains internal');
}finally{await db.close();}});
