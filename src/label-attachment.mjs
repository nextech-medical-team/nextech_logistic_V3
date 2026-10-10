const clean=(s,fallback)=>String(s||fallback).normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-zA-Z0-9_-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,75)||fallback;
export function labelFilename(row={},part='1',now=new Date()){
 const fields=Object.fromEntries(new Intl.DateTimeFormat('fr-FR',{timeZone:'Europe/Paris',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(now).map(x=>[x.type,x.value]));
 const stamp=fields.year+fields.month+fields.day+'_'+fields.hour+fields.minute+fields.second;
 return 'Etiquette_'+clean(row.recipient,'Client-inconnu')+'_'+clean(row.bl,'BL-non-cree')+'_'+clean(row.reference,'Commande')+'_colis-'+clean(part,'1')+'_'+stamp+'.pdf';
}
export async function labelAttachment(db,res,kind,key,part){
 const lookups={order:["o.id=$1",''],reference:["o.reference=$1",''],partial:["d.id=$1","JOIN partial_deliveries d ON d.order_id=o.id"],history:["h.id=$1","JOIN carrier_label_history h ON h.order_id=o.id"]};
 const [where,join]=lookups[kind];
 const bl=kind==='partial'?"d.bl->>'label'":"o.erp_live->'bl'->>'label'";
 const row=(await db.query(`SELECT o.recipient,o.reference,${bl} AS bl FROM orders o ${join} WHERE ${where} LIMIT 1`,[key])).rows[0]||{};
 res.setHeader('Content-Disposition','attachment; filename="'+labelFilename(row,part)+'"');res.setHeader('Cache-Control','no-store');
}
