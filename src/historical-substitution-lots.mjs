import {prepareFifoStockLines,assertStockLotAssignments} from './stock-lots.mjs';

export async function historicalSubstitutionItems(api,bc,plan){
 if(bc.update_stock!==true||plan.reconcileOnly)return plan.items;
 const originals=new Map((bc.line_items||plan.commercialBefore?.line_items||[]).map(l=>[String(l.id),l]));
 const requests=[],positions=[];const preserved=new Map();
 for(const [index,item] of plan.items.entries()){
  const prior=item.id?originals.get(String(item.id)):null;
  if(item.id&&!prior)throw Error('Ligne historique absente du BC : rapprochement requis');
  const line=item.id?prior:item;
  if(line.type&&line.type!=='normal'||!line.variant?.id)continue;
  if(!line.location?.id)throw Error('Emplacement historique absent');
  if(item.id&&prior.batch_numbers?.length){
   let remaining=Number(item.quantity);const lots=[];
   for(const b of prior.batch_numbers){const q=Math.min(remaining,Number(b.quantity));if(q>0){lots.push({batch_number:{id:String(b.batch_number.id)},quantity:q});remaining-=q;}}
   if(remaining!==0)throw Error('Lots historiques incomplets : rapprochement requis');
   preserved.set(index,lots);continue;
  }
  positions.push(index);requests.push({variant:{id:String(line.variant.id)},location:{id:String(line.location.id)},quantity:Number(item.quantity)});
 }
 const assigned=await prepareFifoStockLines(api,requests);
 for(const [i,index] of positions.entries())if(assigned[i].batch_numbers?.length)preserved.set(index,assigned[i].batch_numbers);
 return plan.items.map((item,index)=>preserved.has(index)?{...item,batch_numbers:preserved.get(index)}:item);
}

export function verifyHistoricalSubstitutionLots(updated,plan){
 const expected=plan.items.filter(l=>!l.id&&l.batch_numbers?.length);
 if(expected.length){
  const existing=new Set(plan.commercialBefore.line_items.map(l=>String(l.id)));
  assertStockLotAssignments(updated.line_items.filter(l=>!existing.has(String(l.id))),expected);
 }
 for(const item of plan.items.filter(l=>l.id&&l.batch_numbers?.length)){
  const actual=updated.line_items.find(l=>String(l.id)===String(item.id));
  if(!actual)throw Error('Ligne historique absente après remplacement');
  assertStockLotAssignments([actual],[{variant:actual.variant,location:actual.location,batch_numbers:item.batch_numbers}]);
 }
}

