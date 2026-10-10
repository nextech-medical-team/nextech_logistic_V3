export function window28(now=new Date()){return {start:new Date(+now-28*86400000).toISOString(),end:now.toISOString()};}
export function sourceRow(entry,mall,country,window){
 const p=entry.parentOrderMap, date=new Date(Number(p?.parentOrderTime)*1000);
 if(!p?.parentOrderSn||!Number.isFinite(+date))throw Error('Référence ou date TEMU absente');
 if(+date<Date.parse(window.start)||+date>Date.parse(window.end))return null;
 return {reference:p.parentOrderSn,mall,country,date:date.toISOString(),temuOrderStatus:p.parentOrderStatus,bc:[],bl:[],parcels:[],events:[],errors:[]};
}
export function processKind(orders){
 if(!orders.length)return 'Absente de V3';
 if(orders.length>1)return 'À vérifier · plusieurs fiches V3';
 const o=orders[0],s=o.source_payload||{},e=o.erp_live||{};
 const prior=s.selectedReimport?.previousBC;
 if(e.bc?.id&&Array.isArray(prior)&&prior.length&&!prior.some(b=>String(b.id)===String(e.bc.id)))return 'Processus normal · nouveau BC après reprise';
 if(s.selectedReimport?.mode==='hold'||e.phase==='historical_review')return 'Récupérée sans processus normal';
 if(s.selectedReimport?.mode==='resume')return 'Processus normal · reprise demandée';
 if(s.origin==='temu_direct_receipt')return 'Processus normal · réception TEMU';
 return 'À vérifier · origine non démontrée';
}
export function listReading(snapshot,params=new URLSearchParams()){
 const q=(params.get('search')||'').toLocaleLowerCase('fr'),country=params.get('country')||'';
 const rows=(snapshot.rows||[]).filter(r=>(!country||r.country===country)&&(!q||JSON.stringify(r).toLocaleLowerCase('fr').includes(q)));
 rows.sort((a,b)=>b.date.localeCompare(a.date)||a.reference.localeCompare(b.reference));
 const pages=Math.max(1,Math.ceil(rows.length/50)),page=Math.min(pages,Math.max(1,parseInt(params.get('page'))||1));
 return {...snapshot,rows:rows.slice((page-1)*50,page*50),total:rows.length,pages,page,countries:[...new Set((snapshot.rows||[]).map(r=>r.country))].sort()};
}
