import test from 'node:test';import assert from 'node:assert/strict';import {PGlite} from '@electric-sql/pglite';
import {resumeRetiredReservationReviews,reservationReviewEligible,retiredReservationEquation} from '../src/retired-reservation-review.mjs';
const error='BC · Quantités réservées non confirmées · SKU TEST : commandées 50, réservées 0, expédiées 0';
const order={id:'good',reference:'TEST',channel:'amazon',error,erp_live:{bc:{id:1,update_stock:true},bcReservationPolicy:'erplain_bc_bl',phase:'bc_created'}};
for(const [name,patch] of Object.entries({suspended:{suspension:{active:true}},held:{resolution_pending_resume:true},partial:{partial_mode:true},archived:{archived:true},shipped:{tracking_status:'shipped'},tender:{channel:'tender'},source:{source_payload:{marketplacePendingCorrection:{}}},bl:{erp_live:{...order.erp_live,bl:{id:2}}},uncertain:{erp_live:{...order.erp_live,mappingAlignmentAttempt:{status:'uncertain'}}},stock:{erp_live:{...order.erp_live,stockCreationAttemptedAt:'today'}},stockUncertain:{erp_live:{...order.erp_live,stockCreationOutcome:{kind:'uncertain'}}},phase:{erp_live:{...order.erp_live,phase:'publishing_bl'}},readyLabel:{label_status:'production_ready'},externalLabel:{source_payload:{externalLabel:{active:true}}},cancelledBc:{erp_live:{...order.erp_live,bc:{id:1,status:'cancelled'}}},otherError:{error:'Stock insuffisant'}}))test('retired equation recovery preserves '+name,()=>assert.equal(reservationReviewEligible({...order,...patch}),false));
test('equation recovery classifier excludes composite and unrelated refusals',()=>{assert.equal(retiredReservationEquation(error),true);assert.equal(retiredReservationEquation(error+' ; Écriture incertaine'),false);assert.equal(retiredReservationEquation('BL bloqué — stock insuffisant'),false);});
test('provider pause leaves every job untouched',async()=>{assert.equal(await resumeRetiredReservationReviews({query:()=>assert.fail()},{quotaDelay:async()=>1000}),0);});
test('SQL recovery rereads existing BC only; keeps identities, labels and other reviews',async()=>{
 const db=new PGlite();await db.waitReady;
 try{
 await db.exec(`CREATE TABLE orders(id text PRIMARY KEY,reference text,channel text,archived boolean DEFAULT false,partial_mode boolean DEFAULT false,resolution_pending_resume boolean DEFAULT false,suspension jsonb DEFAULT '{}',source_payload jsonb DEFAULT '{}',tracking_status text,label_status text,erp_live jsonb,issue text);
 CREATE TABLE erp_live_jobs(order_id text,status text,error text,updated_at timestamptz);
 CREATE TABLE resolution_jobs(id text,order_id text,status text,stage text,error text,result jsonb,updated_at timestamptz);CREATE TABLE correction_jobs(order_id text,status text);`);
 const modes=['good','bl-existing','wrong-id','cancelled-bc','stock-policy','incomplete','race','active-correction','new-review'];
 for(const id of modes){await db.query('INSERT INTO orders(id,reference,channel,erp_live,issue) VALUES($1,$1,\'amazon\',$2,$3)',[id,JSON.stringify(order.erp_live),error]);await db.query("INSERT INTO erp_live_jobs VALUES($1,'review',$2,'2026-10-15T01:00:00Z')",[id,error]);await db.query("INSERT INTO resolution_jobs VALUES($1,$1,'review','Erplain à compléter',$2,'{}','2026-10-15T00:00:00Z')",[id,error]);}
 await db.exec("INSERT INTO correction_jobs VALUES('active-correction','checking');UPDATE resolution_jobs SET updated_at='2026-10-15T02:00:00Z' WHERE id='new-review'");
 const calls=[],api={};
 // Bind each provider response to the selected local row without altering its query.
 const nativeQuery=db.query.bind(db);let selected=[];const wrapper={query:async(q,v)=>{const result=await nativeQuery(q,v);if(q.startsWith('SELECT o.*,e.error,e.updated_at'))selected=result.rows.map(x=>x.id);return result;},transaction:fn=>db.transaction(fn)};
 api.request=async(q,v)=>{assert.match(q,/^query /);calls.push(q);const id=selected.shift();const bc={id:1,status:'active',update_stock:true,line_items:[{type:'normal',quantity:50,shipped_quantity:0,reserved_quantity:0,variant:{id:2,track_inventory:true}}],shipping_orders:{data:[],paginatorInfo:{hasMorePages:false}}};if(id==='wrong-id')bc.id=3;if(id==='cancelled-bc')bc.status='cancelled';if(id==='stock-policy')bc.update_stock=false;if(id==='bl-existing')bc.shipping_orders.data=[{id:5,status:'pending'}];if(id==='incomplete')bc.shipping_orders.paginatorInfo.hasMorePages=true;if(id==='race')await db.query("UPDATE orders SET suspension='{\"active\":true}' WHERE id='race'");return {Order:bc};};
 assert.equal(await resumeRetiredReservationReviews(wrapper,api),2);
 const jobs=(await db.query('SELECT * FROM erp_live_jobs ORDER BY order_id')).rows;assert.deepEqual(jobs.filter(x=>x.status==='pending').map(x=>x.order_id),['good','new-review']);
 const good=(await db.query("SELECT * FROM orders WHERE id='good'")).rows[0];assert.equal(good.erp_live.bc.id,1);assert.equal(good.erp_live.bl,undefined);assert.equal(good.erp_live.reservationEquationRetired.previousError,error);assert.equal(good.issue,null);
 assert.equal((await db.query("SELECT error FROM resolution_jobs WHERE id='good'")).rows[0].error,null);assert.equal((await db.query("SELECT error FROM resolution_jobs WHERE id='new-review'")).rows[0].error,error);
 assert.equal(calls.length,9);
 }finally{await db.close();}
});
