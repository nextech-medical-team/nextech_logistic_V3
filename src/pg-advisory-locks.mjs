import {AsyncLocalStorage} from 'node:async_hooks';
// Session locks must not consume the pool used by the protected SQL work.
// Nested lock scopes reuse their session instead of exhausting a second pool.
export function postgresAdvisoryLocks(pool){
 const scope=new AsyncLocalStorage();
 return async(keys,fn)=>{
  const inherited=scope.getStore();
  const context=inherited||{client:await pool.connect(),discard:false};
  const {client}=context,held=[];
  const run=async()=>{
   try{
    for(const key of [...new Set(keys)].sort()){
     await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))',['nextech:'+key]);held.push(key);
    }
    return await fn();
   }finally{
    for(const key of held.reverse())try{await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',['nextech:'+key]);}catch{context.discard=true;}
   }
  };
  try{return inherited?await run():await scope.run(context,run);}
  finally{if(!inherited)client.release(context.discard||undefined);}
 };
}
