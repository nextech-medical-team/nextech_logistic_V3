import {usesRecordedBc} from './existing-bc-execution.mjs';
export function excelOriginalLines(o,lines){
 if(o.erp_live?.equivalentOriginalLines===undefined)return lines;
 const original=o.erp_live.equivalentOriginalLines;
 if(!Array.isArray(original)||!original.length||original.some(l=>!l.source_line||!l.source_sku||!Number.isSafeInteger(Number(l.quantity))||Number(l.quantity)<=0)||new Set(original.map(l=>String(l.source_line))).size!==original.length)throw Error('Excel : articles d’origine du remplacement absents ou invalides');
 return original;
}
export function verifyExcelTemuDetail(o,lines,detail){
 if(usesRecordedBc(o)){if(detail?.parentOrderMap?.parentOrderSn!==o.reference||!Array.isArray(detail.orderList)||!detail.orderList.length)throw Error('Identité TEMU non reçue');return;}
 lines=excelOriginalLines(o,lines);
 if(detail?.parentOrderMap?.parentOrderSn!==o.reference||!Array.isArray(detail.orderList)||!lines.length||lines.length!==detail.orderList.length)throw Error('Articles différents entre Excel et TEMU');
 const seen=new Set();
 for(const l of lines){
  const id=String(l.source_payload?.temuOrderSn||l.source_line),hits=detail.orderList.filter(x=>String(x.orderSn)===id);
  if(seen.has(id)||hits.length!==1||Number(hits[0].quantity)!==Number(l.quantity))throw Error('Articles ou quantités différents entre Excel et TEMU');
  seen.add(id);
  const skus=[...new Set((hits[0].productList||[]).map(p=>String(p.extCode||'').trim()).filter(Boolean))];
  if(skus.length!==1||skus[0]!==l.source_sku)throw Error('SKU différent ou non vérifiable entre Excel et TEMU : '+l.source_sku);
 }
}
