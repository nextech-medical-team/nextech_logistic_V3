import {pendingScope,recoveredPendingScope,scopeSnapshot} from './erplain-pending-scope.mjs';
import {bindProduct} from './product-bindings.mjs';
import {shippingProductLines} from './erplain-shipping-lines.mjs';

export function manualImportIssue(document){
 if(!Array.isArray(document.line_items)||!shippingProductLines(document.line_items).length)return 'BC sans ligne produit : ajouter les produits dans Erplain LIVE';
 for(const [index,line] of shippingProductLines(document.line_items).entries()){
  const name=line.variant?.sku||line.label||line.sku||'Ligne '+(index+1);
  if(!line.variant?.sku)return name+' · Produit sans SKU Erplain : vérifier la ligne du BC';
  if(!Number.isFinite(Number(line.quantity))||Number(line.quantity)<=0)return name+' · Quantité invalide dans le BC';
 }
 return null;
}

export const manualOrderFields=`id label external_reference dated_at status total tax_type update_stock currency{id label} customer{id label} account_representative{id label} shipping_address{id label address_1 address_2 postal_code city country phone} line_items{id type label description quantity shipped_quantity price tax_amount reserved_quantity available on_hand location{id} tax_codes{id} variant{id sku active weight_amount weight_unit track_inventory tax_codes{id} product{id label active}}} shipping_orders(first:100){data{id label status update_stock line_items{parent_id type quantity variant{id sku}}} paginatorInfo{hasMorePages}}`;

// Always re-read the existing LIVE BC before entering the common preparation circuit.
export async function refreshManualOrder(db,api,o){
 if(!o.source_payload?.erplainImported)return;
 if(o.source_payload?.erplainValidationHold&&o.source_payload?.erplainValidation!=='approved')throw Error('Commande Erplain en attente de validation manuelle : ouvrir Commandes Erplain à valider');
 if(o.source_payload.account!=='live'||!o.erp_live?.bc?.id)throw Error('Commande Erplain LIVE non associée');
 await api.verify();
 const {Order:bc}=await api.request(`query V3ManualPrepare($id:ID!){Order(id:$id){${manualOrderFields}}}`,{id:String(o.erp_live.bc.id)});
 if(!bc||String(bc.id)!==String(o.erp_live.bc.id)||!bc.line_items?.length)throw Error('API Erplain · BC ou lignes non reçus');
 if(!bc.customer?.id||!bc.currency?.label||bc.total==null||!Number.isFinite(Number(bc.total))||bc.line_items.some(l=>l.tax_amount==null||!Number.isFinite(Number(l.tax_amount))))throw Error('API Erplain · Client, montants, taxes ou devise incomplets');
 const scope=recoveredPendingScope(bc,o),productLines=scope.lines;const importIssue=manualImportIssue({...bc,line_items:productLines});if(importIssue)throw Error(importIssue);
 if(bc.status!=='active')throw Error('BC Erplain '+bc.status+' : activer le BC avant préparation');
 if(!Array.isArray(bc.shipping_orders?.data)||bc.shipping_orders.paginatorInfo?.hasMorePages!==false)throw Error('API Erplain · Liste des BL incomplète');
 if(productLines.some(l=>l.shipped_quantity==null||!Number.isFinite(Number(l.shipped_quantity))||![true,false].includes(l.variant?.track_inventory)))throw Error('API Erplain · Quantités expédiées ou politique de stock non reçues');
 const bls=(scope.scoped?scope.pending:bc.shipping_orders.data).filter(b=>b.status!=='cancelled');
 if(!scope.scoped&&(bls.some(b=>['shipped','delivered'].includes(b.status))||productLines.some(l=>Number(l.shipped_quantity)>0)))throw Error('Commande déjà expédiée en totalité ou en partie : utiliser les livraisons partielles');
 if(bls.length>1)throw Error('Plusieurs BL existants : choisir la livraison à préparer dans la commande');
 if(o.erp_live.bl?.id&&!bls.some(b=>String(b.id)===String(o.erp_live.bl.id)))throw Error('BL associé annulé ou absent : vérifier la livraison existante');
 const local=(await db.query('SELECT * FROM lines WHERE order_id=$1',[o.id])).rows;
 const totals=lines=>{const m=new Map();for(const l of lines){const key=l.variant?.sku||l.target_sku;m.set(key,(m.get(key)||0)+Number(l.variant?l.quantity:l.target_quantity));}return JSON.stringify([...m].sort());};
 if(totals(local)!==totals(productLines))throw Error('BC Erplain modifié : vérifier les produits et quantités de la commande');
 const identities=rows=>JSON.stringify(rows.map(l=>[l.variant?.sku||l.target_sku,String(l.variant?.id||l.source_payload?.erplainVariantId||''),Number(l.variant?l.quantity:l.target_quantity)]).sort());
 if(local.every(l=>l.source_payload?.erplainVariantId)&&identities(local)!==identities(productLines))throw Error('BC Erplain modifié : produit différent du produit validé dans V3');
 const seen=new Map();
 for(const l of productLines){
  const v=l.variant;
  if(!v?.id||!v.sku)throw Error('BC Erplain · SKU absent');
  if(v.active===false||v.product?.active===false)throw Error(v.sku+' · Produit inactif dans Erplain');
  if(!l.location?.id)throw Error(v.sku+' · Emplacement de stock manquant dans le BC');
  if(seen.has(v.sku)&&seen.get(v.sku)!==String(v.id))throw Error(v.sku+' · Plusieurs produits Erplain dans le BC');
  seen.set(v.sku,String(v.id));
  const binding=(await db.query('SELECT live_variant_id FROM erplain_product_bindings WHERE sku=$1',[v.sku])).rows[0];
  if(binding&&binding.live_variant_id!==String(v.id))throw Error(v.sku+' · Produit du BC différent du produit associé');
 }
 for(const l of productLines)await bindProduct(db,l.variant);
 const importedItems=productLines.map(l=>({variant:{id:String(l.variant.id)},location:{id:String(l.location.id)},quantity:Number(l.quantity),price:Number(l.price||0),description:l.variant.sku,tax_codes:(l.tax_codes||l.variant.tax_codes||[]).map(t=>({id:String(t.id)}))}));
 const a=bc.shipping_address||{},address={...o.address,name:a.label||bc.customer?.label||o.recipient,street:[a.address_1,a.address_2].filter(Boolean).join(' '),postal:a.postal_code||'',city:a.city||'',country:a.country||'',phone:a.phone||''};
 const issued=(await db.query("SELECT 1 FROM carrier_jobs WHERE order_id=$1 AND (status IN ('ready','pending','creating','awaiting_pdf','review') OR result IS NOT NULL OR tracking<>'[]'::jsonb)",[o.id])).rows.length;
 if(issued&&['name','street','postal','city','country','phone'].some(k=>String(address[k]||'')!==String(o.address[k]||'')))throw Error('Adresse Erplain modifiée : vérifier l’étiquette existante');
 const erp={...o.erp_live,importedCommercialSource:{total:Number(bc.total),tax:bc.line_items.reduce((n,l)=>n+Number(l.tax_amount),0),currency:bc.currency.label,source:"erplain",checkedAt:new Date().toISOString()},bc:scopeSnapshot(bc,scope),pendingBlIds:scope.pending.map(b=>String(b.id)),customer:bc.customer,importedItems,...(bls[0]?{bl:bls[0]}:{})};
 // A new preparation request must not reuse yesterday's stock validation.
 delete erp.stockCheckedAt;delete erp.verifiedAt;delete erp.labelPreparationFingerprint;
 await db.query("UPDATE orders SET erp_live=$2,address=$3,erplain_refresh=erplain_refresh||$4::jsonb WHERE id=$1",[o.id,JSON.stringify(erp),JSON.stringify(address),JSON.stringify({issues:[],manualCheckedAt:new Date().toISOString()})]);
 o.erp_live=erp;o.address=address;
}

export async function listManualOrders(db,{account='live',search='',page=1}={}){
 if(!['live','source'].includes(account))throw Error('Compte Erplain invalide');
 page=Math.max(1,Math.min(10000,Number(page)||1));
 const where="c.account=$1 AND c.section='orders' AND (c.reference ILIKE $2 OR c.detail->>'label' ILIKE $2)";
 const params=[account,'%'+String(search).slice(0,200)+'%'];
 const total=Number((await db.query('SELECT count(*) n FROM erplain_refresh_cache c WHERE '+where,params)).rows[0].n);
 const rows=(await db.query(`SELECT c.entity_id,c.reference,c.detail,c.missing,c.seen_at,o.id order_id,o.archived,o.label_status,o.tracking_status,o.issue,o.erp_live,o.erplain_refresh,v.status validation_status,r.status operation_status,r.stage,r.error operation_error FROM erplain_refresh_cache c LEFT JOIN orders o ON $1='live' AND o.erp_live->'bc'->>'id'=c.entity_id LEFT JOIN erplain_manual_review v ON $1='live' AND v.bc_id=c.entity_id LEFT JOIN LATERAL (SELECT status,stage,error FROM resolution_jobs WHERE order_id=o.id ORDER BY created_at DESC LIMIT 1) r ON true WHERE ${where} ORDER BY c.seen_at DESC,c.entity_id LIMIT 25 OFFSET $3`,[...params,(page-1)*25])).rows;
 for(const row of rows)if(!row.order_id){
  row.import_issue=manualImportIssue(row.detail);
  if(!row.import_issue){const ref=String(row.detail.external_reference||row.detail.label||'').trim();const existing=(await db.query('SELECT 1 FROM orders WHERE reference=$1 AND archived=false LIMIT 1',[ref])).rows.length;row.import_issue=existing?'Référence déjà utilisée : vérifier le BC associé à la commande':null;}
 }
 return {rows,total,page,pages:Math.max(1,Math.ceil(total/25))};
}
