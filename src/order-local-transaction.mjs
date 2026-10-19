// Local-only changes: no provider call may run inside this transaction.
export const LOCAL_ORDER_BUDGET_MS=4500;
export function localOrderBusy(cause){return Object.assign(new Error('Modification non enregistrée : commande occupée ou V3 momentanément chargé. Actualiser le résultat avant de réessayer.'),{status:423,code:'LOCAL_ORDER_BUSY',cause});}
export async function orderLocalTransaction(pool,change,{budgetMs=LOCAL_ORDER_BUDGET_MS}={}){
 const started=performance.now(),remaining=()=>Math.floor(budgetMs-(performance.now()-started));
 let expired=false,timer;
 const pending=pool.connect();
 // A late checkout must only be released, never execute the abandoned change.
 const connection=new Promise((resolve,reject)=>{
  timer=setTimeout(()=>{expired=true;reject(localOrderBusy());},Math.min(1500,budgetMs));
  pending.then(client=>{if(expired){client.release();return;}clearTimeout(timer);resolve(client);},error=>{clearTimeout(timer);reject(error);});
 });
 const client=await connection.catch(error=>{error.phase='connection';error.timings={connectionMs:Math.round(performance.now()-started)};throw error;}),connectionMs=Math.round(performance.now()-started);let committed=false,commitAttempted=false,discard=false;
 const run=async(text,values=[],timeout=Math.max(1,remaining()))=>{
  if(text==='COMMIT')commitAttempted=true;
  try{return await client.query({text,values,query_timeout:timeout});}
  catch(error){if(/Query read timeout|Connection terminated|connection ended/i.test(error.message||'')){discard=true;client.connection?.stream?.destroy();if(commitAttempted)throw Object.assign(new Error('Résultat de la modification à vérifier dans V3. Aucun nouvel envoi automatique.'),{status:503,code:'LOCAL_ORDER_UNCERTAIN',cause:error});throw localOrderBusy(error);}throw error;}
 };
 try{
  await run("BEGIN; SET LOCAL lock_timeout='1s'; SET LOCAL statement_timeout='3s'");
  const query=async(sql,params=[])=>{
   const left=remaining();if(left<=0)throw localOrderBusy();
   await run("SELECT set_config('statement_timeout',$1,true)",[Math.min(left,3000)+'ms']);
   if(remaining()<=0)throw localOrderBusy();
   return run(sql,params);
  };
  const result=await change({query,exec:sql=>query(sql)});
  await query('COMMIT');committed=true;
  return {result,timings:{connectionMs,transactionMs:Math.round(performance.now()-started)-connectionMs,totalMs:Math.round(performance.now()-started)}};
 }catch(error){
  if(!discard)await run('ROLLBACK',[],1000).catch(()=>{discard=true;client.connection?.stream?.destroy();});
  const reported=error.code==='55P03'||error.code==='57014'?localOrderBusy(error):error;reported.phase=commitAttempted?'commit':'transaction';reported.timings={connectionMs,transactionMs:Math.round(performance.now()-started)-connectionMs};throw reported;
 }finally{client.release(discard||(!committed&&client.connection?.stream?.destroyed)?true:undefined);}
}
