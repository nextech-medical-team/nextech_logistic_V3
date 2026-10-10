import {money,amountFields} from './temu-margin-data.mjs';

// Erplain equivalents replace entire preparation lines. Keep TEMU receipts at
// order level: pairing replaced SKUs by position or quantity would invent links.
export function equivalentReceipts(amounts,detail,reference){
 const fail=message=>{throw Error('TEMU · '+message);};
 if(!Array.isArray(detail?.orderList)||!detail.orderList.length)fail('Détail original requis pour rapprocher les recettes');
 const originals=detail.orderList,rows=amounts?.orderList;
 if(!Array.isArray(rows)||rows.length!==originals.length)fail('Montants incomplets pour les lignes originales');
 if(new Set(originals.map(l=>l.orderSn)).size!==originals.length||originals.some(l=>!l.orderSn))fail('Identifiants des lignes originales ambigus');
 let revenue=0,credit=0;
 for(const l of originals){
  const f=amountFields(amounts,reference,{quantity:l.quantity,source_line:l.orderSn});
  const price=f['Prix de base total'],shipping=f["Total de l'expédition (hors taxes)"];
  if(!price.endsWith(' EUR')||!shipping?.endsWith(' EUR'))fail('Recettes des équivalents : montants et contribution en EUR requis');
  revenue+=Number(price.slice(0,-4));credit+=Number(shipping.slice(0,-4));
 }
 const parent=money(amounts.parentOrderMap.basePriceTotal);
 if(!parent||parent.currency!=='EUR'||Math.abs(parent.amount-revenue)>0.02)fail('Total commande différent des montants des lignes');
 return {revenue,credit};
}

export function applyEquivalentReceipts(result,totals){
 result.revenue=totals.revenue;result.credit=totals.credit;
 result.totalReceipts=totals.revenue+totals.credit;
 result.creditSource='API TEMU · contribution livraison HT des lignes originales';
 result.issues=(result.issues||[]).filter(m=>m!=='Montant de vente absent ou invalide');
 for(const l of result.lines||[]){l.issues=(l.issues||[]).filter(m=>m!=='Montant de vente absent ou invalide');l.revenue=null;l.profit=null;}
 result.warnings=(result.warnings||[]).filter(m=>!m.includes('Contribution absente du rapport'));
 result.warnings.push('Produits remplacés dans Erplain : recettes TEMU rapprochées au niveau de la commande, coûts des produits préparés. Bénéfice non ventilé par ligne.');
 const costs=['purchase','supplierShipping','shipping','fees','other'].map(k=>result[k]);
 result.complete=!result.issues.length&&costs.every(v=>Number.isFinite(v)&&v>=0);
 if(result.complete){result.totalCosts=costs.reduce((a,b)=>a+b,0);result.profit=result.totalReceipts-result.totalCosts;result.marginTotalReceipts=result.totalReceipts>0?result.profit/result.totalReceipts:null;const net=result.totalCosts-result.credit;result.markup=net>0?result.profit/net:null;}
}
