import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {readErplainDocuments,assertDocumentIdle} from './erplain-document-read.mjs';
import {readHistoricalStock,assertNoHistoricalStockRemoval} from './historical-stock-proof.mjs';
import {applyBlIdentityObservation} from './bl-identity.mjs';

async function carrierEvidence(db,id){
 const jobs=(await db.query('SELECT * FROM carrier_jobs WHERE order_id=$1',[id])).rows;
 const documents=(await db.query('SELECT document_index,pdf FROM carrier_documents WHERE order_id=$1 ORDER BY document_index',[id])).rows;
 if(jobs.some(j=>!['ready','failed','cancelled'].includes(j.status)))throw Error('Identité BL : traitement transport non terminé');
 if(documents.length&&!jobs.some(j=>j.status==='ready'))throw Error('Identité BL : PDF sans traitement transport rapproché');
 return {jobs,documents:documents.map(d=>({index:d.document_index,sha256:createHash('sha256').update(d.pdf).digest('hex')}))};
}

async function missingBlLedger(api,bc,old){
 const since=String(bc.created_at||'').slice(0,10);
 if(!/^\d{4}-\d{2}-\d{2}$/.test(since))throw Error('Identité BL : date du BC non vérifiée');
 const evidence=[];
 for(const variant of new Set(bc.line_items.filter(l=>l.variant).map(l=>String(l.variant.id)))){
  let complete=false;const totals=new Map(),ids=[];
  for(let page=1;page<=100;page++){
   const logs=(await api.request('query V3MissingBlLedger($where:QueryInventoryLogsWhereWhereConditions!,$page:Int!){InventoryLogs(first:100,page:$page,where:$where){data{id document_id order_type on_hand_diff available_diff variant{id} location{id}} paginatorInfo{hasMorePages}}}',{page,where:{AND:[{column:'VARIANT_ID',operator:'EQ',value:variant},{column:'CREATED_AT',operator:'GTE',value:since+' 00:00:00'}]}})).InventoryLogs;
   if(!Array.isArray(logs?.data)||typeof logs.paginatorInfo?.hasMorePages!=='boolean'||logs.data.some(l=>!l.id||l.document_id==null||!l.order_type||String(l.variant?.id)!==variant))throw Error('Identité BL : journal incomplet');
   for(const row of logs.data.filter(l=>String(l.document_id)===String(old.id)&&l.order_type==='ShippingOrder')){
    if(!row.location?.id||[row.on_hand_diff,row.available_diff].some(v=>v==null||typeof v==='boolean'||String(v).trim()===''||!Number.isFinite(Number(v))))throw Error('Identité BL : mouvement incomplet');
    ids.push(String(row.id));const key=String(row.location.id),sum=totals.get(key)||[0,0];totals.set(key,[sum[0]+Number(row.on_hand_diff),sum[1]+Number(row.available_diff)]);
   }
   if(!logs.paginatorInfo.hasMorePages){complete=true;break;}
   if(!logs.data.length)throw Error('Identité BL : pagination vide');
  }
  if(!complete||[...totals.values()].some(t=>t.some(v=>Math.abs(v)>1e-7)))throw Error('Identité BL : effet stock du BL disparu non nul ou non vérifiable');
  evidence.push({variant,logIds:ids,netByLocation:[...totals]});
 }
 return evidence;
}

// Explicit repair only. Never called by polling, label admission or a scheduler.
// All provider requests are reads; existing labels and stock records are preserved.
export async function prepareBlIdentityRepair(db,api,o,{now=Date.now(),stockReader=readHistoricalStock}={}){
 if(o.partial_mode||o.archived||!o.erp_live?.bc?.id||!o.erp_live?.bl?.id)throw Error('Identité BL : réparation non applicable');
 await assertDocumentIdle(db,o.id);
 const state=o.erp_live,old=state.bl,bc=await readErplainDocuments(api,state.bc.id);
 const raw=await api.request('query V3IdentityRepairRead($bc:ID!,$bl:ID!){Order(id:$bc){id created_at} ShippingOrder(id:$bl){id label status update_stock orders(first:100){data{id} paginatorInfo{hasMorePages}}}}',{bc:String(bc.id),bl:String(old.id)});
 if(String(raw.Order?.id)!==String(bc.id)||raw.ShippingOrder===undefined)throw Error('Identité BL : lecture incomplète');
 bc.created_at=raw.Order.created_at;
 const actual=raw.ShippingOrder;
 if(actual&&String(actual.id)!==String(old.id))throw Error('Identité BL : identifiant reçu différent');
 if(bc.shipping_orders.data.some(b=>String(b.id)===String(old.id)))return null;
 const carrier=await carrierEvidence(db,o.id);
 const next=applyBlIdentityObservation(state,bc,actual,{now});
 let stockProof=null,ledger=null;
 if(actual===null){
  if(old.status!=='unpublished'||typeof old.update_stock!=='boolean'||bc.status!=='active'||typeof bc.update_stock!=='boolean'||bc.shipping_orders.data.length)throw Error('Identité BL : brouillon absent ambigu');
  if(o.suspension?.active||o.suspension?.erplainCancellation||['cancelled','shipped','in_transit','delivered','delivered_simulated'].includes(o.tracking_status)||o.label_status==='cancelled')throw Error('Identité BL : commande suspendue, annulée ou expédiée');
  if(state.stockDocument||state.stockCreationAttemptedAt||state.stockCreationOutcome||state.stockPendingVariants?.length||state.previousCancelledCycle)throw Error('Identité BL : cycle de stock antérieur ou incertain');
  await assertNoHistoricalStockRemoval(api,o);
  ledger=await missingBlLedger(api,bc,old);
  if(bc.update_stock){stockProof=(await stockReader(api,bc,{beforeBlPublication:true})).proof;if(String(stockProof?.bcId)!==String(bc.id)||stockProof.stockOnBc!==true)throw Error('Identité BL : preuve stock du BC différente');}
  else if(old.update_stock!==false)throw Error('Identité BL : politique de stock incohérente');
  delete next.bl;next.phase='bc_created';next.labelPreparationFingerprint=null;delete next.blIdentity;
  if(next.transientRecovery)next.transientRecovery={...next.transientRecovery,lastError:null,reconciliationError:null,readRateLimited:false,nextReadCheckAt:null};
 }else{
  if(actual.status!=='cancelled'||!Array.isArray(actual.orders?.data)||actual.orders.paginatorInfo?.hasMorePages!==false||actual.orders.data.length)throw Error('Identité BL : document détaché non annulé ou relation ambiguë');
  const candidates=bc.shipping_orders.data.filter(b=>b.status!=='cancelled'&&b.status!=='unpublished');
  const chosen=candidates.length===1?candidates[0]:bc.status==='cancelled'&&bc.shipping_orders.data.length===1?bc.shipping_orders.data[0]:null;
  if(!chosen)throw Error('Identité BL : plusieurs livraisons, choix explicite nécessaire');
  next.bl=structuredClone(chosen);delete next.blIdentity;
 }
 const check=await readErplainDocuments(api,bc.id);
 const version=b=>JSON.stringify({id:b.id,status:b.status,stock:b.update_stock,lines:b.line_items.map(l=>[l.id,l.quantity,l.reserved_quantity,l.shipped_quantity,l.variant?.id,l.location?.id]),bls:b.shipping_orders.data.map(l=>[l.id,l.label,l.status,l.update_stock])});
 const last=(await api.request('query V3IdentityRepairLast($id:ID!){ShippingOrder(id:$id){id label status}}',{id:String(old.id)})).ShippingOrder;
 if(version(check)!==version(bc)||last===undefined||(actual===null?last!==null:!last||String(last.id)!==String(actual.id)||last.status!==actual.status||last.label!==actual.label))throw Error('Identité BL : documents modifiés pendant le rapprochement');
 next.blIdentityRepairs=[...(state.blIdentityRepairs||[]),{at:new Date(now).toISOString(),previousBl:structuredClone(old),previousTransientRecovery:state.transientRecovery,observedBl:actual,bcId:String(bc.id),replacementBl:next.bl?{id:next.bl.id,label:next.bl.label,status:next.bl.status}:null,carrier,stockProof,ledger,businessWrites:0}];
 return next;
}

export async function commitBlIdentityRepair(tx,o,next,{userEmail='system'}={}){
 const fresh=(await tx.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[o.id])).rows[0];
 if(!fresh||!isDeepStrictEqual(fresh.erp_live,o.erp_live)||!isDeepStrictEqual(fresh.suspension,o.suspension)||fresh.tracking_status!==o.tracking_status||fresh.label_status!==o.label_status||fresh.archived!==o.archived||fresh.partial_mode!==o.partial_mode)throw Error('Identité BL : commande modifiée pendant la lecture');
 await assertDocumentIdle(tx,o.id);
 const erpJob=(await tx.query('SELECT status,error FROM erp_live_jobs WHERE order_id=$1 FOR UPDATE',[o.id])).rows[0];
 if(erpJob&&!['review','complete','failed','cancelled'].includes(erpJob.status))throw Error('Identité BL : traitement ERP en attente ou en cours');
 const proof=next.blIdentityRepairs.at(-1),carrier=await carrierEvidence(tx,o.id);
 if(!isDeepStrictEqual(carrier,proof.carrier))throw Error('Identité BL : transport modifié pendant la lecture');
 // Removing an invalid pointer must not make a background admission monitor
 // interpret this local repair as authorization to create a new document.
 await tx.query('UPDATE orders SET erp_live=$2,resolution_pending_resume=CASE WHEN $3 THEN true ELSE resolution_pending_resume END WHERE id=$1',[o.id,JSON.stringify(next),!next.bl]);
 if(!next.bl&&erpJob?.status==='review')await tx.query("UPDATE erp_live_jobs SET error=$2,updated_at=now() WHERE order_id=$1 AND status='review'",[o.id,'BL Erplain · Aucun BL publié associé au BC : ancienne référence retirée, documents existants conservés.']);
 await tx.query("INSERT INTO audit(user_email,action,detail) VALUES($1,'erplain.bl_identity_repaired',$2)",[userEmail,JSON.stringify({orderId:o.id,repair:proof,previousErpJob:erpJob})]);
}
