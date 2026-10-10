import {randomUUID} from 'node:crypto';

// A receipt may be incomplete; its identity must never be fabricated.
export function incompleteOrder(channel,payload,shop,reason){
 const temu=channel==='temu',p=payload?.detail?.parentOrderMap||{},reference=temu?p.parentOrderSn:payload?.name;
 if(typeof reference!=='string'||!reference.trim())throw Error('Référence source absente : réception à corriger');
 const rawDate=temu?Number(p.parentOrderTime)*1000:payload.created_at,date=new Date(rawDate);
 return {id:randomUUID(),channel,reference,recipient:'',address:{country:temu?payload.country||'':''},source_date:Number.isFinite(date.getTime())?date.toISOString():null,source_payload:{...payload,sourceShop:shop,...(temu?{mallId:shop,temuOrderDetail:payload.detail}:{}),visibilityHold:true,visibilityReason:reason},lines:[],visibilityHold:true};
}

export async function retainVisibleOrder(db,o,reason){
 const result=await db.query(`INSERT INTO orders(id,channel,reference,source_reference,recipient,address,source_date,source_payload,resolution_pending_resume,label_status,issue,carrier,tracking_status)
 VALUES($1,$2,$3,$3,$4,$5,$6,$7,true,'blocked',$8,$9,'unknown')
 ON CONFLICT(channel,reference) DO UPDATE SET resolution_pending_resume=true,label_status='blocked',issue=excluded.issue,
 source_payload=orders.source_payload||jsonb_build_object('visibilityReadError',excluded.issue,'marketplacePendingCorrection',excluded.source_payload)
 WHERE coalesce(orders.source_payload->>'sourceShop',orders.source_payload->>'mallId','') IN ('',coalesce(excluded.source_payload->>'sourceShop',''))
 RETURNING id`,[o.id,o.channel,o.reference,o.recipient||'',JSON.stringify(o.address||{}),o.source_date,JSON.stringify({...o.source_payload,visibilityHold:true,visibilityReason:reason}),reason,o.channel==='temu'?'temu':null]);
 if(!result.rows.length)throw Error('Référence présente dans une autre boutique · Rapprochement nécessaire');
 return result.rows[0].id;
}

export function withinReceptionStart(channel,payload,settings){
 const start=Date.parse(settings?.since||'');
 const created=channel==='temu'?Number(payload?.detail?.parentOrderMap?.parentOrderTime)*1000:Date.parse(payload?.created_at);
 if(!Number.isFinite(start))throw Error('Date de début de réception non configurée');
 if(!Number.isFinite(created)||created<=0)throw Error('Date source absente : vérifier avant import');
 return created>=start&&created<=Date.now()+300000;
}
