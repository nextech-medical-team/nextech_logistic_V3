import {prepareFifoStockLines,assertStockLotAssignments} from './stock-lots.mjs';

// Historical BCs debit stock during UpdateOrder. Assign lots to the newly
// added lines there; existing line IDs retain their already debited stock.
export async function historicalSubstitutionItems(api,bc,plan){
 if(bc.update_stock!==true||plan.reconcileOnly)return plan.items;
 const added=plan.items.filter(l=>!l.id&&l.variant?.id);
 const assigned=await prepareFifoStockLines(api,added);
 let index=0;
 return plan.items.map(l=>{
  if(l.id||!l.variant?.id)return l;
  const allocation=assigned[index++];
  return {...l,...(allocation.batch_numbers?{batch_numbers:allocation.batch_numbers}:{})};
 });
}

export function verifyHistoricalSubstitutionLots(updated,plan){
 const expected=plan.items.filter(l=>!l.id&&l.batch_numbers?.length);
 if(!expected.length)return;
 const existing=new Set(plan.commercialBefore.line_items.map(l=>String(l.id)));
 const added=updated.line_items.filter(l=>!existing.has(String(l.id)));
 assertStockLotAssignments(added,expected);
}
