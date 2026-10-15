import {cancellationBlock} from './erp-transient-policy.mjs';
import {isDeepStrictEqual} from 'node:util';
import {usesNativeBlCycle,assertNativeBlOrder} from './native-bl-policy.mjs';

// A missing unpublished native BL may be retired only after proving that it
// produced no movement. This is duplicate-write protection, not a BC debit test.
async function assertMissingNativeDraftNoMovement(api,bc,old){
 if(!/^\d{4}-\d{2}-\d{2}[ T]/.test(bc.created_at||'')||!Array.isArray(bc.line_items)||!bc.line_items.length)throw Error('Brouillon BL absent : périmètre du journal non vérifiable');
 let complete=false;
 // Scan the complete dated ledger, including variants no longer on the BC.
 // Erplain does not offer a document-id filter for InventoryLogs.
 for(let page=1;page<=100;page++){
  const {InventoryLogs:logs}=await api.request('query V3MissingNativeDraftLedger($where:QueryInventoryLogsWhereWhereConditions!,$page:Int!){InventoryLogs(first:100,page:$page,where:$where){data{id document_id order_type variant{id}} paginatorInfo{hasMorePages}}}',{page,where:{column:'CREATED_AT',operator:'GTE',value:bc.created_at.slice(0,10)+' 00:00:00'}});
  if(!Array.isArray(logs?.data)||typeof logs.paginatorInfo?.hasMorePages!=='boolean'||logs.data.some(l=>!l.id||l.document_id==null||!l.order_type))throw Error('Brouillon BL absent : journal incomplet');
  if(logs.data.some(l=>l.order_type==='ShippingOrder'&&String(l.document_id)===String(old.id)))throw Error('Brouillon BL absent : mouvement existant, aucune nouvelle création');
  if(!logs.paginatorInfo.hasMorePages){complete=true;break;}
 }
 if(!complete)throw Error('Brouillon BL absent : journal trop volumineux');
}
export async function assertMissingDraftIdle(db,o,resolutionId){
 const busy=(await db.query(`SELECT 1 FROM carrier_documents WHERE order_id=$1
 UNION ALL SELECT 1 FROM carrier_jobs WHERE order_id=$1
 UNION ALL SELECT 1 FROM partial_deliveries WHERE order_id=$1
 UNION ALL SELECT 1 FROM resolution_jobs WHERE order_id=$1 AND status IN ('queued','running','waiting') AND id<>$2`,[o.id,resolutionId])).rows;
 if(busy.length)throw Error('Brouillon BL absent : document transport ou autre traitement présent');
}
export async function commitMissingDraftRecovery(tx,o,next,{resolutionId,userEmail='system'}={}){
 const current=(await tx.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[o.id])).rows[0];
 if(!isDeepStrictEqual(current?.erp_live,o.erp_live))throw Error('Brouillon BL modifié pendant la lecture : reprise différée');
 if(current.archived||current.partial_mode||cancellationBlock(current)||['shipped','delivered','in_transit','delivered_simulated'].includes(current.tracking_status))throw Error('Commande modifiée pendant la lecture : reprise différée');
 await assertMissingDraftIdle(tx,o,resolutionId);
 await tx.query('UPDATE orders SET erp_live=$2 WHERE id=$1',[o.id,JSON.stringify(next)]);
 await tx.query("INSERT INTO audit(user_email,action,detail) VALUES($1,'erplain.missing_draft_retired',$2)",[userEmail,JSON.stringify({orderId:o.id,recovery:next.missingDraftRecoveries.at(-1)})]);
}

// Only retire a local draft pointer before any stock or carrier write. The
// normal worker remains responsible for creating and publishing the new BL.
export async function prepareMissingDraftRecovery(db,api,o,{resolutionId,now=Date.now()}={}){
 const s=o.erp_live||{},old=s.bl;
 const native=usesNativeBlCycle(o);
 if(!(native?['bl_created','publishing_bl']:['publishing_bl']).includes(s.phase)||old?.status!=='unpublished')return null;
 if(native)assertNativeBlOrder(o);
 if(!old.id||!/^SHO[0-9]{8}$/.test(old.label||'')||!s.bc?.id||old.update_stock!==(native?true:false)||o.archived||o.partial_mode||cancellationBlock(o)||['shipped','delivered','in_transit','delivered_simulated'].includes(o.tracking_status))throw Error('Brouillon BL absent : reprise non applicable');
 if(s.stockDocument||s.stockCreationAttemptedAt||s.stockCreationOutcome||s.stockPendingVariants?.length||s.previousCancelledCycle||(!native&&s.historicalStockProof))throw Error('Brouillon BL absent : mouvement de stock antérieur ou incertain, rapprochement requis');
 await assertMissingDraftIdle(db,o,resolutionId);
 const r=await api.request('query V3MissingDraftRead($bc:ID!,$bl:ID!){Order(id:$bc){id created_at status update_stock line_items{type variant{id}} shipping_orders(first:100){data{id label status} paginatorInfo{hasMorePages}}} ShippingOrder(id:$bl){id label status}}',{bc:String(s.bc.id),bl:String(old.id)});
 const bc=r.Order,list=bc?.shipping_orders;
 if(String(bc?.id)!==String(s.bc.id)||bc.status!=='active'||bc.update_stock!==(native?true:false)||!Array.isArray(list?.data)||list.paginatorInfo?.hasMorePages!==false)throw Error('Brouillon BL absent : lecture du BC incomplète ou politique de stock incompatible');
 if(r.ShippingOrder!=null){if(String(r.ShippingOrder.id)!==String(old.id))throw Error('Brouillon BL : identifiant de réponse incohérent');return null;}
 if(list.data.length)throw Error('Brouillon BL absent : un BL associé au BC existe, rapprochement requis');
 if(native)await assertMissingNativeDraftNoMovement(api,bc,old);
 const stocks=await api.request('query V3MissingDraftStock($where:QueryStockRemovalsWhereWhereConditions!){StockRemovals(first:100,where:$where){data{id label status} paginatorInfo{hasMorePages}}}',{where:{column:'LABEL',operator:'EQ',value:'V3FS-'+o.id}});
 if(!Array.isArray(stocks.StockRemovals?.data)||stocks.StockRemovals.paginatorInfo?.hasMorePages!==false||stocks.StockRemovals.data.length)throw Error('Brouillon BL absent : absence de mouvement de stock non confirmée');
 if(native){const extra=await api.request('query V3MissingDraftStock($where:QueryStockRemovalsWhereWhereConditions!){StockRemovals(first:100,where:$where){data{id label status} paginatorInfo{hasMorePages}}}',{where:{column:'LABEL',operator:'EQ',value:'V3FS-'+o.id+'-BC'+s.bc.id}});if(!Array.isArray(extra.StockRemovals?.data)||extra.StockRemovals.paginatorInfo?.hasMorePages!==false||extra.StockRemovals.data.length)throw Error('Brouillon BL absent : sortie distincte ou recherche incomplète');}
 const labels=await api.request('query V3MissingDraftLabel($where:QueryShippingOrdersWhereWhereConditions!){ShippingOrders(first:100,where:$where){data{id label status orders(first:100){data{id} paginatorInfo{hasMorePages}}} paginatorInfo{hasMorePages}}}',{where:{column:'LABEL',operator:'EQ',value:old.label}});
 const matches=labels.ShippingOrders;
 if(!Array.isArray(matches?.data)||matches.paginatorInfo?.hasMorePages!==false)throw Error('Brouillon BL absent : recherche du numéro incomplète');
 for(const bl of matches.data){if(!bl.id||!Array.isArray(bl.orders?.data)||bl.orders.paginatorInfo?.hasMorePages!==false||String(bl.id)===String(old.id)||bl.orders.data.some(b=>String(b.id)===String(s.bc.id)))throw Error('Brouillon BL absent : numéro retrouvé sur ce BC ou rattachement non vérifiable');}
 const next=structuredClone(s);delete next.bl;next.phase='bc_created';next.labelPreparationFingerprint=null;
 next.missingDraftRecoveries=[...(s.missingDraftRecoveries||[]),{checkedAt:new Date(now).toISOString(),resolutionId,bcId:String(bc.id),previousPhase:s.phase,retiredDraft:structuredClone(old),stockEffect:'none_started_and_no_cycle_document',labelMatches:matches.data.map(b=>({id:b.id,label:b.label,status:b.status,bcIds:b.orders.data.map(x=>String(x.id))}))}];
 return next;
}
