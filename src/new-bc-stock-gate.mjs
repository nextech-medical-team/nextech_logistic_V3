import {assertFullOrderStock} from './stock-gate.mjs';
// Call immediately before CreateOrder while holding the shared stock lock.
// A new BC has no reservations of its own. Incoming quantities are excluded.
export async function assertNewBcStock(api,lines,products){
 if(!Array.isArray(lines)||!lines.length)throw Error('Stock non vérifiable avant BC : lignes absentes');
 const snapshots=new Map(),checked=[];
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
  const levels=variant.stock_levels,found=levels?.data?.filter(s=>String(s.location?.id)===location);
  if(levels?.paginatorInfo?.hasMorePages!==false||found?.length!==1)throw Error('Stock non vérifiable avant BC : emplacement incomplet');
  checked.push({...line,variant,on_hand:found[0].on_hand,available:found[0].available,reserved_quantity:0});
 }
 return assertFullOrderStock(checked);
}
