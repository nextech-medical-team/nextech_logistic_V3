export async function claimStockCreation(db,o){
 if(process.env.ERPLAIN_LIVE_WRITES!=='1'||process.env.MIGRATION_PREPARATION==='1')throw Error('Stock Erplain : écriture suspendue, aucune tentative lancée');
 const at=new Date().toISOString();
 const s=o.erp_live,prior=s.stockCreationAttemptedAt||null;
 const outcome={kind:'in_flight',attemptedAt:at,bcId:String(s.bc.id),blId:String(s.bl.id)};
 const payload={stockCreationAttemptedAt:at,stockCreationOutcome:outcome,stockCreationHistory:[...(s.stockCreationHistory||[]),...(s.stockCreationOutcome?[s.stockCreationOutcome]:[])]};
 const r=await db.query(`UPDATE orders SET erp_live=erp_live||$5::jsonb||jsonb_build_object('stockCreationAttemptedAt',$2::text) WHERE id=$1 AND erp_live->>'phase'='creating_stock' AND NOT archived AND NOT partial_mode AND NOT resolution_pending_resume AND coalesce(suspension->>'active','false')<>'true' AND NOT (suspension ? 'erplainCancellation') AND coalesce(tracking_status,'') NOT IN ('cancelled','shipped','delivered','in_transit') AND coalesce(label_status,'')<>'cancelled' AND NOT (coalesce(source_payload,'{}') ? 'marketplacePendingCorrection') AND NOT coalesce(issue,'') ~* 'commande annulée' AND (erp_live->'stockDocument' IS NULL OR erp_live->'stockDocument'='null'::jsonb) AND erp_live->'bc'->>'id'=$3 AND erp_live->'bl'->>'id'=$4 AND (erp_live->>'stockCreationAttemptedAt' IS NULL OR (erp_live->>'stockCreationAttemptedAt'=$6 AND (erp_live->'stockCreationOutcome'->>'kind'='rejected_rate_limit' OR (erp_live->'stockCreationOutcome'->>'kind'='absence_confirmed' AND erp_live->'stockCreationOutcome'->'proof'->>'complete'='true')) AND erp_live->'stockCreationOutcome'->>'attemptedAt'=$6 AND erp_live->'stockCreationOutcome'->>'bcId'=$3 AND erp_live->'stockCreationOutcome'->>'blId'=$4)) RETURNING id`,[o.id,at,String(s.bc.id),String(s.bl.id),JSON.stringify(payload),prior]);
 if(r.rows.length!==1)throw Error('Stock Erplain : tentative déjà lancée ou documents modifiés, relecture nécessaire');
 Object.assign(s,payload);
}

export function canCreateStock(o){
 const s=o.erp_live||{},p=s.stockCreationOutcome;
 return !s.stockCreationAttemptedAt||(['rejected_rate_limit','absence_confirmed'].includes(p?.kind)&&p.attemptedAt===s.stockCreationAttemptedAt&&p.bcId===String(s.bc?.id)&&p.blId===String(s.bl?.id)&&(p.kind!=='absence_confirmed'||p.proof?.complete===true));
}
export async function recordStockCreationOutcome(db,o,{error,documentId,absenceProof}={}){
 const s=o.erp_live;
 if(absenceProof&&(absenceProof.complete!==true||absenceProof.attemptedAt!==s.stockCreationAttemptedAt||absenceProof.bcId!==String(s.bc.id)||absenceProof.blId!==String(s.bl.id)))throw Error('Stock Erplain : preuve d’absence non liée à la tentative');
 const p={attemptedAt:s.stockCreationAttemptedAt,bcId:String(s.bc.id),blId:String(s.bl.id),...s.stockCreationOutcome,kind:absenceProof?'absence_confirmed':documentId?'confirmed_response':error?.confirmedRateLimitRejection===true&&error.httpStatus===429?'rejected_rate_limit':'uncertain',checkedAt:new Date().toISOString(),...(absenceProof?{proof:absenceProof}:{}),...(documentId?{documentId:String(documentId)}:{}),...(error?{error:String(error.message).slice(0,1000)}:{})};
 if(!p.attemptedAt||p.attemptedAt!==s.stockCreationAttemptedAt)throw Error('Stock Erplain : journal de tentative absent');
 const r=await db.query(`UPDATE orders SET erp_live=jsonb_set(erp_live,'{stockCreationOutcome}',$2::jsonb) WHERE id=$1 AND erp_live->>'stockCreationAttemptedAt'=$3 AND erp_live->'bc'->>'id'=$4 AND erp_live->'bl'->>'id'=$5 RETURNING id`,[o.id,JSON.stringify(p),p.attemptedAt,p.bcId,p.blId]);
 if(r.rows.length!==1)throw Error('Stock Erplain : documents modifiés pendant la tentative');s.stockCreationOutcome=p;
}

export function canRetryStock(o){
 const s=o.erp_live||{};
 return !commercialBcError(o.error)&&o.archived===false&&!o.partial_mode&&!o.resolution_pending_resume&&s.phase==='creating_stock'&&!s.stockDocument?.id&&s.bc?.id&&s.bl?.id&&!['cancelled','closed'].includes(s.bc.status)&&!['cancelled','closed'].includes(s.bl.status)&&!['cancelled','shipped','delivered','in_transit'].includes(o.tracking_status)&&o.label_status!=='cancelled'&&(!!s.stockCreationAttemptedAt||String(o.error||'').startsWith('Stock Erplain'));
}

export function commercialBcError(message){
 const text=String(message||'').replace(/^Stock Erplain · Mouvement à vérifier :\s*/,'');
 return /^BC(?:\s|[·:])/.test(text)?text:null;
}
export function stockFailureMessage(o,message){
 const commercial=commercialBcError(message);if(commercial)return commercial;
 return o.erp_live?.phase==='creating_stock'&&!String(message).startsWith('Stock Erplain')?'Stock Erplain · Mouvement à vérifier : '+message:message;
}
