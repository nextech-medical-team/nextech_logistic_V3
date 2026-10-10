export function operationProgress(s){
 const total=Number(s.total)||0,done=Number(s.done)||0;
 return {...s,total,done,percent:total>0?Math.min(100,Math.floor(done*100/total)):null};
}
export async function erplainProgress(db,catalog,stocks){
 const counts=(await db.query("SELECT status,count(*)::int AS count FROM erp_live_jobs GROUP BY status")).rows;
 const tally=Object.fromEntries(counts.map(r=>[r.status,r.count]));
 const total=counts.reduce((n,r)=>n+r.count,0),complete=tally.complete||0,review=tally.review||0;
 const details=(await db.query("SELECT o.reference,o.erp_live->>'phase' AS phase,j.status,j.error,j.updated_at FROM erp_live_jobs j JOIN orders o ON o.id=j.order_id WHERE j.status IN ('processing','review') ORDER BY CASE WHEN j.status='processing' THEN 0 ELSE 1 END,j.updated_at DESC LIMIT 10")).rows;
 const documents=(await db.query("SELECT count(*) FILTER (WHERE erp_live->'bc'->>'id' IS NOT NULL)::int AS bc,count(*) FILTER (WHERE erp_live->'bl'->>'id' IS NOT NULL)::int AS bl FROM orders")).rows[0];
 return {at:new Date().toISOString(),weights:operationProgress(await catalog.status()),stocks:operationProgress(await stocks.status()),orders:{total,complete,review,pending:tally.pending||0,processing:tally.processing||0,partial:tally.partial||0,percent:total?Math.floor(complete*100/total):null,processedPercent:total?Math.floor((complete+review)*100/total):null,...documents,details}};
}
