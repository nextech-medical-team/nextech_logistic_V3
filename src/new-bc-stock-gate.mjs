import {assertFullOrderStock} from './stock-gate.mjs';
import {withShipmentLock} from './shipment-lock.mjs';
const stockNumber=value=>(typeof value==='number'||typeof value==='string'&&value.trim()!=='')&&Number.isFinite(Number(value));
function locationStock(variant,location){
 const levels=variant?.stock_levels;
 if(!Array.isArray(levels?.data)||levels.paginatorInfo?.hasMorePages!==false)return null;
 const matches=levels.data.filter(row=>String(row?.location?.id)===location);
 return matches.length===1&&[matches[0].on_hand,matches[0].available].every(stockNumber)?matches[0]:null;
}
// Resolution workers may already own stock-mutations. Always acquire that
// lock before BC numbering to avoid inversion with automatic preparation.
export function withSalesBcPublicationLock(fn){
 return withShipmentLock(()=>withShipmentLock(fn,['erplain-bc-numbering']));
}
// Call immediately before CreateOrder while holding the shared stock lock.
// A new BC has no reservations of its own. Incoming quantities are excluded.
export async function assertNewBcStock(api,lines,products){
 if(!Array.isArray(lines)||!lines.length)throw Error('Stock non vérifiable avant BC : lignes absentes');
 const snapshots=new Map(),rereads=new Map(),checked=[];
 for(const line of lines){
  if(line.type==='shipping_cost'&&!line.variant)continue;
  const id=String(line.variant?.id||''),location=String(line.location?.id||'');
  const matches=products?Object.values(products).filter(v=>String(v.id)===id):[line.variant];
  if(!/^\d+$/.test(id)||!/^\d+$/.test(location)||matches.length!==1||!matches[0].sku)throw Error('Stock non vérifiable avant BC : produit absent');
  let variant=snapshots.get(id);
  if(!variant){
   const {Variants:pack}=await api.request('query V3NewBcStock($where:QueryVariantsWhereWhereConditions!){Variants(first:100,where:$where){data{id sku track_inventory stock_levels(first:100){data{location{id} on_hand available} paginatorInfo{hasMorePages}}} paginatorInfo{hasMorePages}}}',{where:{column:'SKU',operator:'EQ',value:matches[0].sku}});
   const found=pack?.data?.filter(v=>String(v.id)===id&&v.sku===matches[0].sku);
   if(pack?.paginatorInfo?.hasMorePages!==false||found?.length!==1||typeof found[0].track_inventory!=='boolean')throw Error('Stock non vérifiable avant BC : produit incomplet');
   variant=found[0];snapshots.set(id,variant);
  }
  if(!variant.track_inventory){checked.push({...line,variant});continue;}
  let stock=locationStock(variant,location);
  if(!stock){
   // Re-read the exact variant, never infer zero from an absent location or use
   // a different warehouse's quantities. Share this fresh read within this check.
   const key=id+':'+location;
   if(!Number.isSafeInteger(Number(location))||Number(location)>2147483647)throw Error('Emplacement Erplain invalide');
   if(!rereads.has(key)){
    const response=await api.request('query V3NewBcStockDetail($id:ID!,$locations:[Int]){Variant(id:$id){id sku track_inventory physicalAtLocation:on_hand(location_ids:$locations) availableAtLocation:available(location_ids:$locations) stock_levels(first:100){data{location{id} on_hand available} paginatorInfo{hasMorePages}}}}',{id,locations:[Number(location)]});
    const detail=response?.Variant;
    if(String(detail?.id)!==id||detail.sku!==variant.sku||detail.track_inventory!==true)throw Error('Stock non vérifiable avant BC : identité produit non confirmée après relecture : '+variant.sku);
    rereads.set(key,detail);
   }
   const detail=rereads.get(key);
   stock=locationStock(detail,location);
   // Erplain can return no stock-level rows for a zero balance. The filtered
   // scalar quantities still explicitly confirm physical and available stock.
   if(!stock&&[detail.physicalAtLocation,detail.availableAtLocation].every(stockNumber))stock={on_hand:detail.physicalAtLocation,available:detail.availableAtLocation};
   if(!stock)throw Error('Stock non vérifiable avant BC : '+variant.sku+' · emplacement '+location+' : quantités absentes ou incomplètes après relecture Erplain');
  }
  checked.push({...line,variant,on_hand:stock.on_hand,available:stock.available,reserved_quantity:0});
 }
 return assertFullOrderStock(checked);
}
