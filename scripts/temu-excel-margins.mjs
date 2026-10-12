import {createMarginsService} from '../src/margins-service.mjs';

// Feed the existing calculator with Excel source lines and the quantities actually prepared in TEST.
export function excelMargins({db,documents,snapshotLoader}){
 let calculator;
 async function loadData(){
  const orders=(await db.query("SELECT * FROM orders WHERE archived=false AND channel='temu' ORDER BY reference")).rows;
  const lines=[];
  for(const o of orders){
   const source=(await db.query('SELECT * FROM lines WHERE order_id=$1 ORDER BY source_line',[o.id])).rows;
   const state=await documents.state(o.reference),items=state.pricing?.items?.filter(l=>l.variant)||[];
   for(const [i,l]of source.entries())lines.push({...l,...(items[i]?{target_sku:items[i].description,target_quantity:items[i].quantity}:{})});
  }
  return {orders,lines};
 }
 return {async get({reference}={}){
  try{
   calculator??=await createMarginsService(db,{loadData,snapshotLoader});
   const snapshot=await calculator.get({fresh:true});
   if(snapshot.available===false){calculator=null;throw Object.assign(Error(snapshot.reason),{code:'ENOENT'});}
   return {...snapshot,rows:reference?snapshot.rows.filter(r=>r.reference===reference):snapshot.rows};
  }catch(e){
   const issue=e.code==='ENOENT'?'Référentiel privé des coûts absent : marge indisponible.':'Calcul de marge indisponible : '+e.message;
   return {calculatedAt:new Date().toISOString(),rows:reference?[{reference,status:'incomplete',profit:null,issues:[issue]}]:[],error:issue};
  }
 }};
}
