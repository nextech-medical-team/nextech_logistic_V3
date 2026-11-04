import {prepareFifoStockLines} from './stock-lots.mjs';
const quantity=v=>{if(v==null||String(v).trim()===''||!Number.isFinite(Number(v))||Number(v)<=0)throw Error('Lots BC : quantité invalide');return Number(v);};
export function parentAllocatedLotLines(bc,chosen,{excludeBlId=null}={}){
 if(!bc?.id||bc.status!=='active'||bc.update_stock!==true||!Array.isArray(bc.line_items)||!Array.isArray(bc.shipping_orders?.data)||bc.shipping_orders.paginatorInfo?.hasMorePages!==false)throw Error('Lots BC : document ou historique incomplet');
 const pools=new Map();
 for(const selection of chosen){
  const matches=bc.line_items.filter(l=>String(l.id)===String(selection.lineId));
  if(matches.length!==1)throw Error('Lots BC : ligne parent absente ou ambiguë');
  const l=matches[0];
  if(String(l.variant?.id)!==String(selection.variantId)||String(l.location?.id)!==String(selection.locationId)||typeof l.variant?.has_batch_numbers!=='boolean')throw Error('Lots BC : produit ou emplacement modifié');
  quantity(selection.quantity);
  if(!l.variant.has_batch_numbers)continue;
  if(pools.has(String(l.id)))continue;
  if(!Array.isArray(l.batch_numbers)||!l.batch_numbers.length)throw Error('Lots BC : affectation parent manquante');
  const pool=new Map();let total=0;
  for(const b of l.batch_numbers){const id=String(b.batch_number?.id||''),q=quantity(b.quantity);if(!/^\d+$/.test(id)||pool.has(id))throw Error('Lots BC : lot parent ambigu');pool.set(id,q);total+=q;}
  if(Math.abs(total-quantity(l.quantity))>1e-7)throw Error('Lots BC : quantités parent incomplètes');
  pools.set(String(l.id),pool);
 }
 for(const bl of bc.shipping_orders.data){
  if(String(bl.id)===String(excludeBlId)||['cancelled','unpublished'].includes(bl.status))continue;
  if(!['pending','make_the_shipment','in_preparation','ready_to_ship','shipped','delivered','completed'].includes(bl.status)||!Array.isArray(bl.line_items))throw Error('Lots BC : livraison existante non vérifiable');
  for(const l of bl.line_items){
   const pool=pools.get(String(l.parent_id));if(!pool)continue;
   const parent=bc.line_items.find(p=>String(p.id)===String(l.parent_id));
   if(String(l.variant?.id)!==String(parent.variant.id)||!Array.isArray(l.batch_numbers))throw Error('Lots BC : livraison parent incohérente');
   let total=0;
   for(const b of l.batch_numbers){const id=String(b.batch_number?.id||''),q=quantity(b.quantity);if(!pool.has(id)||pool.get(id)+1e-7<q)throw Error('Lots BC : lot déjà livré incompatible');pool.set(id,pool.get(id)-q);total+=q;}
   if(Math.abs(total-quantity(l.quantity))>1e-7)throw Error('Lots BC : lots de livraison incomplets');
  }
 }
 return chosen.map(l=>{
  const line={variant:{id:String(l.variantId)},location:{id:String(l.locationId)},quantity:quantity(l.quantity)},pool=pools.get(String(l.lineId));
  if(!pool)return line;
  let left=line.quantity;const assigned=[];
  for(const [id,available] of pool){const q=Math.min(left,available);if(q>1e-7){assigned.push({batch_number:{id},quantity:q});pool.set(id,available-q);left-=q;}if(left<=1e-7)break;}
  if(left>1e-7)throw Error('Lots BC : reliquat des lots parent insuffisant');
  return {...line,batch_numbers:assigned};
 });
}
export async function readParentAllocatedLots(api,bcId,chosen,options={}){
 const {Order:bc}=await api.request('query V3PartialParentLots($id:ID!){Order(id:$id){id status update_stock line_items{id quantity location{id} variant{id has_batch_numbers} batch_numbers{quantity batch_number{id}}} shipping_orders(first:100){data{id status line_items{parent_id quantity variant{id} location{id} batch_numbers{quantity batch_number{id}}}} paginatorInfo{hasMorePages}}}}',{id:String(bcId)});
 if(String(bc?.id)!==String(bcId))throw Error('Lots BC : identité du BC différente');
 return historicalParentOrFifoLines(bc,chosen,{...options,allocate:lines=>prepareFifoStockLines(api,lines)});
}

// Legacy BCs can have no lot reservation even when their prior BLs are valid.
// Keep allocated parent lots authoritative. For an entirely unallocated parent,
// allocate real available FIFO stock only for its verified outstanding quantity.
export async function historicalParentOrFifoLines(bc,chosen,{excludeBlId=null,allocate=async()=>{throw Error('Lots BC : lecteur FIFO absent');}}={}){
 if(!bc?.id||bc.status!=='active'||bc.update_stock!==true||!Array.isArray(bc.line_items)||bc.shipping_orders?.paginatorInfo?.hasMorePages!==false||!Array.isArray(bc.shipping_orders.data))throw Error('Lots BC : document ou historique incomplet');
 const missing=[],inherited=[],seen=new Set();
 for(let i=0;i<chosen.length;i++){
  const x=chosen[i],id=String(x.lineId),parents=bc.line_items.filter(l=>String(l.id)===id);
  if(seen.has(id)||parents.length!==1)throw Error('Lots BC : ligne parent absente ou ambiguë');seen.add(id);
  const p=parents[0];if(String(p.variant?.id)!==String(x.variantId)||String(p.location?.id)!==String(x.locationId)||typeof p.variant?.has_batch_numbers!=='boolean'||!Array.isArray(p.batch_numbers))throw Error('Lots BC : produit, emplacement ou lots non vérifiables');
  const q=quantity(x.quantity);
  if(!p.variant.has_batch_numbers||p.batch_numbers.length){inherited.push({i,x});continue;}
  let used=0;
  for(const b of bc.shipping_orders.data){
   if(String(b.id)===String(excludeBlId)||['cancelled','unpublished'].includes(b.status))continue;
   if(!['pending','make_the_shipment','in_preparation','ready_to_ship','shipped','delivered','completed'].includes(b.status)||!Array.isArray(b.line_items))throw Error('Lots BC : livraison existante non vérifiable');
   for(const l of b.line_items.filter(l=>String(l.parent_id)===id)){
    if(String(l.variant?.id)!==String(p.variant.id)||String(l.location?.id)!==String(p.location.id))throw Error('Lots BC : livraison parent incohérente');used+=quantity(l.quantity);
   }
  }
  if(q+used>quantity(p.quantity)+1e-7)throw Error('Lots BC : quantité supérieure au reliquat parent');
  missing.push({i,line:{variant:{id:String(x.variantId)},location:{id:String(x.locationId)},quantity:q}});
 }
 const result=new Array(chosen.length),known=parentAllocatedLotLines(bc,inherited.map(v=>v.x),{excludeBlId});inherited.forEach((v,i)=>result[v.i]=known[i]);
 if(missing.length){const fifo=await allocate(missing.map(v=>v.line));if(!Array.isArray(fifo)||fifo.length!==missing.length)throw Error('Lots BC : allocation FIFO incomplète');missing.forEach((v,i)=>{const l=fifo[i];if(String(l.variant?.id)!==v.line.variant.id||String(l.location?.id)!==v.line.location.id||Number(l.quantity)!==v.line.quantity||!Array.isArray(l.batch_numbers)||!l.batch_numbers.length||Math.abs(l.batch_numbers.reduce((n,b)=>n+quantity(b.quantity),0)-v.line.quantity)>1e-7||l.batch_numbers.some(b=>!/^\d+$/.test(String(b.batch_number?.id||''))))throw Error('Lots BC : allocation FIFO incohérente');result[v.i]=l;});}
 return result;
}
