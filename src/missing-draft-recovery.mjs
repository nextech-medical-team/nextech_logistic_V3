import {cancellationBlock} from './erp-transient-policy.mjs';
import {isDeepStrictEqual} from 'node:util';
export async function assertMissingDraftIdle(db,o,resolutionId){
 const busy=(await db.query(`SELECT 1 FROM carrier_documents WHERE order_id=$1
 UNION ALL SELECT 1 FROM carrier_jobs WHERE order_id=$1
 UNION ALL SELECT 1 FROM partial_deliveries WHERE order_id=$1
 UNION ALL SELECT 1 FROM resolution_jobs WHERE order_id=$1 AND status IN ('queued','running','waiting') AND id<>$2`,[o.id,resolutionId])).rows;
 if(busy.length)throw Error('Brouillon BL absent : document transport ou autre traitement présent');
}
export async function commitMissingDraftRecovery(tx,o,next,{resolutionId,userEmail='system'}={}){
 const current=(await tx.query('SELECT erp_live FROM orders WHERE id=$1 FOR UPDATE',[o.id])).rows[0];
 if(!isDeepStrictEqual(current?.erp_live,o.erp_live))throw Error('Brouillon BL modifié pendant la lecture : reprise différée');
 await assertMissingDraftIdle(tx,o,resolutionId);
 await tx.query('UPDATE orders SET erp_live=$2 WHERE id=$1',[o.id,JSON.stringify(next)]);
 await tx.query("INSERT INTO audit(user_email,action,detail) VALUES($1,'erplain.missing_draft_retired',$2)",[userEmail,JSON.stringify({orderId:o.id,recovery:next.missingDraftRecoveries.at(-1)})]);
}

// Only retire a local draft pointer before any stock or carrier write. The
// normal worker remains responsible for creating and publishing the new BL.
export async function prepareMissingDraftRecovery(db,api,o,{resolutionId,now=Date.now()}={}){
 const s=o.erp_live||{},old=s.bl;
 if(s.phase!=='publishing_bl'||old?.status!=='unpublished')return null;
 if(!old.id||!/^SHO[0-9]{8}$/.test(old.label||'')||!s.bc?.id||old.update_stock!==false||o.archived||o.partial_mode||cancellationBlock(o)||['shipped','delivered','in_transit','delivered_simulated'].includes(o.tracking_status))throw Error('Brouillon BL absent : reprise non applicable');
 if(s.stockDocument||s.stockCreationAttemptedAt||s.stockCreationOutcome||s.stockPendingVariants?.length||s.previousCancelledCycle||s.historicalStockProof)throw Error('Brouillon BL absent : mouvement de stock antérieur ou incertain, rapprochement requis');
 await assertMissingDraftIdle(db,o,resolutionId);
 const r=await api.request('query V3MissingDraftRead($bc:ID!,$bl:ID!){Order(id:$bc){id status update_stock shipping_orders(first:100){data{id label status} paginatorInfo{hasMorePages}}} ShippingOrder(id:$bl){id label status}}',{bc:String(s.bc.id),bl:String(old.id)});
 const bc=r.Order,list=bc?.shipping_orders;
 if(String(bc?.id)!==String(s.bc.id)||bc.status!=='active'||bc.update_stock!==false||!Array.isArray(list?.data)||list.paginatorInfo?.hasMorePages!==false)throw Error('Brouillon BL absent : lecture du BC incomplète ou politique de stock incompatible');
 if(r.ShippingOrder!=null){if(String(r.ShippingOrder.id)!==String(old.id))throw Error('Brouillon BL : identifiant de réponse incohérent');return null;}
 if(list.data.length)throw Error('Brouillon BL absent : un BL associé au BC existe, rapprochement requis');
 const stocks=await api.request('query V3MissingDraftStock($where:QueryStockRemovalsWhereWhereConditions!){StockRemovals(first:100,where:$where){data{id label status} paginatorInfo{hasMorePages}}}',{where:{column:'LABEL',operator:'EQ',value:'V3FS-'+o.id}});
 if(!Array.isArray(stocks.StockRemovals?.data)||stocks.StockRemovals.paginatorInfo?.hasMorePages!==false||stocks.StockRemovals.data.length)throw Error('Brouillon BL absent : absence de mouvement de stock non confirmée');
 const labels=await api.request('query V3MissingDraftLabel($where:QueryShippingOrdersWhereWhereConditions!){ShippingOrders(first:100,where:$where){data{id label status orders(first:100){data{id} paginatorInfo{hasMorePages}}} paginatorInfo{hasMorePages}}}',{where:{column:'LABEL',operator:'EQ',value:old.label}});
 const matches=labels.ShippingOrders;
 if(!Array.isArray(matches?.data)||matches.paginatorInfo?.hasMorePages!==false)throw Error('Brouillon BL absent : recherche du numéro incomplète');
 for(const bl of matches.data){if(!bl.id||!Array.isArray(bl.orders?.data)||bl.orders.paginatorInfo?.hasMorePages!==false||String(bl.id)===String(old.id)||bl.orders.data.some(b=>String(b.id)===String(s.bc.id)))throw Error('Brouillon BL absent : numéro retrouvé sur ce BC ou rattachement non vérifiable');}
 const next=structuredClone(s);delete next.bl;next.phase='bc_created';next.labelPreparationFingerprint=null;
 next.missingDraftRecoveries=[...(s.missingDraftRecoveries||[]),{checkedAt:new Date(now).toISOString(),resolutionId,bcId:String(bc.id),previousPhase:s.phase,retiredDraft:structuredClone(old),stockEffect:'none_started_and_no_cycle_document',labelMatches:matches.data.map(b=>({id:b.id,label:b.label,status:b.status,bcIds:b.orders.data.map(x=>String(x.id))}))}];
 return next;
}
