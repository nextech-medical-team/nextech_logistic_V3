import {shippingProductLines} from './erplain-shipping-lines.mjs';
import {randomUUID} from 'node:crypto';
import {erplainAccount} from './erplain-accounts.mjs';
import {resolveWeight} from './erplain-readonly.mjs';
import {withShipmentLock} from './shipment-lock.mjs';
export function equivalentService(db,directory,{api=erplainAccount(directory,'live')}={}){
 return {async refresh(id){return withShipmentLock(async()=>{
 const o=(await db.query('SELECT * FROM orders WHERE id=$1',[id])).rows[0];if(!o?.erp_live?.bc?.id)throw new Error('Un BC Erplain LIVE existant est requis');
 const job=(await db.query('SELECT status FROM erp_live_jobs WHERE order_id=$1',[id])).rows[0];if(['processing','pending'].includes(job?.status))throw new Error('Traitement Erplain en cours : réessayer après sa fin');
 const c=(await db.query('SELECT * FROM carrier_jobs WHERE order_id=$1',[id])).rows[0];
 if(o.erp_live.bl||o.partial_mode||o.erp_live.phase?.startsWith('creating')||o.erp_live.phase?.startsWith('publishing')||c&&(c.result||['ready','creating','review','awaiting_pdf','pending'].includes(c.status)))throw new Error('Documents existants ou traitement incertain : actualisation des équivalents interdite pour éviter une double livraison');
 await api.verify();const {Order:b}=await api.request('query V3EquivalentRead($id:ID!){Order(id:$id){id label update_stock shipping_orders(first:1){data{id}} line_items{id type quantity price location{id} variant{id sku weight_amount weight_unit active track_inventory product{id active}}}}}',{id:String(o.erp_live.bc.id)});
 if(!b||String(b.id)!==String(o.erp_live.bc.id)||b.shipping_orders?.data?.length)throw new Error('BC absent ou BL déjà créé dans Erplain LIVE');
 if(b.update_stock!==false)throw new Error('Politique de stock du BC incompatible');
 const rows=shippingProductLines(b.line_items);if(!rows?.length||rows.some(l=>!l.variant?.sku||!l.location?.id||!(Number(l.quantity)>0)))throw new Error('Lignes BC incomplètes');
 let weight=0;for(const l of rows)weight+=resolveWeight(rows.map(x=>x.variant).filter((v,i,a)=>a.findIndex(x=>String(x.id)===String(v.id))===i),l.variant.sku).weightKg*Number(l.quantity);
 const original=(await db.query('SELECT * FROM lines WHERE order_id=$1',[id])).rows;
 await db.transaction(async tx=>{
 const previous=o.erp_live.equivalentOriginalLines||original;const state={...o.erp_live,equivalentOriginalLines:previous,equivalentItems:rows.map(l=>({variant:{id:String(l.variant.id)},location:{id:String(l.location.id)},quantity:Number(l.quantity),price:Number(l.price)||0,description:l.variant.sku})),equivalentRefreshedAt:new Date().toISOString(),phase:'bc_created'};
 await tx.query('DELETE FROM lines WHERE order_id=$1',[id]);
 for(const l of rows){await tx.query('INSERT INTO lines(id,order_id,source_line,source_sku,quantity,target_sku,target_quantity,source_payload) VALUES($1,$2,$3,$4,$5,$4,$5,$6)',[randomUUID(),id,'ERP:'+l.id,l.variant.sku,Number(l.quantity),JSON.stringify({origin:'erplain_live_bc',bcLineId:l.id})]);const w=resolveWeight([l.variant],l.variant.sku);await tx.query("INSERT INTO products(sku,weight_kg,origin,updated_at) VALUES($1,$2,'erplain_live_equivalent',now()) ON CONFLICT(sku) DO UPDATE SET weight_kg=excluded.weight_kg,origin=excluded.origin,updated_at=now()",[l.variant.sku,w.weightKg]);await tx.query('DELETE FROM catalog_results WHERE sku=$1',[l.variant.sku]);}
 await tx.query("UPDATE orders SET erp_live=$2,label_status='pending',weight_kg=$3,simulation=false,issue=null WHERE id=$1",[id,JSON.stringify(state),weight]);
 if(c)await tx.query("DELETE FROM carrier_jobs WHERE order_id=$1 AND status='failed' AND result IS NULL",[id]);
 await tx.query("UPDATE jobs SET status='pending',available_at=now(),error=null WHERE order_id=$1 AND kind='label'",[id]);
 await tx.query("INSERT INTO erp_live_jobs(order_id,status) VALUES($1,'pending') ON CONFLICT(order_id) DO UPDATE SET status='pending',error=null,updated_at=now()",[id]);
 });return {message:'BC LIVE relu, équivalents et poids actualisés. Contrôle du stock avant BL ; étiquette mise en file LIVE.',lines:rows.map(l=>({sku:l.variant.sku,quantity:l.quantity})),weight};
 });}};
}
