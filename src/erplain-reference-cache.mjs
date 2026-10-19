import {createHash} from 'node:crypto';
const caches=new WeakMap();
const inFlight=new WeakMap();
// Read-only lookups and document display/refresh. Mutation guards, final stock
// checks, numbering and transition-status reads are intentionally absent.
const concurrentReads=new Set(['V3MissingProductLookup','V3BcLookup','V3ResolveSKU','V3EquivalentCatalog','V3StockInformation','V3DocumentRead']);
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
async function concurrentReference(config,query,variables,fetchImpl,load){
 const operation=/^query\s+(\w+)/.exec(query)?.[1];
 if(process.env.ERPLAIN_INFLIGHT_READS==='0'||!concurrentReads.has(operation))return load();
 const key=createHash('sha256').update(JSON.stringify([config.url,config.companyId,config.apiKey,query,canonical(variables)])).digest('hex');
 let pending=inFlight.get(fetchImpl);if(!pending){pending=new Map();inFlight.set(fetchImpl,pending);}
 if(pending.has(key))return structuredClone(await pending.get(key));
 if(pending.size>=128)return load();
 const promise=Promise.resolve().then(load);pending.set(key,promise);
 try{return structuredClone(await promise);}finally{if(pending.get(key)===promise)pending.delete(key);}
}
// Only account identity, for ten seconds. Documents, stock, fiscal references,
// searches and mutation guards always use a fresh read.
const allowed=new Map([
 ['query V3CheckAccount { Company { id label } }',10000],
 ['query V3RateLimitIdentity { Company { id } }',10000]
]);
export async function sharedErplainReference(config,query,variables,fetchImpl,load){
 const ttl=allowed.get(query);
 if(!ttl||Object.keys(variables||{}).length)return concurrentReference(config,query,variables,fetchImpl,load);
 const identity=createHash('sha256').update(JSON.stringify([config.url,config.companyId,config.apiKey,query])).digest('hex');
 let cache=caches.get(fetchImpl);if(!cache){cache=new Map();caches.set(fetchImpl,cache);}
 const old=cache.get(identity);
 if(old&&(old.pending||old.until>Date.now()))return structuredClone(await old.promise);
 if(cache.size>=100)for(const [key,value] of cache)if(!value.pending&&value.until<=Date.now())cache.delete(key);
 if(cache.size>=100)cache.delete(cache.keys().next().value);
 const entry={pending:true,until:0};
 entry.promise=Promise.resolve().then(load).then(value=>{entry.pending=false;entry.until=Date.now()+ttl;return value;},error=>{if(cache.get(identity)===entry)cache.delete(identity);throw error;});
 cache.set(identity,entry);
 return structuredClone(await entry.promise);
}
