import {isTemuExcel,verifiedExcelCommercial} from './temu-excel-commercial.mjs';
import {temuCommercialSource} from './temu-commercial-source.mjs';
import {temuCountryAmounts,temuFixedVat} from './temu-country-vat.mjs';
import {temuLocalService} from './temu-local.mjs';
import {temuApi} from './temu-api.mjs';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
const value=v=>v!==null&&v!==undefined&&String(v).trim()!==''&&Number.isFinite(Number(v));
export function temuPricingIssue(order,lines){
 if(isTemuExcel(order)){try{verifiedExcelCommercial(order,lines);return null;}catch(e){return e.message;}}
 if(order.source_payload?.visibilityHold)return 'TEMU · Import incomplet : coordonnées ou détail indisponibles, reprise après nouvelle lecture TEMU';
 if(!lines.length)return 'TEMU · Import incomplet : aucun article enregistré, reprise après nouvelle lecture TEMU';
 if(order.erp_live?.bc?.id&&order.erp_live?.equivalentOriginalLines?.length)lines=order.erp_live.equivalentOriginalLines;
 let data;try{data=temuCommercialSource(order,temuCountryAmounts(order));}catch(e){return e.message;}
 if(data?.parentOrderMap?.parentOrderSn!==order.reference||!Array.isArray(data.orderList))return 'TEMU · Données financières de la commande absentes';
 if(data.orderList.length!==lines.length)return 'TEMU · Nombre de lignes financières différent de la commande';
 const money=x=>value(x?.amount)&&Number(x.amount)>=0&&/^[A-Z]{3}$/.test(x?.currency||'');
 if(['estimatedRevenue','basePriceTotal','shippingAmountTotal','taxTotal'].some(k=>!money(data.parentOrderMap[k])))return 'TEMU · Totaux financiers incomplets dans la réponse API';
 const seen=new Set();
 for(const l of lines){
  const id=String(l.source_payload?.temuOrderSn||l.source_line),found=data.orderList.filter(x=>String(x.orderSn)===id),sku=l.source_sku||id;
  if(seen.has(id)||found.length!==1)return sku+' · Ligne TEMU à rapprocher';
  seen.add(id);const x=found[0];
  if(Number(x.quantity)!==Number(l.quantity))return sku+' · Quantité TEMU différente de la commande';
  for(const k of ['basePrice','productTaxAmount','shipAmountTotalTaxIncl','shipTaxAmount'])if(!money(x[k]))return sku+' · Montant TEMU absent ou invalide : '+k;
  const rate=v=>value(v)&&Number(v)>=0&&Number(v)<=100000000;
  if(!rate(x.productTaxRate))return sku+' · Taux TVA produit absent de l’API TEMU';
  if((Number(x.shipAmountTotalTaxIncl.amount)||Number(x.shipTaxAmount.amount))&&!rate(x.shipTaxRate))return sku+' · Taux TVA livraison absent de l’API TEMU';
 }
 return null;
}
export function temuPricingComplete(order,lines){return !temuPricingIssue(order,lines);}
export function temuBcPricingLoader(db,directory){
 let service;
 return async reference=>{
  if(!service){const relay=JSON.parse((await readFile(path.join(directory,'temu-read-relay.json'),'utf8')).replace(/^\uFEFF/,''));if(relay.host!=='135.125.79.68')throw Error('TEMU · Relais V2 en lecture obligatoire pour les prix');service=temuLocalService(db,directory,{apiFactory:config=>temuApi(config,{relay})});}
  const result=await service.amounts(reference,{force:true});if(result.error)throw Error(result.error);return result;
 };
}
export async function ensureTemuBcPricing(db,order,lines,refresh){
 if(order.channel!=='temu'||temuPricingComplete(order,lines))return false;
 if(isTemuExcel(order)||order.source_payload?.visibilityHold||!lines.length)throw Error(temuPricingIssue(order,lines));
 try{await refresh(order.reference);}catch(e){throw Error(temuFixedVat(order)!==null?'TEMU · Prix et frais de livraison indisponibles · TVA 25 % automatique'+(String(e.message).includes('3000032')?' · Accès aux montants refusé (3000032)':' · Échec de lecture des montants'):'TEMU · Récupération prix et TVA par API impossible : '+String(e.message).slice(0,350));}
 const latest=(await db.query('SELECT source_payload FROM orders WHERE id=$1',[order.id])).rows[0];
 if(!latest?.source_payload)throw Error('TEMU · Commande absente après récupération API');
 order.source_payload=latest.source_payload;
 const issue=temuPricingIssue(order,lines);if(issue)throw Error(issue);
 return true;
}
