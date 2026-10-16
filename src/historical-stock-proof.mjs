import {usesNativeBlCycle,readNativeBlCycle} from './native-bl-policy.mjs';
import {assertFullOrderStock} from './stock-gate.mjs';
// Match only the existing preparable BL, while keeping the full BC for its stock ledger.
export function historicalPendingLines(bc,bl,{allowPendingSiblings=false}={}){
 const all=bc?.line_items,connection=bc?.shipping_orders;
 if(!bl?.id||!['pending','make_the_shipment','in_preparation','ready_to_ship'].includes(bl.status)||!Array.isArray(all)||!Array.isArray(connection?.data)||connection.paginatorInfo?.hasMorePages!==false)throw Error('BL historique en attente non vérifiable');
 const chosen=connection.data.filter(x=>String(x.id)===String(bl.id));
 if(chosen.length!==1||!Array.isArray(chosen[0].line_items))throw Error('Association du BL en attente au BC non vérifiée');
 const fulfilled=new Map(),selected=new Map();
 function allocations(shipment,target){
  if(!Array.isArray(shipment.line_items))throw Error('Quantités BL historiques non reçues');
  for(const item of shipment.line_items){
   if(item.type==='shipping_cost')continue;
   let matches=item.parent_id?all.filter(l=>String(l.id)===String(item.parent_id)):[];
   if(!matches.length)matches=all.filter(l=>String(l.variant?.id)===String(item.variant?.id)&&String(l.location?.id)===String(item.location?.id));
   const q=Number(item.quantity);
   if(matches.length!==1||String(matches[0].variant?.id)!==String(item.variant?.id)||String(matches[0].location?.id)!==String(item.location?.id)||!Number.isFinite(q)||q<=0)throw Error('Lignes du BL historique ambiguës ou incohérentes');
   const key=String(matches[0].id);target.set(key,(target.get(key)||0)+q);
  }
 }
 for(const other of connection.data){
  if(String(other.id)===String(bl.id)||other.status==='cancelled')continue;
  if(!(allowPendingSiblings?['pending','make_the_shipment','in_preparation','ready_to_ship','shipped','delivered','completed']:['shipped','delivered','completed']).includes(other.status))throw Error('Autre BL encore en préparation : choisir la livraison à rapprocher');
  allocations(other,fulfilled);
 }
 allocations(chosen[0],selected);
 const result=all.filter(l=>selected.has(String(l.id))).map(l=>{
  const q=selected.get(String(l.id));
  if(!Number.isFinite(Number(l.quantity))||q+(fulfilled.get(String(l.id))||0)>Number(l.quantity)+1e-7)throw Error('Quantités du BL en attente supérieures au reliquat du BC');
  return {...l,quantity:q};
 });
 if(!result.length)throw Error('BL en attente sans produit');
 return result;
}
// Read-only proof for BCs that already deducted stock. No mutations here.
export function verifyHistoricalStock(bc, evidence,{bl=null,blEvidence=[],pendingBlScope=false,beforeBlPublication=false,allowPendingSiblings=false,reservationOnly=false}={}){
 const fail=reason=>{throw Error('Stock du BC historique non rapproché : '+reason);};
 if(!bc?.id||bc.update_stock!==true||bc.status!=='active')return fail('politique ou statut');
 if(!Array.isArray(bc.line_items)||!Array.isArray(evidence)||!Array.isArray(bc.shipping_orders?.data)||bc.shipping_orders.paginatorInfo?.hasMorePages!==false)return fail('documents incomplets');
 if(!bc.line_items.some(l=>l.type==='normal'))return fail('aucun produit');
 // Erplain omits unpublished BLs from Order.shipping_orders. For a saved
 // draft ID only, require the complete reverse relation to exactly this BC.
 if(bl){
  const selected=pendingBlScope?historicalPendingLines(bc,bl,{allowPendingSiblings}):null;
  if(!bl.id||typeof bl.update_stock!=='boolean'||(!pendingBlScope&&!((bc.shipping_orders.data.length===1&&String(bc.shipping_orders.data[0].id)===String(bl.id))||(bl.status==='unpublished'&&bc.shipping_orders.data.length===0&&bl.orders?.paginatorInfo?.hasMorePages===false&&bl.orders?.data?.length===1&&String(bl.orders.data[0].id)===String(bc.id))))||!['unpublished','pending','ready_to_ship','make_the_shipment','in_preparation'].includes(bl.status))return fail('BL associé ou politique de stock non conforme');
  const quantities=rows=>{const m=new Map();if(!Array.isArray(rows))return fail('lignes BL absentes');for(const l of rows){if(l.type==='shipping_cost')continue;if(l.type!=='normal'||!l.variant?.id||!l.location?.id||l.quantity==null||!Number.isFinite(Number(l.quantity))||Number(l.quantity)<=0)return fail('lignes BL invalides');const key=String(l.variant.id)+':'+String(l.location.id);m.set(key,(m.get(key)||0)+Number(l.quantity));}return JSON.stringify([...m].sort());};
  if(quantities(bl.line_items)!==quantities(selected||bc.line_items))return fail('quantités ou emplacements BC/BL différents');
  if(bl.update_stock===true){
   const variants=new Set(bl.line_items.filter(l=>l.type==='normal').map(l=>String(l.variant.id)));
   for(const variant of variants){
    const packs=blEvidence.filter(e=>String(e.variant)===variant);
    if(packs.length!==1||packs[0].complete!==true||String(packs[0].bl)!==String(bl.id)||!Array.isArray(packs[0].rows))return fail('journal BL incomplet');

   }
  }
 }else if(bc.shipping_orders.data.length)return fail('BL existant');
 const expected=new Map();
 for(const l of bc.line_items){
  if(l.type==='shipping_cost')continue;
  if(l.type!=='normal'||!l.variant?.id||!l.location?.id||!Number.isFinite(Number(l.quantity))||Number(l.quantity)<=0)return fail('ligne invalide');
  if(l.variant.track_inventory===false)continue;
  const key=String(l.variant.id)+':'+String(l.location.id);
  expected.set(key,(expected.get(key)||0)+Number(l.quantity));
 }
 // Include removed variants when verifying a replacement: their net movement
 // for this BC must now be zero, otherwise old stock has not been restored.
 const variants=new Set([...expected.keys()].map(k=>k.split(':')[0]).concat(evidence.map(e=>String(e.variant))));
 const totals=new Map(),ids=new Set();
 for(const variant of variants){
  const packs=evidence.filter(e=>String(e.variant)===variant);
  if(packs.length!==1||packs[0].complete!==true||String(packs[0].bc)!==String(bc.id)||!Array.isArray(packs[0].order))return fail('journal incomplet');
  for(const row of packs[0].order){
   if(String(row.document_id)!==String(bc.id)||row.order_type!=='Order'||String(row.variant?.id)!==variant||!row.location?.id||!row.id||ids.has(String(row.id)))return fail('journal incohérent');
   const hand=row.on_hand_diff,available=row.available_diff;
   if([hand,available].some(v=>v==null||String(v).trim()===''||typeof v==='boolean'||!Number.isFinite(Number(v))))return fail('mouvement incomplet');
   ids.add(String(row.id));const key=variant+':'+String(row.location.id),prior=totals.get(key)||{hand:0,available:0};
   totals.set(key,{hand:prior.hand+Number(hand),available:prior.available+Number(available)});
  }
 }
 // Erplain can reserve on the BC (available only), then deduct physical stock
 // on its BLs. Reconcile both typed ledgers; never create a second deduction.
 const reserved=expected.size>0&&[...new Set([...expected.keys(),...totals.keys()])].every(key=>{const q=expected.get(key)||0,t=totals.get(key)||{hand:0,available:0};return Math.abs(t.hand)<1e-7&&Math.abs(t.available+q)<1e-7;});
 if(reserved){
  if(reservationOnly){
   if(bl||bc.shipping_orders.data.length||evidence.some(p=>!Array.isArray(p.shipping)||p.shipping.length)||blEvidence.length)return fail('réservation seule avec BL ou mouvement existant');
   for(const l of bc.line_items.filter(l=>l.type==='normal')){
    if(typeof l.variant.track_inventory!=='boolean')return fail('politique produit non vérifiée');
    if(!l.variant.track_inventory)continue;
    if(l.shipped_quantity!==0)return fail('expédition déjà commencée');
   }
   return {bcId:String(bc.id),stockOnBc:false,reservationVerified:true,physicalDebitVerified:false,stockModel:'reservation_bc_only',quantities:[...expected].map(([key,quantity])=>({key,quantity})),logIds:[...ids].sort()};
  }
  // A reservation is sufficient only before creating/publishing the first BL.
  // Final validation still requires its independently reconciled physical debit.
  if(beforeBlPublication===true&&(!bl||bl.status==='unpublished')){
   if(pendingBlScope||bc.shipping_orders.data.length||bl&&bl.update_stock!==true)return fail('réservation avant BL non exclusive');
   if(evidence.some(p=>!Array.isArray(p.shipping)||p.shipping.length)||blEvidence.some(p=>p.rows.length))return fail('mouvement BL présent avant publication');
   for(const l of bc.line_items){
    if(l.type==='shipping_cost')continue;
    if(typeof l.variant.track_inventory!=='boolean')return fail('politique produit non vérifiée');
    if(!l.variant.track_inventory)continue;
    const number=v=>typeof v==='number'&&Number.isFinite(v);
    if(!number(l.on_hand)||!number(l.shipped_quantity)||l.shipped_quantity!==0)return fail('stock physique ou expédition non vérifiable');
   }
   assertFullOrderStock(bc.line_items,{preserveInstalled:true});
   return {bcId:String(bc.id),stockOnBc:true,stockModel:'reservation_bc_avant_bl',beforeBlPublication:true,quantities:[...expected].map(([key,quantity])=>({key,quantity})),logIds:[...ids].sort()};
  }
  if(!bl||bl.update_stock!==true)return fail('réservation BC sans mouvement BL vérifiable');
  const shipments=bc.shipping_orders.data,shipmentIds=new Set(),shipped=new Map(),physical=new Map(),parents=new Map();
  for(const shipment of shipments){
   const sid=String(shipment.id||'');
   if(!sid||shipmentIds.has(sid)||!['pending','make_the_shipment','in_preparation','ready_to_ship','shipped','delivered','completed','cancelled'].includes(shipment.status)||typeof shipment.update_stock!=='boolean'||!Array.isArray(shipment.line_items))return fail('documents BL incomplets');
   shipmentIds.add(sid);
   if(shipment.status==='cancelled')continue;
   if(shipment.update_stock!==true)return fail('politique de stock BL différente');
   for(const l of shipment.line_items){
    if(l.type==='shipping_cost')continue;
    const parent=bc.line_items.filter(x=>String(x.id)===String(l.parent_id));
    if(l.type!=='normal'||parent.length!==1||String(parent[0].variant?.id)!==String(l.variant?.id)||String(parent[0].location?.id)!==String(l.location?.id)||!Number.isFinite(Number(l.quantity))||Number(l.quantity)<=0)return fail('lignes BL incohérentes');
    if(parent[0].variant.track_inventory===false)continue;
    const pid=String(l.parent_id);parents.set(pid,(parents.get(pid)||0)+Number(l.quantity));if(parents.get(pid)>Number(parent[0].quantity)+1e-7)return fail('quantités BL supérieures à la ligne du BC');
    const key=String(l.variant.id)+':'+String(l.location.id),docKey=sid+':'+key;
    shipped.set(key,(shipped.get(key)||0)+Number(l.quantity));physical.set(docKey,(physical.get(docKey)||0)+Number(l.quantity));
   }
  }
  for(const [key,q] of shipped)if(q>(expected.get(key)||0)+1e-7)return fail('quantités BL supérieures au BC');
  const ledgerRow=r=>[String(r.id),String(r.document_id),r.order_type,String(r.variant?.id),String(r.location?.id),Number(r.on_hand_diff),Number(r.available_diff)];
  for(const pack of blEvidence){const all=evidence.find(e=>String(e.variant)===String(pack.variant))?.shipping;if(!Array.isArray(all)||JSON.stringify(pack.rows.map(ledgerRow).sort())!==JSON.stringify(all.filter(r=>String(r.document_id)===String(bl.id)).map(ledgerRow).sort()))return fail('journal BL modifié pendant la lecture');}
  const movements=new Map();
  for(const pack of evidence){
   if(!Array.isArray(pack.shipping))return fail('journal de tous les BL incomplet');
   for(const row of pack.shipping){
    if(!shipmentIds.has(String(row.document_id))||row.order_type!=='ShippingOrder'||String(row.variant?.id)!==String(pack.variant)||!row.location?.id||!row.id||ids.has(String(row.id)))return fail('journal BL incohérent');
    if([row.on_hand_diff,row.available_diff].some(v=>v==null||String(v).trim()===''||typeof v==='boolean'||!Number.isFinite(Number(v))))return fail('mouvement BL incomplet');
    ids.add(String(row.id));const key=String(row.document_id)+':'+String(row.variant.id)+':'+String(row.location.id),prior=movements.get(key)||{hand:0,available:0};
    movements.set(key,{hand:prior.hand+Number(row.on_hand_diff),available:prior.available+Number(row.available_diff)});
   }
  }
  for(const key of new Set([...physical.keys(),...movements.keys()])){const q=physical.get(key)||0,t=movements.get(key)||{hand:0,available:0};if(Math.abs(t.hand+q)>1e-7||Math.abs(t.available)>1e-7)return fail('mouvements physiques BL différents des quantités');}
  return {bcId:String(bc.id),stockOnBc:true,stockModel:'reservation_bc_sortie_bl',checkedBlIds:[...shipmentIds].sort(),quantities:[...expected].map(([key,quantity])=>({key,quantity})),logIds:[...ids].sort()};
 }
 if(bl?.update_stock===true&&blEvidence.some(p=>p.rows.length))return fail('mouvement BL supplémentaire à rapprocher');
 for(const key of new Set([...expected.keys(),...totals.keys()])){
  const q=expected.get(key)||0,t=totals.get(key)||{hand:0,available:0};
  if(Math.abs(t.hand+q)>1e-7||Math.abs(t.available+q)>1e-7)return fail('quantités déjà déduites différentes');
 }
 return {bcId:String(bc.id),stockOnBc:true,quantities:[...expected].map(([key,quantity])=>({key,quantity})),logIds:[...ids].sort()};
}

export async function readHistoricalStock(api,bc,{additionalVariants=[],bl=null,pendingBlScope=false,beforeBlPublication=false,allowPendingSiblings=false,reservationOnly=false}={}){
 const created=String(bc?.created_at||'');
 const stamp=/(Z|[+-]\d{2}:\d{2})$/.test(created)?created:created.replace(' ','T')+'Z';
 if(!/^\d{4}-\d{2}-\d{2}[ T]/.test(created)||!Number.isFinite(Date.parse(stamp)))throw Error('Date de création du BC historique non vérifiée');
 const since=created.slice(0,10)+' 00:00:00';
 const variants=[...new Set(bc.line_items.filter(l=>l.type==='normal'&&l.variant?.track_inventory!==false).map(l=>String(l.variant.id)).concat(additionalVariants.map(String)))];
 const evidence=[];
 for(const variant of variants){
  if(!/^\d+$/.test(variant))throw Error('Variante historique invalide');
  const rows=[],shipping=[];let complete=false;
  for(let page=1;page<=100;page++){
   const r=await api.request('query V3HistoricalStockLogs($where:QueryInventoryLogsWhereWhereConditions!,$page:Int!){InventoryLogs(first:100,page:$page,where:$where){data{id document_id source order_type on_hand_diff available_diff variant{id sku} location{id} created_at} paginatorInfo{hasMorePages}}}',{page,where:{AND:[{column:'VARIANT_ID',operator:'EQ',value:variant},{column:'CREATED_AT',operator:'GTE',value:since}]}});
   const logs=r.InventoryLogs;if(!Array.isArray(logs?.data)||typeof logs.paginatorInfo?.hasMorePages!=='boolean')throw Error('Journal de stock historique incomplet');
   // Validate before filtering: an unidentified row may belong to this BC.
   // A missing document/type must never be treated as an unrelated movement.
   if(logs.data.some(l=>!l?.id||l.document_id==null||String(l.document_id).trim()===''||!l.order_type||String(l.variant?.id)!==variant))throw Error('Journal de stock historique incomplet : mouvement non identifié');
   rows.push(...logs.data.filter(l=>String(l.document_id)===String(bc.id)&&l.order_type==='Order'));
   shipping.push(...logs.data.filter(l=>l.order_type==='ShippingOrder'&&bc.shipping_orders.data.some(b=>String(b.id)===String(l.document_id))));
   if(!logs.paginatorInfo.hasMorePages){complete=true;break;}
  }
  if(!complete)throw Error('Journal de stock historique trop volumineux : contrôle requis');
  evidence.push({bc:String(bc.id),variant,complete,order:rows,shipping,since});
 }
 const blEvidence=bl?.update_stock===true?await readInheritedBlLedger(api,bl):[];
 return {evidence,blEvidence,proof:verifyHistoricalStock(bc,evidence,{bl,blEvidence,pendingBlScope,beforeBlPublication,allowPendingSiblings,reservationOnly})};
}

// A stock-on-BC proof must not coexist with a separate V3 stock deduction.
// Read only, including the lost-response case where V3 saved no document ID.
export async function assertNoHistoricalStockRemoval(api,o){
 if(o.erp_live?.stockDocument?.id||o.erp_live?.stockCreationAttemptedAt)throw Error('BC historique : sortie de stock V3 à rapprocher avant continuation');
 const labels=[...new Set(['V3FS-'+o.id,'V3FS-'+o.id+'-BC'+o.erp_live?.bc?.id])];
 for(const label of labels){
  const r=await api.request('query V3HistoricalExtraStock($where:QueryStockRemovalsWhereWhereConditions!){StockRemovals(first:2,where:$where){data{id status update_stock} paginatorInfo{hasMorePages}}}',{where:{column:'LABEL',operator:'EQ',value:label}});
  if(!Array.isArray(r.StockRemovals?.data)||r.StockRemovals.paginatorInfo?.hasMorePages!==false||r.StockRemovals.data.length)throw Error('BC historique : sortie de stock supplémentaire ou recherche incomplète, rapprochement requis');
 }
}

export async function historicalPreparationProof(api,o,{beforeBlPublication=false}={}){
 if(usesNativeBlCycle(o))return (await readNativeBlCycle(api,o,{beforeBlPublication})).observation;
 const id=String(o.erp_live?.bc?.id||'');
 if(!/^\d+$/.test(id))throw Error('BC historique non identifié');
 const r=await api.request('query V3HistoricalPreparation($id:ID!){Order(id:$id){id created_at status update_stock line_items{id type quantity reserved_quantity shipped_quantity on_hand available location{id} variant{id sku track_inventory}} shipping_orders(first:100){data{id status update_stock line_items{parent_id type quantity location{id} variant{id}}} paginatorInfo{hasMorePages}}}}',{id});
 const bc=r.Order;
 if(String(bc?.id)!==id)throw Error('BC historique demandé non reçu');
 const expected=rows=>{const m=new Map();if(!Array.isArray(rows))throw Error('Produits historiques absents');for(const l of rows){if(l.type==='shipping_cost')continue;if((l.type&&l.type!=='normal')||!l.variant?.id||!l.location?.id||!Number.isFinite(Number(l.quantity))||Number(l.quantity)<=0)throw Error('Produits historiques incomplets');const k=String(l.variant.id)+':'+String(l.location.id);m.set(k,(m.get(k)||0)+Number(l.quantity));}return JSON.stringify([...m].sort());};
 const pendingBlScope=Boolean(o.source_payload?.erplainImported&&o.source_payload?.account==='live'&&o.erp_live.pendingBlIds?.length);
 if(!pendingBlScope&&expected(o.items)!==expected(bc.line_items))throw Error('BC historique modifié : produits ou quantités à rapprocher');
 let bl=null;
 if(o.erp_live.bl?.id){
  const result=await api.request('query V3HistoricalPreparationBL($id:ID!){ShippingOrder(id:$id){id created_at status update_stock orders(first:100){data{id} paginatorInfo{hasMorePages}} line_items{type quantity location{id} variant{id}}}}',{id:String(o.erp_live.bl.id)});
  bl=result.ShippingOrder;
  if(String(bl?.id)!==String(o.erp_live.bl.id))throw Error('BL historique demandé non reçu');
 }
 if(pendingBlScope){if(!bl||!o.erp_live.pendingBlIds.map(String).includes(String(bl.id))||expected(o.items)!==expected(historicalPendingLines(bc,bl)))throw Error('BL en attente modifié : produits ou quantités à rapprocher');}
 await assertNoHistoricalStockRemoval(api,o);
 return (await readHistoricalStock(api,bc,{bl,pendingBlScope,beforeBlPublication,additionalVariants:(o.erp_live.historicalStockProof?.quantities||[]).map(l=>l.key.split(':')[0])})).proof;
}

// A BC that already deducted both quantities may pass its immutable flag to
// the BL. Existing Erplain cycles retain their single deduction on the BC.
// Never infer that solely from flags: require a complete BL ledger with no
// independent movement, before AND after publication through preparationProof.
export async function readInheritedBlLedger(api,bl){
 const created=String(bl?.created_at||'');
 if(!bl?.id||!/^\d{4}-\d{2}-\d{2}[ T]/.test(created)||!Number.isFinite(Date.parse(created.replace(' ','T'))))throw Error('Journal BL historique : date absente');
 const evidence=[];
 for(const variant of new Set(bl.line_items.filter(l=>l.type==='normal').map(l=>String(l.variant.id)))){
  if(!/^\d+$/.test(variant))throw Error('Journal BL historique : variante invalide');
  const rows=[];let complete=false;
  for(let page=1;page<=100;page++){
   const {InventoryLogs:logs}=await api.request('query V3InheritedBlLedger($where:QueryInventoryLogsWhereWhereConditions!,$page:Int!){InventoryLogs(first:100,page:$page,where:$where){data{id document_id order_type on_hand_diff available_diff location{id} variant{id}} paginatorInfo{hasMorePages}}}',{page,where:{AND:[{column:'VARIANT_ID',operator:'EQ',value:variant},{column:'CREATED_AT',operator:'GTE',value:created.slice(0,10)+' 00:00:00'}]}});
   if(!Array.isArray(logs?.data)||typeof logs.paginatorInfo?.hasMorePages!=='boolean'||logs.data.some(l=>!l?.id||l.document_id==null||String(l.document_id).trim()===''||!l.order_type||String(l.order_type).trim()===''||String(l.variant?.id)!==variant))throw Error('Journal BL historique incomplet');
   rows.push(...logs.data.filter(l=>String(l.document_id)===String(bl.id)&&l.order_type==='ShippingOrder'));
   if(!logs.paginatorInfo.hasMorePages){complete=true;break;}
  }
  if(!complete)throw Error('Journal BL historique trop volumineux');
  evidence.push({bl:String(bl.id),variant,complete,rows});
 }
 return evidence;
}
