import {blDisplay} from './v2-bl-read.mjs';
import {aggregateParcels} from './status-policy.mjs';
const names={delivered:'Livrée',shipped:'En cours de livraison',not_shipped:'Non expédiée',exception:'Incident de livraison',cancelled:'Annulée',unknown:'Suivi non vérifié'};
const text=v=>String(v??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
export async function listV2(db,params){
 const rows=(await db.query("SELECT * FROM v2_followup WHERE mode='tracking_only' ORDER BY source->>'date' DESC,key")).rows;
 const orders=(await db.query("SELECT o.reference,o.channel,o.erp_live->'bl' bl FROM orders o WHERE EXISTS(SELECT 1 FROM v2_followup v WHERE v.source->>'reference'=o.reference AND v.source->>'channel'=o.channel) UNION ALL SELECT o.reference,o.channel,p.bl FROM partial_deliveries p JOIN orders o ON o.id=p.order_id WHERE p.bl IS NOT NULL AND EXISTS(SELECT 1 FROM v2_followup v WHERE v.source->>'reference'=o.reference AND v.source->>'channel'=o.channel)")).rows;
 const blCache=new Map((await db.query('SELECT * FROM v2_bl_status')).rows.map(r=>[r.id,r]));
 const byRef=new Map();for(const o of orders){const k=o.channel+':'+o.reference;if(!byRef.has(k))byRef.set(k,[]);if(o.bl?.id)byRef.get(k).push(o.bl);}
 for(const r of rows){const s=r.source;r.v3Bls=[...new Map((byRef.get(s.channel+':'+s.reference)||[]).map(b=>[String(b.id),b])).values()];r.blV3=r.v3Bls.length?'Oui':byRef.has(s.channel+':'+s.reference)?'Non':'Commande absente de V3';
  r.blErplain=blDisplay(s,r.v3Bls,blCache);r.blErplainText=r.blErplain.length?r.blErplain.map(b=>b.label+' : '+b.text+(b.error?' · '+b.error:'')).join(' / '):(s.bl?'Identifiant BL absent du fichier':'Aucun BL référencé');
  const candidates=[...(r.observation?.parcels||[]),...(!s.tracking.length?r.enrichment||[]:s.tracking.map(tracking=>({tracking,carrier:s.carrier,api:s.channel==='temu'?'TEMU':s.carrier.toUpperCase()})))];
  r.parcels=[...new Map(candidates.toReversed().map(p=>[p.tracking,p])).values()];r.status=aggregateParcels(r.parcels.map(p=>p.tracking),r.events).status;r.apiVerified=!!r.last_success_at&&!r.error;
 }
 const progress={total:rows.length,verified:rows.filter(r=>r.apiVerified).length,pending:rows.filter(r=>!r.checked_at||Date.parse(r.next_at)<=Date.now()).length,errors:rows.filter(r=>r.error).length};
 const filtered=rows.filter(r=>{const s=r.source;const values={reference:s.reference+' '+s.channel+' '+s.date+' '+new Date(s.date).toLocaleDateString('fr-FR'),bc:s.bc,bl:s.bl,blV3:r.blV3+' '+r.v3Bls.map(b=>b.label||b.id).join(' '),blStatus:r.blErplainText,carrier:r.parcels.map(p=>p.carrier).join(' ')||s.carrier,tracking:r.parcels.map(p=>p.tracking).join(' '),status:(names[r.status]||r.status)+' '+(r.error||'')+' '+r.events.map(e=>e.label).join(' '),updated:[r.last_success_at,r.checked_at].filter(Boolean).map(d=>new Date(d).toLocaleString('fr-FR')).join(' ')};
  if(params.get('search')&&!text(Object.values(values).join(' ')).includes(text(params.get('search'))))return false;
  const carrier=params.get('carrier');if(carrier&&!(carrier==='other'?!/gofo|gls/i.test(values.carrier):text(values.carrier).includes(carrier)))return false;
  return Object.entries(values).every(([k,v])=>!params.get('f_'+k)||text(v).includes(text(params.get('f_'+k))));
 });
 const total=filtered.length,pages=Math.max(1,Math.ceil(total/50)),page=Math.min(pages,Math.max(1,parseInt(params.get('page'))||1));return {rows:params.get('export')==='1'?filtered:filtered.slice((page-1)*50,page*50),total,pages,page,progress};
}

