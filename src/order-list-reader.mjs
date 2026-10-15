import {orderQuery} from './order-query.mjs';
import {orderPageDetails} from './order-page-details.mjs';
import {projectCurrentDiagnostics} from './current-order-diagnostics.mjs';
import {managerSql} from './account-manager.mjs';
import {partialAllocationSql} from './partial-allocation.mjs';
import {selectProblemOrders,paginateProblemOrders} from './problem-typology.mjs';
import {currentProblemClassifier} from './problem-typology-reader.mjs';
import {orderStatistics} from './order-statistics.mjs';

// The page and XLSX export use this same current diagnostic population.
export async function readOrdersPage(db,{p='/api/orders',url,connection,cachedOrderSummary,all=false}){

      const catalogOnly=p==='/api/order-problem-types';
      const problemLabels=url.searchParams.getAll('problem-label').filter(Boolean);
      if(problemLabels.length>100||problemLabels.some(label=>label.length>2000))throw Error('Sélection de problèmes invalide');
      const statuses=url.searchParams.getAll('status').flatMap(value=>value.split(',')).filter(Boolean);
      const activeOnly=statuses.length>0&&statuses.every(value=>value==='__problems');
      const scanAll=catalogOnly||problemLabels.length>0||activeOnly||all;
      const scopeParams=new URLSearchParams(url.searchParams);scopeParams.delete('problem-label');
      const diagnosticStart=Date.now();

      const search=(url.searchParams.get('search')||'').slice(0,120),channel=url.searchParams.get('channel')||'',status=url.searchParams.get('status')||'';

      const page=Math.max(1,Math.min(10000,parseInt(url.searchParams.get('page')||'1')||1));

      const pageSize=[50,100,200].includes(Number(url.searchParams.get('pageSize')))?Number(url.searchParams.get('pageSize')):50;
      const {where,args,order}=orderQuery(scopeParams);

      let {rows}=await db.query(`WITH paged AS MATERIALIZED (SELECT id,(SELECT sum(CASE WHEN (l.source_payload->>'mappingScope'='order' OR l.source_payload->>'origin'='erplain_live_equivalent') THEN l.target_quantity WHEN m.source_qty>0 THEN round(l.quantity*m.target_qty/m.source_qty,6) ELSE coalesce(l.target_quantity,l.quantity) END) FROM lines l LEFT JOIN mappings m ON m.channel=orders.channel AND m.source_sku=l.source_sku WHERE l.order_id=orders.id) AS item_quantity FROM orders ${where} ORDER BY ${order} ${scanAll?'':`LIMIT ${pageSize} OFFSET $${args.length+1}`} ) SELECT ${managerSql} AS account_manager,coalesce((SELECT CASE WHEN r.status='review' THEN r.error ELSE null END FROM resolution_jobs r WHERE r.order_id=orders.id ORDER BY r.created_at DESC,id DESC LIMIT 1),(SELECT state->>'result' FROM order_recheck_monitor WHERE order_id=orders.id AND state->>'blocked'='true')) AS resolution_error,(SELECT r.updated_at FROM resolution_jobs r WHERE r.order_id=orders.id ORDER BY r.created_at DESC,r.id DESC LIMIT 1) AS resolution_error_updated_at,resolution_pending_resume,(SELECT json_build_object('id',r.id,'stage',r.stage) FROM resolution_jobs r WHERE r.order_id=orders.id AND r.status IN ('queued','running','waiting') LIMIT 1) AS resolution_active,suspension,archived,CASE WHEN partial_mode THEN ${partialAllocationSql} ELSE '[]'::jsonb END AS partial_allocation,partial_mode,erp_live,id,channel,reference,recipient,address,source_payload,source_date,received_at,label_status,erp_status,tracking_status,invoice_status,weight_kg,parcel_count,carrier,issue,simulation,(SELECT json_agg(source_payload) FROM lines WHERE order_id=orders.id) AS price_sources,(SELECT json_agg(json_build_object('sku',CASE WHEN (l.source_payload->>'mappingScope'='order' OR l.source_payload->>'origin'='erplain_live_equivalent') THEN l.target_sku ELSE coalesce(m.target_sku,l.target_sku,CASE WHEN orders.channel IN ('tender','samples') THEN l.source_sku END) END,'quantity',CASE WHEN (l.source_payload->>'mappingScope'='order' OR l.source_payload->>'origin'='erplain_live_equivalent') THEN l.target_quantity WHEN m.source_qty>0 THEN round(l.quantity*m.target_qty/m.source_qty,6) ELSE coalesce(l.target_quantity,CASE WHEN orders.channel IN ('tender','samples') THEN l.quantity END) END,'source_sku',l.source_sku,'source_quantity',l.quantity,'mapping_exists',m.source_sku IS NOT NULL,'catalog_issue',CASE WHEN l.source_payload->>'erplainCorrectedWeightKg' IS NOT NULL THEN null ELSE c.message END) ORDER BY l.source_line) FROM lines l LEFT JOIN mappings m ON m.channel=orders.channel AND m.source_sku=l.source_sku LEFT JOIN catalog_results c ON c.sku=CASE WHEN (l.source_payload->>'mappingScope'='order' OR l.source_payload->>'origin'='erplain_live_equivalent') THEN l.target_sku ELSE coalesce(m.target_sku,l.target_sku,CASE WHEN orders.channel IN ('tender','samples') THEN l.source_sku END) END WHERE l.order_id=orders.id) AS sku_lines,(SELECT sum(CASE WHEN (l.source_payload->>'mappingScope'='order' OR l.source_payload->>'origin'='erplain_live_equivalent') THEN l.target_quantity WHEN m.source_qty>0 THEN round(l.quantity*m.target_qty/m.source_qty,6) ELSE coalesce(l.target_quantity,l.quantity) END) FROM lines l LEFT JOIN mappings m ON m.channel=orders.channel AND m.source_sku=l.source_sku WHERE l.order_id=orders.id) AS item_quantity,(SELECT count(*) FROM lines WHERE order_id=orders.id) AS line_count,(SELECT json_build_object('status',status,'error',error,'environment',environment,'tracking',tracking,'stock_override',stock_override,'reference',to_jsonb(carrier_jobs)->'reference','hasResult',coalesce(to_jsonb(carrier_jobs)->'result'<>'null'::jsonb,false),'creation_started_at',to_jsonb(carrier_jobs)->'creation_started_at','failure_phase',to_jsonb(carrier_jobs)->'failure_phase','updated_at',updated_at,'documentCount',CASE WHEN status='failed' THEN (SELECT count(*) FROM carrier_documents d WHERE d.order_id=orders.id) ELSE 0 END) FROM carrier_jobs WHERE order_id=orders.id) AS carrier_job,(SELECT json_build_object('status',status,'error',error,'updated_at',updated_at) FROM erp_live_jobs e WHERE e.order_id=orders.id) AS erp_live_job,(SELECT count(*)::int FROM carrier_documents d JOIN carrier_jobs c ON c.order_id=d.order_id WHERE d.order_id=orders.id AND c.status='ready') AS document_count FROM orders WHERE id IN (SELECT id FROM paged) ORDER BY ${order}`,scanAll?args:[...args,(page-1)*pageSize]);

      for(let offset=0;offset<rows.length;offset+=200)await orderPageDetails(db,rows.slice(offset,offset+200),scanAll?'diagnostics':'all');
      for(const row of rows)projectCurrentDiagnostics(row);
      


      for(const row of rows){

        const amounts=(row.price_sources||[]).map(l=>l.itemprice??l.totalht??l.totalttc);delete row.price_sources;

        row.currency=row.source_payload.currency||'';

        row.total_price=amounts.length&&amounts.every(v=>v!==undefined&&v!==''&&Number.isFinite(Number(String(v).replace(',','.'))))?Math.round(amounts.reduce((n,v)=>n+Number(String(v).replace(',','.')),0)*100)/100:null;

        row.gofo_zone_refusal=row.source_payload?.gofoZoneRefusal||null;
        row.source_payload={shopifyDeliveryMode:row.source_payload?.shopifyDeliveryMode,...(row.source_payload?.erplainImported===true&&row.source_payload?.account==='live'?{erplainImported:true,account:'live'}:{})};

      }

      for(const row of rows)if(row.label_status==='waiting_catalog'&&connection.configured&&!connection.running&&!connection.nextRetryAt){row.label_status='weight_pending';row.issue='Poids Erplain non disponible dans V3 ; consulter Connexions pour le dernier résultat. Aucun téléchargement en cours.';}
      if(!connection.configured)for(const row of rows)if(row.label_status==='waiting_catalog'){row.issue='Connexion Erplain à configurer : aucun téléchargement de poids en cours.';row.label_status='connection_missing';}
      for(const row of rows)projectCurrentDiagnostics(row);

      let matched=null;
      if(scanAll){
        const problemParams=new URLSearchParams(scopeParams);problemParams.append('status','__problems');
        const problemScope=orderQuery(problemParams);
        const problemIds=(await db.query('SELECT id FROM orders '+problemScope.where,problemScope.args)).rows.map(row=>row.id);
        matched=selectProblemOrders(rows,catalogOnly?[]:problemLabels,currentProblemClassifier(),problemIds,activeOnly);
        if(catalogOnly)return {problemTypes:matched.problemTypes,at:new Date().toISOString()};
      }
      const {transportStats,summary}=matched?await orderStatistics(db,scopeParams,matched.rows.map(row=>row.id)):await cachedOrderSummary(scopeParams,db);
      const total=summary.total;
      if(all)return {rows:matched?matched.rows:rows,total,summary,transportStats};
      if(matched){
        rows=paginateProblemOrders(matched,page,pageSize).rows;
        await orderPageDetails(db,rows,'display');
      }
      for(const row of rows)projectCurrentDiagnostics(row);
      return {rows,transportStats,summary,total,page,pages:Math.max(1,Math.ceil(total/pageSize))};
      
}
