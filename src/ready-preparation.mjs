export const readyWeightAllowed=(channel,weight)=>channel==='temu'||Number(weight)>0;
const idle=`NOT EXISTS(SELECT 1 FROM correction_jobs WHERE order_id=orders.id AND status IN ('queued','applying','checking','waiting')) AND NOT EXISTS(SELECT 1 FROM resolution_jobs WHERE order_id=orders.id AND status IN ('queued','running','waiting'))`;
export async function validateReadyPreparation(db,o,stockGate){
 if(!readyWeightAllowed(o.channel,o.weight_kg))return false;
 if(o.resolution_pending_resume&&o.channel!=='temu')return false;
 if(o.channel==='temu'&&o.issue)throw Error('TEMU · Préparation à corriger : '+o.issue);
 await stockGate(db,o);
 if(o.channel==='temu'){
  const current=await db.query(`SELECT id FROM orders WHERE id=$1 AND ${idle}`,[o.id]);
  if(!current.rows.length)throw Error('TEMU · Correction en cours : préparation non finalisée');
  if(o.resolution_pending_resume){
   const saved=await db.query(`UPDATE orders SET resolution_pending_resume=false WHERE id=$1 AND erp_live=$2::jsonb AND source_payload=$3::jsonb AND address=$4::jsonb AND ${idle} RETURNING id`,[o.id,JSON.stringify(o.erp_live),JSON.stringify(o.source_payload),JSON.stringify(o.address)]);
   if(!saved.rows.length)throw Error('TEMU · Commande modifiée pendant la validation : nouveau contrôle requis');
   o.resolution_pending_resume=false;
  }
 }
 return true;
}
