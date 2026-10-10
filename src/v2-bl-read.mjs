import {erplainAccount} from './erplain-accounts.mjs';
export const blStatusLabel=s=>({pending:'En attente',unpublished:'Brouillon',make_the_shipment:'À expédier',in_preparation:'En préparation',ready_to_ship:'Prêt à livrer',shipped:'Expédié',delivered:'Livré',completed:'Terminé',cancelled:'Annulé',closed:'Clôturé'})[s]||s||'Statut non renseigné';
export async function initializeV2Bl(db){await db.exec("CREATE TABLE IF NOT EXISTS v2_bl_status(id TEXT PRIMARY KEY,detail JSONB,checked_at TIMESTAMPTZ,error TEXT,next_at TIMESTAMPTZ NOT NULL DEFAULT now())");}
export async function seedV2Bl(db){await db.query(`INSERT INTO v2_bl_status(id)
 SELECT DISTINCT id FROM (
 SELECT source->>'blId' id FROM v2_followup
 UNION SELECT o.erp_live->'bl'->>'id' FROM orders o WHERE EXISTS(SELECT 1 FROM v2_followup v WHERE v.source->>'reference'=o.reference AND v.source->>'channel'=o.channel)
 UNION SELECT p.bl->>'id' FROM partial_deliveries p JOIN orders o ON o.id=p.order_id WHERE EXISTS(SELECT 1 FROM v2_followup v WHERE v.source->>'reference'=o.reference AND v.source->>'channel'=o.channel)
 ) b WHERE id ~ '^[0-9]+$' ON CONFLICT DO NOTHING`);}
export async function refreshV2Bl(db,directory,{api=erplainAccount(directory,'live'),shouldStop=()=>false}={}){
 if(shouldStop())return;await seedV2Bl(db);
 const rows=(await db.query('SELECT id FROM v2_bl_status WHERE next_at<=now() ORDER BY next_at,id LIMIT 20')).rows;if(!rows.length)return;
 try{const data=await api.request('query V2ReadBlStatuses {'+rows.map((r,i)=>`b${i}:ShippingOrder(id:${r.id}){id label status}`).join(' ')+'}');
 for(let i=0;i<rows.length;i++){if(!Object.hasOwn(data||{},'b'+i))throw Error('Réponse BL Erplain incomplète');const d=data['b'+i];if(d&&String(d.id)!==rows[i].id)throw Error('Identité BL Erplain non concordante');}
 for(let i=0;i<rows.length;i++){const d=data?.['b'+i];await db.query("UPDATE v2_bl_status SET detail=$2,checked_at=now(),error=$3,next_at=now()+interval '6 hours' WHERE id=$1",[rows[i].id,d?JSON.stringify(d):null,d?null:'BL introuvable dans Erplain LIVE']);}
 }catch(e){await db.query("UPDATE v2_bl_status SET error=$2,next_at=now()+interval '2 hours' WHERE id=ANY($1::text[])",[rows.map(r=>r.id),String(e.message).slice(0,400)]);}
}
export function blDisplay(source,v3Bls,cache){
 const refs=new Map();if(source.blId)refs.set(String(source.blId),{id:String(source.blId),label:source.bl});for(const b of v3Bls)refs.set(String(b.id),b);
 return [...refs.values()].map(b=>{const c=cache.get(String(b.id));return {id:b.id,label:c?.detail?.label||b.label||b.id,status:c?.detail?.status||null,text:c?.detail?blStatusLabel(c.detail.status):c?.error?'Statut indisponible':'À actualiser',checkedAt:c?.checked_at||null,error:c?.error||null};});
}
