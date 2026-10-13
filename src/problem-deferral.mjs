import {randomUUID} from 'node:crypto';

// A display decision only. Business workers never consult this nested field.
export async function initializeProblemDeferral(db){
 await db.exec(`CREATE TABLE IF NOT EXISTS order_problem_deferral_events(
 id TEXT PRIMARY KEY,order_id TEXT NOT NULL REFERENCES orders(id),action TEXT NOT NULL,
 note TEXT NOT NULL,user_email TEXT NOT NULL,state JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now());
 CREATE INDEX IF NOT EXISTS order_problem_deferral_events_order ON order_problem_deferral_events(order_id,created_at);`);
}
export function problemDeferralService(db){
 async function context(id){
  if(typeof id!=='string'||!id)throw Error('Commande requise');
  const order=(await db.query('SELECT id,reference,suspension,archived FROM orders WHERE id=$1',[id])).rows[0];
  if(!order)throw Object.assign(Error('Commande introuvable'),{status:404});
  const history=(await db.query('SELECT action,note,user_email,created_at FROM order_problem_deferral_events WHERE order_id=$1 ORDER BY created_at DESC,id DESC',[id])).rows;
  return {order,state:order.suspension?.problemDeferral||{},history};
 }
 async function change(input,user,active){
  if(!['admin','manager','operator'].includes(user?.role))throw Object.assign(Error('Droits insuffisants'),{status:403});
  if(typeof input?.id!=='string'||!input.id||typeof input.expectedVersion!=='string')throw Error('Commande et version requises');
  const note=typeof input.note==='string'?input.note.trim():'';
  if(!note||note.length>2000)throw Error('Saisir une note de 1 à 2000 caractères');
  return db.transaction(async tx=>{
   const order=(await tx.query('SELECT id,reference,suspension,archived FROM orders WHERE id=$1 FOR UPDATE',[input.id])).rows[0];
   if(!order)throw Object.assign(Error('Commande introuvable'),{status:404});
   if(order.archived&&active)throw Error('Commande archivée : report impossible');
   const previous=order.suspension?.problemDeferral||{};
   if((previous.version||'')!==input.expectedVersion)throw Object.assign(Error('Le report a changé : actualiser avant de confirmer'),{status:409});
   if((previous.active===true)===active)throw Error(active?'Problème déjà différé':'Problème non différé');
   const state={active,note,version:randomUUID(),updatedAt:new Date().toISOString(),updatedBy:user.email};
   await tx.query("UPDATE orders SET suspension=jsonb_set(coalesce(suspension,'{}'::jsonb),'{problemDeferral}',$2::jsonb) WHERE id=$1",[order.id,JSON.stringify(state)]);
   const action=active?'problem_deferred':'problem_restored';
   await tx.query('INSERT INTO order_problem_deferral_events(id,order_id,action,note,user_email,state) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),order.id,action,note,user.email,JSON.stringify(state)]);
   await tx.query('INSERT INTO audit(user_email,action,detail) VALUES($1,$2,$3)',[user.email,'order.'+action,JSON.stringify({orderId:order.id,note,version:state.version})]);
   return {ok:true,state,message:active?'Problème différé : retiré des problèmes actifs. Les traitements restent inchangés.':'Report levé. Le problème réapparaît dans les problèmes actifs s’il est toujours présent.'};
  });
 }
 return {context,defer:(b,u)=>change(b,u,true),restore:(b,u)=>change(b,u,false)};
}
