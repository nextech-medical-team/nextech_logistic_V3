import {marketplaceContentFrozen} from './marketplace-content-freeze.mjs';
import {maskedTemuAddressFields,usableFrozenAddress} from './temu-address-observation.mjs';
import {relayComparisonAddress,sameRelayAddress} from './shopify-relay-source.mjs';
// Marketplace receipts describe what was ordered, not the replacement sent.
export function sourceFingerprint(rows) {
 if (!Array.isArray(rows) || !rows.length) return null;
 const seen=new Set(), result=[];
 for (const x of rows) {
  const line=String(x.source_line??''),sku=x.source_sku,quantity=Number(x.quantity);
  if (!line || seen.has(line) || typeof sku!=='string' || !sku.trim() || !Number.isFinite(quantity) || quantity<=0) return null;
  seen.add(line);result.push({line,sku,quantity});
 }
 return JSON.stringify(result.sort((a,b)=>a.line.localeCompare(b.line)));
}
export function marketplaceChangeFields(existing,prior,incoming){return marketplaceContentFrozen(existing)?[]:marketplaceSnapshotChangeFields(existing,prior,incoming);}
export function marketplaceSnapshotChangeFields(existing,prior,incoming){
 const originals=existing.erp_live?.equivalentOriginalLines,rows=originals===undefined?prior:originals;
 const baseline=sourceFingerprint(rows),fresh=sourceFingerprint(incoming.lines),fields=[];
 if(!baseline||!fresh)fields.push('articles : références ou quantités non vérifiables');
 else if(baseline!==fresh){const a=JSON.parse(baseline),b=JSON.parse(fresh);if(a.length!==b.length||a.some(x=>!b.some(y=>y.line===x.line)))fields.push('articles : ajout ou retrait');if(a.some(x=>b.some(y=>y.line===x.line&&y.sku!==x.sku)))fields.push('articles : références vendeur');if(a.some(x=>b.some(y=>y.line===x.line&&y.quantity!==x.quantity)))fields.push('articles : quantités');}
 const masked=existing.channel==='temu'?maskedTemuAddressFields(incoming.source_payload?.temuShippingInfo):[],usable=usableFrozenAddress(existing.address);
 if(masked.length&&!usable)fields.push('adresse initiale complète manquante');
 const relay=incoming.source_payload?.shopifyRelay,address=relay?relayComparisonAddress(existing,relay):existing.address;
 const labels={name:'nom du destinataire',street:'rue',postal:'code postal',city:'ville',country:'pays'};
 if(relay&&sameRelayAddress(address,incoming.address))return fields;
 for(const k of Object.keys(labels))if(!(masked.includes(k)&&usable)&&String(address?.[k]||'')!==String(incoming.address?.[k]||''))fields.push('adresse : '+labels[k]);
 return [...new Set(fields)];
}
export function marketplaceChanged(existing,prior,incoming){return marketplaceChangeFields(existing,prior,incoming).length>0;}
