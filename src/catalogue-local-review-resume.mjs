import {sourceProductName} from './missing-product-creation.mjs';
// This particular error is thrown by minimalProductInput before the durable
// product-creation claim and before any provider write. Never reset another
// error or a claimed creation merely because its title is now available.
export async function resumeLocalCatalogueReview(db,id){
 return db.transaction(async tx=>{
  const o=(await tx.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[id])).rows[0];
  if(!o||o.archived||o.suspension?.active||o.suspension?.erplainCancellation||o.partial_mode||o.erp_live?.bc?.id||o.erp_live?.bl?.id||o.label_status==='cancelled'||o.tracking_status!=='not_shipped')return false;
  const j=(await tx.query('SELECT * FROM erp_live_jobs WHERE order_id=$1 FOR UPDATE',[id])).rows[0];
  const m=j?.status==='review'&&/^Création produit · Nom du produit manquant ou invalide : ([^\r\n]+)$/.exec(j.error||'');if(!m)return false;
  const sku=m[1],lines=(await tx.query('SELECT * FROM lines WHERE order_id=$1',[id])).rows;
  if(!lines.some(l=>(l.target_sku||l.source_sku)===sku&&sourceProductName(l)))return false;
  const table=(await tx.query("SELECT to_regclass('erplain_product_creation_attempts') AS name")).rows[0]?.name;
  if(table&&(await tx.query('SELECT sku FROM erplain_product_creation_attempts WHERE sku=$1',[sku])).rows.length)return false;
  await tx.query("INSERT INTO audit(user_email,action,detail) VALUES('system','erplain.local_catalogue_review_resumed',$1)",[JSON.stringify({orderId:id,sku,originalError:j.error,originalUpdatedAt:j.updated_at,providerReplay:false})]);
  await tx.query("UPDATE erp_live_jobs SET status='pending',error=null,updated_at=now() WHERE order_id=$1",[id]);
  return true;
 });
}
