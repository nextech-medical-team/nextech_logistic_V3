export const preparationReadyMessage='ERPLAIN · Passage « en préparation » vers « prêt à livrer » interdit depuis V3';
export function assertErplainReadyTransition(current,target){
 if(target==='ready_to_ship'&&current==='in_preparation'){
  const error=new Error(preparationReadyMessage);error.code='ERPLAIN_PREPARATION_READY_FORBIDDEN';throw error;
 }
}
// Only a fresh provider read can authorize a ready mutation. Unknown sources fail closed.
export async function guardErplainReadyMutation(query,variables,read){
 const hasReady=value=>value==='ready_to_ship'||value&&typeof value==='object'&&Object.values(value).some(hasReady);
 if(!hasReady(variables)&&!query.includes('ready_to_ship'))return;
 const operations=[...query.matchAll(/\b(UpdateShippingOrder(?:sStatus)?|UpdateOrder(?:sStatus)?)\s*\(([^)]*)\)/g)];
 for(const [,operation,args] of operations){
  const statusVariable=args.match(/\bstatus\s*:\s*\$(\w+)/)?.[1];
  const inputVariable=args.match(/\binput\s*:\s*\$(\w+)/)?.[1];
  const target=statusVariable?variables[statusVariable]:inputVariable?variables[inputVariable]?.status:args.match(/\bstatus\s*:\s*"?(\w+)/)?.[1];
  if(target!=='ready_to_ship')continue;
  const idVariable=args.match(/\bids?\s*:\s*\$(\w+)/)?.[1];
  const rawIds=idVariable?variables[idVariable]:args.match(/\bid\s*:\s*"?(\d+)/)?.[1];
  const ids=Array.isArray(rawIds)?rawIds:[rawIds];
  if(!ids.length||ids.some(id=>!/^\d+$/.test(String(id))))throw Error('ERPLAIN · Source du passage prêt à livrer non vérifiable');
  const entity=operation.startsWith('UpdateShipping')?'ShippingOrder':'Order';
  for(const id of ids){
   const result=await read(`query V3ReadyTransitionSource($id:ID!){${entity}(id:$id){id status}}`,{id:String(id)});
   const source=result?.[entity];
   if(String(source?.id)!==String(id)||typeof source?.status!=='string'||!source.status)throw Error('ERPLAIN · Statut de base non vérifiable : passage prêt à livrer refusé');
   assertErplainReadyTransition(source.status,target);
  }
 }
}
