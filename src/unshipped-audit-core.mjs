import {createHash} from 'node:crypto';
import {readTable} from './imports.mjs';

export const AUDIT_CHANNELS=['temu','shopify','amazon'];
export const activeAudit=s=>s&&['queued','running'].includes(s.status);
export const auditReference=v=>String(v??'').trim().replace(/\/+$/,'');
const fold=v=>String(v??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');
export function auditOptions(input={}){
 const minAgeDays=Number(input.minAgeDays??3),channels=input.channels??['temu','shopify'];
 if(!Number.isInteger(minAgeDays)||minAgeDays<1||minAgeDays>365)throw Error('Ancienneté comprise entre 1 et 365 jours requise');
 if(!Array.isArray(channels)||!channels.length||channels.some(c=>!AUDIT_CHANNELS.includes(c))||new Set(channels).size!==channels.length)throw Error('Choisir TEMU, Shopify ou Amazon');
 if(channels.includes('amazon')&&(typeof input.amazonReportId!=='string'||!input.amazonReportId))throw Error('Charger un rapport Amazon avant le contrôle');
 return {minAgeDays,channels:[...channels],amazonReportId:channels.includes('amazon')?input.amazonReportId:null};
}
export function auditAge(date,now){
 const n=Date.parse(date);if(!Number.isFinite(n)||n>Date.parse(now)+300000)return null;
 return Math.floor((Date.parse(now)-n)/86400000);
}
export function includeAuditRow(row,options,now){const age=auditAge(row.date,now);return age===null||age>=options.minAgeDays;}
export function temuAuditRow(entry,mall,country,checkedAt){
 const m=entry?.parentOrderMap;
 if(!m?.parentOrderSn||!/^PO-\d+-\d+$/.test(m.parentOrderSn)||Number(m.parentOrderStatus)!==2)throw Error('TEMU : référence ou filtre Non expédié non confirmé');
 const epoch=Number(m.parentOrderTime),flags=(m.parentOrderLabel||[]).filter(f=>[1,'1',true].includes(f.value)).map(f=>f.name);
 return {channel:'temu',reference:m.parentOrderSn,shop:String(mall),country:country||'',date:epoch>0&&Number.isFinite(epoch)?new Date(epoch*1000).toISOString():null,deadline:Number(m.expectShipLatestTime)>0?new Date(Number(m.expectShipLatestTime)*1000).toISOString():null,sourceStatus:'Non expédié',sourceCode:2,sourceAt:checkedAt,sourceKind:'API TEMU',flags,parcels:[],errors:[]};
}
export function shopifyAuditRow(n,shop,checkedAt){
 if(!/^gid:\/\/shopify\/Order\/\d+$/.test(n?.id||'')||!n.name||n.cancelledAt||n.displayFulfillmentStatus==='FULFILLED')throw Error('Shopify : identité ou filtre Non expédié non confirmé');
 if(!Array.isArray(n.fulfillments))throw Error('Shopify : expéditions non reçues');
 return {channel:'shopify',reference:n.name,shop,date:n.createdAt,sourceStatus:n.displayFulfillmentStatus||'UNKNOWN',sourceAt:checkedAt,sourceKind:'API Shopify',flags:[],parcels:n.fulfillments.filter(f=>!['CANCELLED','CANCELED','ERROR','FAILURE'].includes(String(f.status).toUpperCase())).flatMap(f=>(f.trackingInfo||[]).filter(t=>t.number).map(t=>({carrier:t.company||'',tracking:t.number,origin:'API Shopify'}))),errors:[]};
}
export async function parseAmazonAuditReport({filename,content,reportedAt},now=new Date()){
 if(typeof filename!=='string'||filename.length>255||!/^.+\.(txt|tsv|csv|xlsx)$/i.test(filename)||typeof content!=='string'||!content||content.length>16*1024*1024||content.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(content))throw Error('Rapport Amazon TXT, TSV, CSV ou XLSX requis (12 Mo maximum)');
 const stamp=Date.parse(reportedAt);if(!Number.isFinite(stamp)||stamp>+now+300000)throw Error('Date du rapport Amazon invalide');
 const bytes=Buffer.from(content,'base64'),table=await readTable(bytes,filename),headers=new Set(Object.keys(table[0]||{}));
 const aliases={reference:['orderid','amazonorderid','numerodecommande'],date:['purchasedate','orderdate','datedachat','datecommande'],status:['orderstatus','statutdelacommande','statut'],line:['orderitemid','amazonorderitemid'],sku:['sku','sellersku'],remaining:['quantitytoship','quantityunshipped','quantitypending','quantiterestante']};
 const column=k=>aliases[k].find(x=>headers.has(x));
 if(!column('reference')||!column('date'))throw Error('Colonnes order-id et purchase-date requises dans le rapport Amazon');
 const groups=new Map(),errors=[],seen=new Set();let excluded=0,repeated=0;
 for(const r of table){
  const ref=String(r[column('reference')]||'').trim();if(!/^\d{3}-\d{7}-\d{7}$/.test(ref)){errors.push({row:r.row,message:'Numéro de commande Amazon invalide'});continue;}
  const status=column('status')?fold(r[column('status')]):'',remaining=column('remaining')?String(r[column('remaining')]??'').trim():'';
  if(['shipped','fulfilled','cancelled','canceled','expedie','expediee','annule','annulee'].includes(status)||remaining==='0'){excluded++;continue;}
  const key=JSON.stringify(Object.entries(r).filter(([k])=>k!=='row'));if(seen.has(key)){repeated++;continue;}seen.add(key);
  const rawDate=r[column('date')],date=rawDate instanceof Date?rawDate.toISOString():String(rawDate||'').trim();
  const day=/^(\d{4})-(\d{2})-(\d{2})/.exec(date),calendar=day?new Date(Date.UTC(Number(day[1]),Number(day[2])-1,Number(day[3]))):null;
  const validDate=/^\d{4}-\d{2}-\d{2}(?:T.*(?:Z|[+-]\d{2}:?\d{2}))?$/.test(date)&&Number.isFinite(Date.parse(date))&&calendar?.toISOString().slice(0,10)===date.slice(0,10);
  const o=groups.get(ref)||{channel:'amazon',reference:ref,shop:'Rapport Amazon',date:validDate?new Date(date).toISOString():null,sourceStatus:column('status')?String(r[column('status')]||'Non communiqué'):'Non expédié selon le rapport',sourceKind:'Rapport Amazon',sourceAt:new Date(stamp).toISOString(),flags:[],parcels:[],lines:[],errors:[]};
  if(!validDate)o.errors.push('Date d’achat absente ou invalide : ancienneté non vérifiable');
  if(validDate&&o.date&&o.date!==new Date(date).toISOString())o.errors.push('Dates d’achat différentes pour la même commande');
  if(status&&!['unshipped','partiallyshipped','pending','nonexpedie','nonexpediee','partiellementexpedie','partiellementexpediee','enattente'].includes(status))o.errors.push('Statut du rapport à vérifier : '+String(r[column('status')]));
  if(column('status')){o.sourceStatuses=[...new Set([...(o.sourceStatuses||[]),String(r[column('status')]||'Non communiqué')])];o.sourceStatus=o.sourceStatuses.join(' / ');if(o.sourceStatuses.length>1)o.errors.push('Statuts différents entre les lignes du rapport');}
  if(['partiallyshipped','partiellementexpedie','partiellementexpediee'].includes(status)&&!remaining)o.errors.push('Commande partiellement expédiée : quantités restantes non précisées');
  if(remaining&&!/^\d+$/.test(remaining))o.errors.push('Quantité restante invalide');
  o.lines.push({sku:column('sku')?String(r[column('sku')]||''):'',remaining:remaining&&/^\d+$/.test(remaining)?Number(remaining):null});groups.set(ref,o);
 }
 const rows=[...groups.values()].map(r=>({...r,errors:[...new Set(r.errors)]}));
 if(!rows.length)throw Error('Aucune commande non expédiée exploitable dans ce rapport');
 return {filename,hash:createHash('sha256').update(bytes).digest('hex'),reportedAt:new Date(stamp).toISOString(),loadedAt:now.toISOString(),rows,errors,excluded,repeated,lineCount:table.length};
}
export function matchAuditOrders(row,orders){
 return orders.filter(o=>o.channel===row.channel&&[o.reference,o.source_reference].some(r=>auditReference(r)===auditReference(row.reference))&&(!row.shop||row.channel==='amazon'||!(row.channel==='temu'?o.source_payload?.mallId:o.source_payload?.sourceShop)||String(row.channel==='temu'?o.source_payload.mallId:o.source_payload.sourceShop)===row.shop));
}
export function diagnoseAuditRow(row){
 if(row.flags?.some(f=>['pending_buyer_cancellation','pending_buyer_address_change'].includes(f)))return 'Demande client à examiner';
 if(row.sourceChanged)return 'Statut plateforme modifié : à rapprocher';
 if(!row.v3?.length)return 'Absente de V3'+(row.bc?.length?' ; BC Erplain retrouvé':'');
 if(row.v3.length>1)return 'Plusieurs fiches V3 à rapprocher';
 if(row.v3[0].suspended)return 'Commande suspendue';
 if(row.v3[0].cancelled||row.bc?.length&&row.bc.every(b=>b.status==='cancelled'))return 'Annulation locale à rapprocher';
 const states=(row.parcels||[]).filter(p=>p.observation==='live').map(p=>p.status);
 if(states.includes('exception'))return 'Incident transporteur';
 if(states.includes('delivered')||row.bl?.some(b=>b.status==='delivered'))return 'Livraison observée : vérifier les quantités restantes';
 if(states.includes('shipped')||row.bl?.some(b=>b.status==='shipped'))return 'Expédition observée : rapprocher la plateforme';
 if(row.labelAvailable)return states.length>0&&states.length===row.parcels.length&&states.every(s=>s==='not_shipped')?'Étiquette créée ; prise en charge non confirmée':'Étiquette disponible ; suivi non confirmé';
 if(row.v3.some(o=>o.blocker))return 'Préparation bloquée';
 if(row.v3.some(o=>o.busy))return 'Préparation en cours';
 if(row.bl?.length)return 'BL existant ; étiquette à vérifier';
 if(row.bc?.length)return 'BC existant ; BL à vérifier';
 return 'Préparation à vérifier';
}
export function auditView(snapshot,{channel='',search='',diagnosis='',page=1,pageSize=50}={}){
 if(!snapshot)return {status:'empty',rows:[],total:0,page:1,pages:1,errors:[],coverage:[]};
 const q=String(search).trim().toLocaleLowerCase('fr'),rows=(snapshot.rows||[]).filter(r=>(!channel||r.channel===channel)&&(!diagnosis||r.diagnosis===diagnosis)&&(!q||JSON.stringify(r).toLocaleLowerCase('fr').includes(q))).sort((a,b)=>(a.date?Date.parse(a.date):Infinity)-(b.date?Date.parse(b.date):Infinity)||a.reference.localeCompare(b.reference));
 const pages=Math.max(1,Math.ceil(rows.length/pageSize));page=Math.max(1,Math.min(pages,Number.parseInt(page)||1));
 return {id:snapshot.id,status:snapshot.status,phase:snapshot.phase,options:snapshot.options,startedAt:snapshot.startedAt,updatedAt:snapshot.updatedAt,finishedAt:snapshot.finishedAt,sourceCounts:snapshot.sourceCounts,coverage:snapshot.coverage||[],errors:snapshot.errors||[],total:rows.length,collected:(snapshot.rows||[]).length,diagnoses:[...new Set((snapshot.rows||[]).map(r=>r.diagnosis).filter(Boolean))].sort(),page,pages,rows:rows.slice((page-1)*pageSize,page*pageSize)};
}
