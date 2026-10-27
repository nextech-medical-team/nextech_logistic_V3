import {verifiedExcelCommercial} from './temu-excel-commercial.mjs';
import {temuDestinationVat} from './temu-destination-vat.mjs';
import {money,amountFields} from './temu-margin-data.mjs';

// Erplain equivalents replace entire preparation lines. Keep TEMU receipts at
// order level: pairing replaced SKUs by position or quantity would invent links.
function euroReceipts(totals,currency,profile){
 if(currency==='EUR')return totals;
 if(!profile||profile.c!==currency||typeof profile.fx!=='number'||!Number.isFinite(profile.fx)||profile.fx<=0)throw Error('TEMU · Taux de conversion publié absent ou incompatible pour '+currency);
 return {...totals,revenue:totals.revenue/profile.fx,credit:totals.credit/profile.fx,conversionWarning:'Recettes converties selon le taux du calculateur publié : 1 EUR = '+profile.fx+' '+currency+' ; estimation, pas un taux de règlement.'};
}
export function equivalentReceipts(amounts,detail,reference,profile){
 const fail=message=>{throw Error('TEMU · '+message);};
 if(!Array.isArray(detail?.orderList)||!detail.orderList.length)fail('Détail original requis pour rapprocher les recettes');
 const originals=detail.orderList,rows=amounts?.orderList;
 if(!Array.isArray(rows)||rows.length!==originals.length)fail('Montants incomplets pour les lignes originales');
 if(new Set(originals.map(l=>l.orderSn)).size!==originals.length||originals.some(l=>!l.orderSn))fail('Identifiants des lignes originales ambigus');
 const parent=money(amounts.parentOrderMap?.basePriceTotal);
 if(!parent)fail('Total des recettes absent ou invalide');
 const suffix=' '+parent.currency;
 let revenue=0,credit=0;
 for(const l of originals){
  const f=amountFields(amounts,reference,{quantity:l.quantity,source_line:l.orderSn});
  const price=f['Prix de base total'],shipping=f["Total de l'expédition (hors taxes)"];
  if(!price.endsWith(suffix)||!shipping?.endsWith(suffix))fail('Recettes des équivalents : devises incohérentes');
  revenue+=Number(price.slice(0,-4));credit+=Number(shipping.slice(0,-4));
 }
 if(Math.abs(parent.amount-revenue)>0.02)fail('Total commande différent des montants des lignes');
 return euroReceipts({revenue,credit},parent.currency,profile);
}

// Reconcile the original validated Excel rows, never prices of replacement SKUs.
export function excelEquivalentReceipts(order,lines,profile){
 const amounts=verifiedExcelCommercial(order,lines);
 const {rate}=temuDestinationVat(order);
 let revenue=0,credit=0;
 for(const row of amounts.rows){
  const gross=Math.round((row.net+row.tax)*100),shipping=Math.round((row.shipping+row.shippingTax)*100);
  revenue+=gross-Math.round(gross*rate/(100+rate));
  credit+=shipping-Math.round(shipping*rate/(100+rate));
 }
 return euroReceipts({revenue:revenue/100,credit:credit/100,creditSource:'Rapport Excel TEMU · contribution livraison HT des lignes originales'},amounts.currency,profile);
}

export function applyEquivalentReceipts(result,totals){
 if(![totals?.revenue,totals?.credit].every(v=>Number.isFinite(v)&&v>=0))throw Error('TEMU · Recettes rapprochées absentes ou invalides');
 result.revenue=totals.revenue;result.credit=totals.credit;
 result.totalReceipts=totals.revenue+totals.credit;
 result.creditSource=totals.creditSource||'API TEMU · contribution livraison HT des lignes originales';
 result.issues=(result.issues||[]).filter(m=>!['Montant de vente absent ou invalide','Contribution invalide'].includes(m));
 for(const l of result.lines||[]){l.issues=(l.issues||[]).filter(m=>m!=='Montant de vente absent ou invalide');l.revenue=null;l.profit=null;}
 result.warnings=(result.warnings||[]).filter(m=>!m.includes('Contribution absente du rapport'));
 if(totals.conversionWarning)result.warnings.push(totals.conversionWarning);
 result.warnings.push('Produits remplacés dans Erplain : recettes TEMU rapprochées au niveau de la commande, coûts des produits préparés. Bénéfice non ventilé par ligne.');
 const costs=['purchase','supplierShipping','shipping','fees','other'].map(k=>result[k]);
 result.complete=!result.issues.length&&costs.every(v=>Number.isFinite(v)&&v>=0);
 if(result.complete){result.totalCosts=costs.reduce((a,b)=>a+b,0);result.profit=result.totalReceipts-result.totalCosts;result.marginTotalReceipts=result.totalReceipts>0?result.profit/result.totalReceipts:null;const net=result.totalCosts-result.credit;result.markup=net>0?result.profit/net:null;}
}
