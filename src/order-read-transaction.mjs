// Complex correlated diagnostic predicates cost more to JIT-compile than to
// execute for an interactive page. Scope the setting to this read-only snapshot;
// pooled sessions and business transactions retain their existing settings.
export async function orderReadTransaction(pool,read,wrap){
 const client=await pool.connect();
 try{
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await client.query('SET LOCAL jit=off');
  const result=await read(wrap(client));
  await client.query('COMMIT');
  return result;
 }catch(error){
  await client.query('ROLLBACK').catch(()=>{});
  throw error;
 }finally{client.release();}
}
