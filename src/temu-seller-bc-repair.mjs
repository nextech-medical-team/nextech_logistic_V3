// Run by the publication owner after deployment. Default is a fresh dry run.
// No label purchase is issued here. A newly corrected price-only historical
// hold continues through the normal ERP resolution worker after fresh proof.
import {queueHistoricalPriceContinuation} from './correction-continuation.mjs';
import {readFile,appendFile,mkdir} from 'node:fs/promises';import {createRequire} from 'node:module';import {createHash} from 'node:crypto';
import {erplainAccount} from '/opt/nextech/current/src/erplain-accounts.mjs';
import {configureApiBudget} from './api-budget.mjs';
import {sellerBcPlan} from './temu-seller-bc-plan.mjs';
import {assertSellerRepairScope} from './temu-seller-repair-scope.mjs';
import {verifySourceCommercialTotals} from './bc-pricing.mjs';
const require=createRequire('/opt/nextech/current/package.json'),{Pool}=require('pg');
const env=await readFile('/etc/nextech/application.env','utf8'),url=env.split(/\r?\n/).find(l=>l.startsWith('DATABASE_URL=')).slice(13).replace(/^["']|["']$/g,'');
const pool=new Pool({connectionString:url}),api=erplainAccount('/var/lib/nextech-live','live'),apply=process.argv.includes('--apply'),one=process.argv.includes('--one');
configureApiBudget({query:(...args)=>pool.query(...args)});
const backupDir='/var/lib/nextech-live/seller-bc-repair-20261008';await mkdir(backupDir,{recursive:true,mode:0o700});
const sha=s=>createHash('sha256').update(s).digest('hex');
const fields='id label status external_reference invoices_count paid_amount total tax_type update_stock currency{label} line_items{id type quantity price tax_amount discount discount_rule_amount ecotax variant{id sku} location{id} tax_codes{id}} shipping_orders(first:100){data{id label status} paginatorInfo{hasMorePages}}';
const readBc=async id=>(await api.request('query SellerRepairRead($id:ID!){Order(id:$id){'+fields+'}}',{id:String(id)})).Order;
const stable=b=>JSON.stringify({...b,total:undefined,line_items:b.line_items.map(l=>({...l,price:undefined,tax_amount:undefined}))});
const audit=async r=>{await appendFile(backupDir+'/repair-results.jsonl',JSON.stringify({...r,at:new Date().toISOString()})+'\n');console.log(JSON.stringify(r));};
async function labels(c,o){return (await c.query("SELECT jsonb_build_object('jobs',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') FROM temu_label_jobs t WHERE reference=$1),'documents',(SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY to_jsonb(d)::text),'[]') FROM temu_label_documents d WHERE reference=$1),'carrier',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY to_jsonb(c)::text),'[]') FROM carrier_jobs c WHERE order_id=$2)) AS snapshot",[o.reference,o.id])).rows[0].snapshot;}
try{
 const live=await readFile('/opt/nextech/current/src/temu-commercial-source.mjs');
 if(apply&&sha(live)!=='7ad6a5975a5b2cd5b5a79cea950b07ed189a252b148028578d28c2f972e2a33a')throw Error('Helper vendeur modifié : revalider le rapprochement avant mutation');
 const {TaxCodes}=await api.request('query SellerRepairTaxes {TaxCodes(first:200){data{id active tax_rates{rate}} paginatorInfo{hasMorePages}}}');if(TaxCodes.paginatorInfo.hasMorePages)throw Error('Catalogue TVA incomplet');
 if(apply){process.env.ERPLAIN_LIVE_WRITES='1';await api.verify();}
 const ids=(await pool.query("SELECT id FROM orders WHERE channel='temu' AND erp_live->'bc'->>'id' IS NOT NULL ORDER BY reference")).rows;let changed=0;
 for(const {id} of ids){const c=await pool.connect();let o,actual;
  try{
   o=(await c.query('SELECT * FROM orders WHERE id=$1',[id])).rows[0];
   await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='5s'");
   for(const key of ['order:'+id,'temu-order:'+o.reference].sort())await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['nextech:'+key]);
   o=(await c.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[id])).rows[0];
   const job=(await c.query('SELECT status,error FROM erp_live_jobs WHERE order_id=$1 FOR UPDATE',[id])).rows[0];
   const busy=(await c.query("SELECT 1 FROM erp_live_jobs WHERE order_id=$1 AND status='processing' UNION ALL SELECT 1 FROM resolution_jobs WHERE order_id=$1 AND status IN ('queued','running','waiting') UNION ALL SELECT 1 FROM correction_jobs WHERE order_id=$1 AND status IN ('queued','applying','checking','waiting')",[id])).rows.length;
   if(busy)throw Error('Traitement actif : correction différée');

   actual=await readBc(o.erp_live.bc.id);assertSellerRepairScope(o,actual);const plan=sellerBcPlan(o,actual,TaxCodes.data);
   if(!apply){await c.query('ROLLBACK');await audit({reference:o.reference,bc:actual.label,action:plan.action,totalBefore:actual.total,source:plan.source,input:plan.input});continue;}
   const beforeLabels=await labels(c,o);let after=actual;
   if(plan.action==='update_prices'){
    await appendFile(backupDir+'/bc-backup-before.jsonl',JSON.stringify({at:new Date().toISOString(),reference:o.reference,actual,pricing:o.erp_live.pricing,input:plan.input,labelHash:sha(JSON.stringify(beforeLabels))})+'\n');
    // Exactly one attempt. On ambiguous API failure, read back before deciding.
    let mutationError;
    try{await api.request('mutation SellerRevenuePrices($id:ID!,$input:OrderInput!){UpdateOrder(id:$id,input:$input){id}}',{id:String(actual.id),input:plan.input});}catch(e){mutationError=e.message;}
    after=await readBc(actual.id);
    if(stable(after)!==stable(actual))throw Error('Structure commerciale ou BL modifié : arrêt du lot');
    try{verifySourceCommercialTotals(after,plan.source);}catch(e){throw Error((mutationError?'Résultat mutation à rapprocher : '+mutationError+' · ':'')+e.message);}
    changed++;
   }
   const confirmed=verifySourceCommercialTotals(after,plan.source),afterLabels=await labels(c,o);
   if(JSON.stringify(beforeLabels)!==JSON.stringify(afterLabels))throw Error('État étiquettes modifié concurremment : arrêt du lot');
   const pricing={...o.erp_live.pricing,...plan.source,status:'verified',confirmed,error:null,verifiedAt:new Date().toISOString()};
   await c.query("UPDATE orders SET erp_live=jsonb_set(erp_live,'{pricing}',$2::jsonb) WHERE id=$1",[id,JSON.stringify(pricing)]);
   const oldMoney=/^TEMU · (Remises client et TVA à rapprocher|Totaux client source incohérents|Prix client et TVA source incohérents)$/.test(job?.error||'')||/^BC · (Total Erplain|TVA Erplain)/.test(job?.error||'');
   const historicalContinuation=await queueHistoricalPriceContinuation(c,o,job,{action:plan.action,bc:after,pricing});
   const resume=oldMoney&&job.status==='review'&&!o.resolution_pending_resume&&o.erp_live.phase==='bc_created'&&!o.erp_live.bl?.id&&!o.erp_live.stockDocument?.id&&!o.erp_live.stockCreationAttemptedAt&&(!o.issue||o.issue===job.error);
   if(resume){await c.query("UPDATE erp_live_jobs SET status='pending',error=null,updated_at=now() WHERE order_id=$1",[id]);await c.query('UPDATE orders SET issue=null WHERE id=$1',[id]);}

   await c.query("INSERT INTO audit(user_email,action,detail) VALUES('system','temu.seller_revenue_reconciled',$1)",[JSON.stringify({orderId:id,bcId:actual.id,action:plan.action,before:actual.total,after:after.total,source:plan.source.total,labelHash:sha(JSON.stringify(afterLabels)),noShipmentResume:!resume&&!historicalContinuation})]);
   await c.query('COMMIT');await audit({reference:o.reference,bc:actual.label,action:plan.action,before:actual.total,after:after.total,source:plan.source.total,labelsUnchanged:true,resumed:resume,historicalContinuation});
   if(one&&changed)break;
  }catch(e){await c.query('ROLLBACK').catch(()=>{});await audit({reference:o?.reference||id,action:'blocked',error:e.message});if(/arrêt du lot|Résultat mutation|différent du total source/.test(e.message)&&apply)throw e;}
  finally{c.release();}
 }
}finally{await pool.end();}
