import {assertDocumentIdle} from './erplain-document-read.mjs';

// A reference suggests a match; only explicit confirmation attaches documents.
export async function existingRecoveryCandidate(db,d){
 const ref=String(d.external_reference||d.label).trim();
 const rows=(await db.query("SELECT o.* FROM orders o WHERE reference=$1 OR source_reference=$1 OR erp_live->'bc'->>'id'=$2 OR id IN (SELECT order_id FROM erplain_order_identity WHERE account='live' AND bc_id=$2)",[ref,String(d.id)])).rows;
 if(!rows.length)return null;
 const matches=rows.map(o=>({orderId:o.id,reference:o.reference,sourceReference:o.source_reference||null,channel:o.channel||null,recipient:o.recipient||'',archived:!!o.archived,bcId:o.erp_live?.bc?.id||null,bcLabel:o.erp_live?.bc?.label||null,matchReason:String(o.erp_live?.bc?.id)===String(d.id)?'Même BC Erplain':o.reference===ref?'Même référence de commande':o.source_reference===ref?'Même référence source':'Identité BC déjà enregistrée'}));
 if(rows.length!==1)return {matches,blocked:'Plusieurs commandes V3 correspondent : sélection manuelle requise, voir les commandes ci-dessous'};
 const o=rows[0];
 if(o.source_payload?.erplainImported&&o.source_payload.account!=='live')return {matches,blocked:'Commande issue d’un autre compte Erplain : rattachement LIVE interdit'};
 if(o.erp_live?.bc?.id&&String(o.erp_live.bc.id)!==String(d.id))return {matches,blocked:'Cette référence est rattachée à un autre BC Erplain : aucun document remplacé'};
 return {...matches[0],matches};
}
export async function attachExistingDocuments(tx,d,orderId,user){
 const o=(await tx.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[orderId])).rows[0];
 if(!o)throw Error('Commande V3 introuvable');
 await assertDocumentIdle(tx,orderId);
 // Queued writers must not start against the previous document identity.
 const queued=(await tx.query("SELECT 1 FROM erp_live_jobs WHERE order_id=$1 AND status='pending' UNION ALL SELECT 1 FROM carrier_jobs WHERE order_id=$1 AND status IN ('pending','awaiting_pdf') UNION ALL SELECT 1 FROM partial_deliveries WHERE order_id=$1 AND status='queued'",[orderId])).rows;
 if(queued.length)throw Error('Traitement en attente : attendre sa fin avant rattachement Erplain');
 const old=o.erp_live||{},bls=d.shipping_orders.data;
 const linked=old.bl?.id?bls.find(b=>String(b.id)===String(old.bl.id)):null;
 if(old.bl?.id&&!linked)throw Error('Le BL déjà enregistré dans V3 est absent de ce BC : aucun document remplacé');
 const state={...old,bc:{...old.bc,...d},documentSource:{...old.documentSource,shippingOrders:bls,checkedAt:new Date().toISOString()},...(linked?{bl:{...old.bl,...linked}}:{})};
 await tx.query("INSERT INTO erplain_order_identity(account,bc_id,order_id) VALUES('live',$1,$2) ON CONFLICT(account,bc_id) DO NOTHING",[String(d.id),orderId]);
 const identity=(await tx.query("SELECT order_id FROM erplain_order_identity WHERE account='live' AND bc_id=$1",[String(d.id)])).rows[0];
 if(identity?.order_id!==orderId)throw Error('Ce BC est déjà rattaché à une autre commande V3');
 await tx.query('UPDATE orders SET erp_live=$2::jsonb WHERE id=$1',[orderId,JSON.stringify(state)]);
 await tx.query("INSERT INTO audit(user_email,action,detail) VALUES($1,'erplain.existing.documents_recovered',$2)",[user.email,JSON.stringify({orderId,bcId:String(d.id),blIds:bls.map(b=>String(b.id)),preparationStarted:false})]);
 return {orderId,archived:!!o.archived,alreadyRecovered:true,shippingOrders:bls,preparationStarted:false,message:'BC et BL récupérés sur la commande existante. Aucune nouvelle préparation lancée.'};
}
