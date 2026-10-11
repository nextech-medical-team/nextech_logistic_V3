import {adoptErplainBcLines,bcAuthorityLineVersion} from './erplain-bc-line-authority.mjs';
import {reconcileStockIncident} from './stock-incident-recheck.mjs';
import {reconcileRefreshedBcDiagnostics,assertRefreshedBcDocument,documentReadVersion} from './bc-comparison-refresh.mjs';
import {synchronizeRecoveredOrder} from './erplain-targeted-orders.mjs';
import {pendingScope,recoveredPendingScope,scopeSnapshot} from './erplain-pending-scope.mjs';
import {readErplainDocuments,assertDocumentIdle} from './erplain-document-read.mjs';
import {refreshPartialFromErplain,syncedSelection,stockMismatch} from './partial-erplain-sync.mjs';
const active=b=>!['cancelled','unpublished'].includes(b.status);
export function documentSource(bc,stockHolds=[]){
 if(!Array.isArray(bc.line_items)||typeof bc.update_stock!=='boolean'||!Array.isArray(bc.shipping_orders?.data)||bc.shipping_orders.paginatorInfo?.hasMorePages)throw Error('Erplain · Documents incomplets');
 if(bc.shipping_orders.data.some(b=>!['cancelled','unpublished','pending','make_the_shipment','in_preparation','ready_to_ship','shipped','delivered','completed'].includes(b.status)))throw Error('Erplain · Statut BL inconnu');
 if(bc.line_items.filter(l=>l.variant).some(l=>!l.id||!Number.isFinite(Number(l.quantity))||Number(l.quantity)<0))throw Error('Erplain · Quantité BC invalide');
 return {checkedAt:new Date().toISOString(),lines:bc.line_items.filter(l=>l.variant).map(l=>({lineId:String(l.id),sku:l.variant.sku,quantity:Number(l.quantity)})),allocations:bc.shipping_orders.data.filter(active).flatMap(b=>syncedSelection(bc,b)).map(l=>({sku:l.sku,quantity:l.quantity})),shippingOrders:bc.shipping_orders.data,stockHolds};
}
export async function refreshErplainDocuments(db,api,id,{adoptBcLines=false}={}){
 let o=(await db.query('SELECT * FROM orders WHERE id=$1',[id])).rows[0];if(!o)throw Error('Commande V3 introuvable');await assertDocumentIdle(db,id);await api.verify();
 const readVersion=documentReadVersion(o);
 const lineVersion=adoptBcLines?bcAuthorityLineVersion((await db.query('SELECT * FROM lines WHERE order_id=$1 ORDER BY id',[id])).rows):null;
 let bcId=o.erp_live?.bc?.id;
 if(!bcId){
  const r=(await api.request('query V3FindExistingDocument($where:QueryOrdersWhereWhereConditions!){Orders(first:100,where:$where){data{id label external_reference} paginatorInfo{hasMorePages}}}',{where:{column:'EXTERNAL_REFERENCE',operator:'EQ',value:o.reference}})).Orders;
  if(!Array.isArray(r?.data)||r.paginatorInfo?.hasMorePages)throw Error('Erplain · Recherche BC incomplète');if(r.data.length>1)throw Error('Plusieurs BC Erplain correspondent : rapprochement manuel requis');
  if(!r.data.length)return {notFound:true,message:'Aucun BC trouvé dans Erplain pour cette référence. Aucun document créé.',stockHolds:[],bc:null};bcId=r.data[0].id;
 }
 const bc=await readErplainDocuments(api,bcId);
 assertRefreshedBcDocument({...o,erp_live:{...o.erp_live,bc:{...o.erp_live?.bc,id:bcId}}},bc);
 if(o.partial_mode)return db.transaction(async tx=>{
  const fresh=(await tx.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[id])).rows[0];await assertDocumentIdle(tx,id);
  if(documentReadVersion(fresh)!==readVersion)throw Error('Documents locaux modifiés pendant la lecture : actualisation différée');
  const nested={query:(...args)=>tx.query(...args),transaction:fn=>fn(tx)};
  const r=await refreshPartialFromErplain(nested,api,id,{document:bc,identityVerified:true});
  const adoptedLines=adoptBcLines?await adoptErplainBcLines(tx,id,bc,lineVersion):null;
  const comparison=await reconcileRefreshedBcDiagnostics(tx,id,bc);return {...r,comparison,adoptedLines,notFound:false};
 });
 const pending=o.source_payload?.erplainImported?recoveredPendingScope(bc,o):null;const visible=pending?.scoped?scopeSnapshot(bc,pending):bc;const source=documentSource(visible),known=visible.shipping_orders.data.find(b=>String(b.id)===String(o.erp_live?.bl?.id)),current=known||(visible.shipping_orders.data.filter(active).length===1?visible.shipping_orders.data.find(active):visible.shipping_orders.data.length===1?visible.shipping_orders.data[0]:null);
 if(pending?.scoped)source.lines=pending.lines.map(l=>({lineId:String(l.id),sku:l.variant.sku,quantity:Number(l.quantity)}));
 if(o.erp_live?.bl?.id&&!known)throw Error('BL enregistré dans V3 absent du BC Erplain : rapprochement requis, aucune donnée remplacée');
 let stock=o.erp_live?.stockDocument;
 if(stock?.id){const actual=(await api.request('query V3DocumentStockProof($id:ID!){StockRemoval(id:$id){id label status update_stock line_items{quantity variant{id} location{id}}}}',{id:String(stock.id)})).StockRemoval;
  if(!actual||String(actual.id)!==String(stock.id)||actual.label!==stock.label)throw Error('Sortie de stock enregistrée introuvable ou différente');stock={...stock,...actual};
  if(current){const issue=stockMismatch({status:current.status==='cancelled'?'cancelled':'active',bl:current,stock_document:stock,selection:current.status==='cancelled'?[]:syncedSelection(bc,current)},actual);if(issue)source.stockHolds.push({bl:current.label,stockId:actual.id,stockLabel:actual.label,message:issue})}
 }
 if(current&&active(current)&&bc.update_stock===false&&current.update_stock===false&&!stock?.id&&bc.line_items.some(l=>l.variant?.track_inventory!==false&&l.variant))source.stockHolds.push({bl:current.label,message:'Sortie de stock de ce BL non identifiée : rapprochement requis'});
 let comparison,adoptedLines;
 await db.transaction(async tx=>{const fresh=(await tx.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[id])).rows[0];await assertDocumentIdle(tx,id);if(documentReadVersion(fresh)!==readVersion)throw Error('Documents locaux modifiés pendant la lecture : actualisation différée');if(String(fresh.erp_live?.bc?.id||'')!==String(o.erp_live?.bc?.id||'')||String(fresh.erp_live?.bl?.id||'')!==String(o.erp_live?.bl?.id||'')||String(fresh.erp_live?.stockDocument?.id||'')!==String(o.erp_live?.stockDocument?.id||''))throw Error('Documents locaux modifiés pendant la lecture : actualisation différée');
  const state={...fresh.erp_live,bc:{...fresh.erp_live?.bc,...visible},documentSource:source,...(current?{bl:{...fresh.erp_live?.bl,...current}}:{}),...(stock?{stockDocument:stock}:{})};await tx.query('UPDATE orders SET erp_live=$2::jsonb WHERE id=$1',[id,JSON.stringify(state)]);
  if(adoptBcLines)adoptedLines=await adoptErplainBcLines(tx,id,bc,lineVersion);
  if(fresh.source_payload?.erplainImported&&fresh.source_payload?.account==='live')await synchronizeRecoveredOrder(tx,(await tx.query('SELECT * FROM orders WHERE id=$1',[id])).rows[0],bc);
  comparison=await reconcileRefreshedBcDiagnostics(tx,id,bc);
 });
 const stockIncident=await reconcileStockIncident(db,api,id,{bc,comparison});
 return {stockIncident,message:'BC et tous les BL associés actualisés depuis Erplain. Étiquettes conservées.',stockHolds:source.stockHolds,comparison,adoptedLines,bc,notFound:false};
}
