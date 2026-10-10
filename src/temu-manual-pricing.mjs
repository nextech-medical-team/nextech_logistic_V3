import {createHash} from 'node:crypto';
import {temuFixedVat,temuCountryAmounts,validateManualVat} from './temu-country-vat.mjs';
export const pricingFingerprint=lines=>createHash('sha256').update(JSON.stringify(lines.map(l=>[String(l.id),String(l.source_line),String(l.quantity)]).sort())).digest('hex');
export function manualPricingData(order,lines,input){
 if(temuFixedVat(order)!==25)throw Error('Saisie réservée aux commandes TEMU Croatie et Suède');
 const vatRate=validateManualVat(input.vatRate);
 if(!['EUR','SEK'].includes(input.currency))throw Error('Choisir EUR ou SEK');
 if(!Array.isArray(input.priceLines)||input.priceLines.length!==lines.length)throw Error('Toutes les lignes doivent être renseignées');
 const number=(v,label,integer=false)=>{const s=String(v??'').trim().replace(',','.');if(!/^\d+(?:\.\d{1,2})?$/.test(s))throw Error(label+' invalide');const n=Number(s);if(!Number.isFinite(n)||n<0||n>10000000||integer&&(!Number.isInteger(n)||n===0))throw Error(label+' invalide');return n;};
 const m=amount=>({amount,currency:input.currency}),seen=new Set();let total=0;
 const rows=input.priceLines.map(p=>{const l=lines.find(l=>String(l.id)===String(p.id));if(!l||seen.has(String(p.id)))throw Error('Ligne absente ou dupliquée');seen.add(String(p.id));
 const quantity=number(p.quantity,'Quantité',true),unit=Math.round(number(p.unitPriceHt,'Prix unitaire HT')*100),shipping=Math.round(number(p.shippingTtc,'Livraison TTC')*100);const base=unit*quantity;if(!Number.isSafeInteger(base)||base>1000000000)throw Error('Montant de ligne trop élevé');total+=base;
 return {orderSn:String(l.source_payload?.temuOrderSn||l.source_line),quantity,basePrice:m(base),unitBasePrice:m(unit),shipAmountTotalTaxIncl:m(shipping)};});
 if(new Set(rows.map(l=>l.orderSn)).size!==rows.length)throw Error('Références des lignes ambiguës');
 return temuCountryAmounts(order,{parentOrderMap:{parentOrderSn:order.reference,basePriceTotal:m(total)},orderList:rows},{vatRate});
}
export async function saveManualPricing(db,id,input,jobId){
 return db.transaction(async tx=>{
 const o=(await tx.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!o)throw Error('Commande absente');
 if(o.erp_live?.bc?.id||o.erp_live?.bl?.id||o.partial_mode||o.archived||['cancelled','shipped','delivered','in_transit','delivered_simulated'].includes(o.tracking_status))throw Error('Commande déjà engagée : les prix et quantités ne peuvent plus être modifiés ici');
 if([true,'true',1,'1'].includes(o.source_payload?.cancelled)||o.cancelled_at||o.source_payload?.cancelled_at||Object.hasOwn(o.source_payload||{},'marketplacePendingCorrection')||/commande.*annulée/i.test(o.issue||''))throw Error('Commande annulée ou modifiée sur la plateforme : vérifier avant correction');
 if(/creating|publishing|uncertain/i.test(o.erp_live?.phase||'')||o.erp_live?.stockCreationAttemptedAt||o.erp_live?.stockDocument)throw Error('Création Erplain à vérifier : rapprocher les documents avant de modifier les prix ou quantités');
 if((await tx.query("SELECT 1 FROM erp_live_jobs WHERE order_id=$1 AND status='processing' UNION ALL SELECT 1 FROM carrier_jobs WHERE order_id=$1 AND (status NOT IN ('failed','superseded') OR result IS NOT NULL OR jsonb_array_length(tracking)>0) UNION ALL SELECT 1 FROM temu_label_jobs WHERE reference=$2 AND (attempt_id IS NOT NULL OR jsonb_array_length(packages)>0 OR status IN ('queued','purchasing','buying','uncertain','complete'))",[id,o.reference])).rows.length)throw Error('Traitement ou étiquette existante : vérifier avant de modifier les quantités');
 const lines=(await tx.query('SELECT * FROM lines WHERE order_id=$1 ORDER BY source_line',[id])).rows;
 if(input.priceFingerprint!==pricingFingerprint(lines))throw Error('Les quantités ont changé : fermer puis rouvrir cette fenêtre');
 const data=manualPricingData(o,lines,input),at=new Date().toISOString();
 for(const p of input.priceLines){const l=lines.find(l=>String(l.id)===String(p.id)),q=Number(String(p.quantity).replace(',','.'));const target=l.target_quantity==null?null:Number(l.target_quantity)*q/Number(l.quantity);if(target!==null&&(!Number.isFinite(target)||target<=0))throw Error('Quantité Erplain incohérente');
 await tx.query('UPDATE lines SET quantity=$2,target_quantity=$3 WHERE id=$1',[l.id,q,target]);}
 const manual={data,vatRate:data.v3VatPolicy.rate,at,jobId,source:'manual_user',original:o.source_payload?.temuManualPricing?.original||lines.map(l=>({id:l.id,quantity:l.quantity}))};
 await tx.query("UPDATE orders SET source_payload=source_payload||$2::jsonb,resolution_pending_resume=true WHERE id=$1",[id,JSON.stringify({temuManualPricing:manual})]);
 await tx.query("INSERT INTO audit(user_email,action,detail) VALUES('system','temu.manual_pricing.saved',$1)",[JSON.stringify({orderId:id,resolutionJob:jobId,currency:input.currency,vat:data.v3VatPolicy.rate,before:lines.map(l=>({id:l.id,quantity:l.quantity})),after:input.priceLines})]);
 return {message:'Prix et quantités enregistrés pour cette commande. TVA '+data.v3VatPolicy.rate+' % enregistrée.'};
 });
}
