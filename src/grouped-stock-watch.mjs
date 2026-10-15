import {createHash} from 'node:crypto';
import {withErplainTraffic} from './erplain-admission.mjs';
import {withErplainOrigin} from './erplain-request-observation.mjs';
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const stamp=value=>new Date(value).getTime();

export async function initializeGroupedStockWatch(db){
 await db.exec(`CREATE TABLE IF NOT EXISTS stock_resume_requirements(order_id text PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,fingerprint text NOT NULL,bc_id text NOT NULL,variant_ids jsonb NOT NULL,stock_signature text,checked_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE IF NOT EXISTS stock_resume_resources(variant_id text PRIMARY KEY,next_at timestamptz NOT NULL DEFAULT now(),state jsonb NOT NULL DEFAULT '{}',checked_at timestamptz,last_error text);
 CREATE INDEX IF NOT EXISTS stock_resume_resources_due ON stock_resume_resources(next_at);`);
}

// A resource read is only a wake-up signal. It never authorizes a BL or
// estimates another order's reservation. The existing BL guard stays fresh.
export function stockSignal(variant,id){
 if(String(variant?.id)!==String(id)||!Array.isArray(variant.stock_levels?.data)||variant.stock_levels.paginatorInfo?.hasMorePages!==false)throw Error('Surveillance stock : réponse produit incomplète');
 const locations=new Set();
 return {id:String(id),active:variant.active,track_inventory:variant.track_inventory,levels:variant.stock_levels.data.map(l=>{
  if(!l.location?.id||![l.available,l.on_hand].every(x=>(typeof x==='number'||typeof x==='string'&&x.trim()!=='')&&Number.isFinite(Number(x))))throw Error('Surveillance stock : emplacement non vérifiable');
  if(locations.has(String(l.location.id)))throw Error('Surveillance stock : emplacement ambigu');locations.add(String(l.location.id));
  return [String(l.location.id),Number(l.available),Number(l.on_hand)];
 }).sort((a,b)=>a[0].localeCompare(b[0]))};
}
export function stockSignature(ids,resources){
 const values=ids.map(id=>resources.get(String(id)));
 if(values.some(x=>!x?.checked_at||x.last_error))return null;
 // JSONB is free to reorder object keys between processes/restarts.
 return digest(values.map(x=>[x.state.id,x.state.active,x.state.track_inventory,x.state.levels]));
}

export async function groupedStockPass(db,api,{candidateSql,allowed,fingerprint,readOrder,verified,enqueue,record,enabled,now=()=>Date.now(),maxDocuments=20,maxVariants=100}){
 const native=" AND o.erp_live->>'bcReservationPolicy'='erplain_bc_bl' AND coalesce(o.source_payload->>'erplainImported','false')<>'true' AND o.channel<>'tender'";
 const candidates=(await db.query(candidateSql+native+` ORDER BY o.processing_priority_at ASC NULLS LAST,e.updated_at,o.id`)).rows.filter(allowed);
 if(!candidates.length)return;
 const ids=candidates.map(o=>o.id),requirements=new Map((await db.query('SELECT * FROM stock_resume_requirements WHERE order_id=ANY($1::text[])',[ids])).rows.map(x=>[x.order_id,x]));
 const watches=new Map((await db.query('SELECT * FROM stock_resume_watch WHERE order_id=ANY($1::text[])',[ids])).rows.map(x=>[x.order_id,x]));
 const resources=new Map((await db.query(`SELECT * FROM stock_resume_resources WHERE variant_id IN (SELECT jsonb_array_elements_text(variant_ids) FROM stock_resume_requirements WHERE order_id=ANY($1::text[]))`,[ids])).rows.map(x=>[x.variant_id,x]));
 let documents=0;
 // Poll each variant once per minute, irrespective of the number of orders.
 const variantIds=[...new Set([...requirements.values()].flatMap(x=>x.variant_ids))];
 const due=variantIds.filter(id=>!resources.has(id)||stamp(resources.get(id).next_at)<=now()).sort((a,b)=>(stamp(resources.get(a)?.next_at||0)-stamp(resources.get(b)?.next_at||0))||a.localeCompare(b)).slice(0,maxVariants);
 if(due.length)await api.verify();
 for(let start=0;start<due.length&&enabled();start+=5){
  const batch=due.slice(start,start+5);
  for(const id of batch)await db.query(`INSERT INTO stock_resume_resources(variant_id,next_at) VALUES($1,now()+interval '1 minute') ON CONFLICT(variant_id) DO UPDATE SET next_at=excluded.next_at`,[id]);
  const query='query V3WaitingStock('+batch.map((_,i)=>'$v'+i+':ID!').join(',')+'){'+batch.map((_,i)=>`v${i}:Variant(id:$v${i}){id active track_inventory stock_levels(first:100){data{location{id} available on_hand} paginatorInfo{hasMorePages}}}`).join(' ')+'}';
  let result;
  try{result=await withErplainOrigin('stock-watch-poll',()=>withErplainTraffic('background',()=>api.request(query,Object.fromEntries(batch.map((id,i)=>['v'+i,id])))));}catch(error){for(const id of batch){await db.query('UPDATE stock_resume_resources SET last_error=$2 WHERE variant_id=$1',[id,error.message]);resources.set(id,{last_error:error.message});}break;}
  for(let i=0;i<batch.length;i++){
   const id=batch[i];try{const state=stockSignal(result['v'+i],id);await db.query('UPDATE stock_resume_resources SET state=$2,checked_at=now(),last_error=null WHERE variant_id=$1',[id,JSON.stringify(state)]);resources.set(id,{state,checked_at:new Date(now()).toISOString(),last_error:null});}
   catch(error){await db.query('UPDATE stock_resume_resources SET last_error=$2 WHERE variant_id=$1',[id,error.message]);resources.set(id,{last_error:error.message});}
  }
 }
 // Unknown requirements get a bounded bootstrap. Known orders wake on a new
 // resource signal, input change, or the 15-minute reservation safety check.
 // Candidate order is the application's explicit processing priority. Walk
 // past unchanged records so a fixed first page cannot starve the remainder.
 const ordered=candidates.map(o=>({o,r:requirements.get(o.id),w:watches.get(o.id)}));
 for(const {o,r,w} of ordered){
  if(!enabled()||documents>=maxDocuments)break;
  const fp=await fingerprint(o),changed=r&&r.fingerprint!==fp,signature=r?stockSignature(r.variant_ids,resources):null;
  const signalChanged=!!signature&&signature!==r?.stock_signature;
  const dueCatchup=!r||now()-stamp(r.checked_at)>=15*60000;
  if(!changed&&!signalChanged&&!dueCatchup)continue;
  if(w?.outcome==='checking'&&stamp(w.next_at)>now())continue;
  // A changed signal bypasses shortage backoff, never a technical/provider
  // cooldown. Otherwise one failed read would retry every worker tick.
  if(Number(w?.failures)>0&&stamp(w.next_at)>now())continue;
  if(!changed&&!signalChanged&&w?.last_error&&stamp(w.next_at)>now())continue;
  documents++;
  await db.query(`INSERT INTO stock_resume_watch(order_id,next_at,outcome) VALUES($1,now()+interval '5 minutes','checking') ON CONFLICT(order_id) DO UPDATE SET next_at=excluded.next_at,outcome='checking'`,[o.id]);
  try{
   const snapshot=await readOrder(o);
   const variants=[...new Set((snapshot?.line_items||[]).filter(l=>l.variant?.id).map(l=>String(l.variant.id)))].sort();
   // Validate identity and completeness before registering requirements, even
   // when quantity availability is expected to fail.
   if(String(snapshot?.id)!==String(o.erp_live.bc.id)||snapshot.status!=='active'||snapshot.update_stock!==true||!variants.length||!Array.isArray(snapshot.shipping_orders?.data)||snapshot.shipping_orders.paginatorInfo?.hasMorePages!==false||snapshot.shipping_orders.data.length)throw Error('Surveillance stock : BC ou BL à rapprocher');
   await db.query(`INSERT INTO stock_resume_requirements(order_id,fingerprint,bc_id,variant_ids,stock_signature,checked_at) VALUES($1,$2,$3,$4,$5,now()) ON CONFLICT(order_id) DO UPDATE SET fingerprint=excluded.fingerprint,bc_id=excluded.bc_id,variant_ids=excluded.variant_ids,stock_signature=excluded.stock_signature,checked_at=excluded.checked_at`,[o.id,fp,String(snapshot.id),JSON.stringify(variants),stockSignature(variants,resources)]);
   verified(snapshot,o);
   const queued=await enqueue(o,fp);
   await record(o.id,queued?null:'Commande modifiée ou déjà traitée : relecture différée');
  }catch(error){await record(o.id,error);}
 }
}
