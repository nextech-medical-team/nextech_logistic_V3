import {randomUUID} from 'node:crypto';

// Shared submission path. Execution stays in the existing resolution worker.
export async function queueResolutionRequest(db,b,user){
 const previous=(await db.query('SELECT * FROM resolution_jobs WHERE request_id=$1',[b.requestId])).rows[0];
 if(previous){const keys=x=>JSON.stringify(Object.entries(x).sort());if(keys(previous.payload)!==keys(b))throw Error('Identifiant déjà utilisé pour une autre intervention');return {id:previous.id};}
 let id=randomUUID();
 await db.transaction(async tx=>{
  if(!(await tx.query('SELECT id FROM orders WHERE id=$1 FOR UPDATE',[b.id])).rows.length)throw Error('Commande introuvable');
  if((await tx.query("SELECT 1 FROM equivalence_import_rows r JOIN equivalence_imports i ON i.id=r.batch_id WHERE r.order_id=$1 AND i.status='applying'",[b.id])).rows.length)throw Error('Import d’équivalences en cours sur cette commande : attendre son résultat');
  const active=(await tx.query("SELECT id FROM resolution_jobs WHERE order_id=$1 AND status IN ('queued','running','waiting')",[b.id])).rows[0];
  if(active){id=active.id;return;}
  await tx.query('INSERT INTO resolution_jobs(id,order_id,request_id,action,payload) VALUES($1,$2,$3,$4,$5)',[id,b.id,b.requestId,b.action,JSON.stringify(b)]);
  await tx.query("INSERT INTO audit(user_email,action,detail) VALUES($1,'resolution.requested',$2)",[user.email,JSON.stringify({id,orderId:b.id,action:b.action,type:b.type,sku:b.sku,account:'Erplain LIVE'})]);
 });return {id};
}
