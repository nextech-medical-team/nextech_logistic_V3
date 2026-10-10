const carrierName=name=>name?.startsWith('gls')?'gls':name;

export async function loadTrackingTargets(db,orderId=null){
 const {rows}=await db.query(`SELECT o.id,o.reference,o.channel,o.carrier,o.transport_choice,o.simulation,o.partial_mode,o.suspension,
 o.source_payload->>'mallId' AS mall_id,o.erp_live->'bc'->>'id' AS bc_id,o.erp_live->'bl'->>'id' AS bl_id,
 (SELECT row_to_json(c) FROM carrier_jobs c WHERE c.order_id=o.id) AS job,
 (SELECT json_agg(x ORDER BY x.id) FROM extra_parcels x WHERE x.order_id=o.id AND x.status NOT IN ('failed','cancelled')) AS extras,
 (SELECT json_agg(p ORDER BY p.id) FROM partial_deliveries p WHERE p.order_id=o.id AND p.status<>'cancelled') AS partials,
 (SELECT json_build_object('packages',t.packages,'status',t.status,'source',t.result->>'source') FROM temu_label_jobs t WHERE t.reference=o.reference) AS temu
 FROM orders o WHERE NOT o.archived AND ($1::text IS NULL OR o.id=$1) ORDER BY o.id`,[orderId]);
 const targets=[];
 for(const o of rows){
  const common={orderId:o.id,reference:o.reference,bcId:o.bc_id,mallId:o.mall_id};
  const held=o.suspension?.active||o.suspension?.erplainCancellation;
  if(o.partial_mode){
   for(const p of o.partials||[]){
    if(p.environment!=='production')continue;
    targets.push({...common,partialId:p.id,blId:p.bl?.id&&String(p.bl.id),carrier:carrierName(p.carrier),environment:p.environment,tracking:p.tracking||[],issue:held?'Commande suspendue':p.status!=='ready'?'Livraison partielle non prête':null});
   }
  }else if(o.channel==='temu'&&!o.transport_choice&&(!o.simulation||o.temu?.source==='temu_direct')){
   targets.push({...common,blId:o.bl_id,carrier:'temu',environment:'production',packages:o.temu?.packages||[],tracking:[],issue:held?'Commande suspendue':o.temu?.status==='cancelled'?'Commande TEMU annulée':null});
  }else if(o.job?.environment==='production'){
   const extras=o.extras||[];
   const carrier=carrierName(o.job.carrier);
   targets.push({...common,blId:o.bl_id,carrier,environment:'production',tracking:[...(o.job.tracking||[]),...extras.map(p=>p.tracking)],issue:held?'Commande suspendue':o.job.status!=='ready'||extras.some(p=>p.status!=='ready'||p.environment!=='production'||carrierName(p.carrier)!==carrier)?'Préparation ou transport des colis incomplet':null});
  }
 }
 return targets;
}

export function trackingSyncStore(db){
 return {
  async assertCarrierAvailable(carrier){
   const row=(await db.query("SELECT until_at FROM carrier_tracking_cooldown WHERE carrier=$1 AND environment='production' AND until_at>now()",[carrier])).rows[0];
   if(row)throw Error('API temporairement suspendue jusqu’au '+new Date(row.until_at).toISOString());
  },
  async deferCarrier(carrier,seconds){
   await db.query("INSERT INTO carrier_tracking_cooldown(carrier,environment,until_at) VALUES($1,'production',now()+($2::double precision*interval '1 second')) ON CONFLICT(carrier,environment) DO UPDATE SET until_at=greatest(carrier_tracking_cooldown.until_at,EXCLUDED.until_at)",[carrier,seconds]);
  },
  async assertCurrent(target){
   const current=(await loadTrackingTargets(db,target.orderId)).find(t=>String(t.blId)===String(target.blId)&&t.partialId===target.partialId);
   if(!current||JSON.stringify(current)!==JSON.stringify(target))throw Error('Commande ou colis modifiés pendant la lecture : nouvel examen requis');
  },
  async withLock(target,fn){
   const controls=(await db.query("SELECT value FROM settings WHERE key='background_tasks'")).rows[0]?.value||{};
   if(controls.lifecycle!==false)throw Error('Le traitement lifecycle a été réactivé : synchronisation dédiée suspendue');
   // Share the existing lifecycle lock so the two processes cannot write this BL together.
   await db.query(`INSERT INTO document_lifecycle(bl_id,order_id,partial_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[String(target.blId),target.orderId,target.partialId||null]);
   const claimed=await db.query(`UPDATE document_lifecycle SET locked=true WHERE bl_id=$1 AND order_id=$2 AND partial_id IS NOT DISTINCT FROM $3::text AND locked=false RETURNING bl_id`,[String(target.blId),target.orderId,target.partialId||null]);
   if(!claimed.rows.length)throw Error('BL déjà en traitement ou rattachement différent');
   try{return await fn();}finally{await db.query('UPDATE document_lifecycle SET locked=false WHERE bl_id=$1',[String(target.blId)]);}
  },
  async record(action,detail){
   await db.query('INSERT INTO audit(user_email,action,detail) VALUES($1,$2,$3)',['system:tracking-sync',action,JSON.stringify(detail)]);
  },
  async confirm(target,status){
   if(target.partialId)await db.query(`UPDATE partial_deliveries SET bl=jsonb_set(bl,'{status}',to_jsonb($2::text)) WHERE id=$1`,[target.partialId,status]);
   else await db.query(`UPDATE orders SET erp_live=jsonb_set(erp_live,'{bl,status}',to_jsonb($2::text)),tracking_status=$2 WHERE id=$1`,[target.orderId,status]);
  }
 };
}
