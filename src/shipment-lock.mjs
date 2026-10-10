import {AsyncLocalStorage} from 'node:async_hooks';
const ownership=new AsyncLocalStorage();
let database=null;
const tails=new Map();
export function configureShipmentLocks(db){database=db;}
export async function withShipmentLock(fn,keys=['stock-mutations']){
 const held=ownership.getStore()?.held||new Set();
 const ordered=[...new Set(keys)].filter(key=>!held.has(key)).sort(),releases=[];
 if(!ordered.length)return fn();
 try{for(const key of ordered){const prior=tails.get(key)||Promise.resolve();let release;const next=new Promise(r=>release=r);tails.set(key,next);await prior;releases.push(()=>{release();if(tails.get(key)===next)tails.delete(key);});}
  const work=()=>ownership.run({held:new Set([...held,...ordered])},fn);
  return database?.withLocks?await database.withLocks(ordered,work):await work();
 }finally{for(const release of releases.reverse())release();}
}
