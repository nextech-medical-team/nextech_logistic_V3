import {catalogProblemSql,pendingEquivalentProblemSql,persistedRecheckProblemSql} from './order-problem-predicates.mjs';
import {awaitingPurchaseSql,currentReasonSql} from './current-order-diagnostics.mjs';
import {partiallyAllocatedSql} from './partial-allocation.mjs';
import {searchTerms} from './group-search.mjs';
import {managerSql} from './account-manager.mjs';
// Sort by the source date displayed in the order table, never by import time.
// Use a calendar-day key: ISO and French imports can coexist without unsafe casts.
export const orderDateSql=`CASE
 WHEN btrim(source_date) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}($|[ T])' THEN replace(left(btrim(source_date),10),'-','')
 WHEN btrim(source_date) ~ '^[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}$' THEN split_part(btrim(source_date),'/',3)||lpad(split_part(btrim(source_date),'/',2),2,'0')||lpad(split_part(btrim(source_date),'/',1),2,'0')
 WHEN btrim(source_date) ~ '^[0-9]{1,2}/[0-9]{1,2}/[0-9]{2}$' THEN '20'||split_part(btrim(source_date),'/',3)||lpad(split_part(btrim(source_date),'/',2),2,'0')||lpad(split_part(btrim(source_date),'/',1),2,'0')
 ELSE to_char(received_at AT TIME ZONE 'Europe/Paris','YYYYMMDD') END`;
export function orderQuery(params,orderIds=null){
 const args=[],parts=["archived=false"];if(params.getAll('problem').some(Boolean))parts.push("coalesce(suspension->>'active','false')<>'true'");const add=(sql,value)=>{args.push(value);parts.push(sql.replaceAll('?', '$'+args.length));};
 if(orderIds!==null)add('orders.id=ANY(?::text[])',orderIds);
 const terms=searchTerms(params.get('search'));
 if(terms.length){
  // One bound pattern array keeps large pasted lists from repeating correlated joins.
  args.push(terms.map(term=>'%'+term.replace(/[%_\\]/g,'\\$&')+'%'));
  const p='$'+args.length+'::text[]';
  const fields=["reference","recipient","erp_live->'bc'->>'label'","erp_live->'bc'->>'id'","erp_live->'bl'->>'label'","erp_live->'bl'->>'id'","source_payload->>'externalreference'","source_payload->>'external_reference'","source_payload->>'externalReference'","erp_live->'bc'->>'external_reference'"];
  const clauses=fields.map(field=>field+' ILIKE ANY('+p+')');
  clauses.push("EXISTS (SELECT 1 FROM partial_deliveries search_delivery WHERE search_delivery.order_id=orders.id AND (search_delivery.bl->>'label' ILIKE ANY("+p+") OR search_delivery.bl->>'id' ILIKE ANY("+p+")))");
  clauses.push("EXISTS (SELECT 1 FROM lines search_line LEFT JOIN mappings search_mapping ON search_mapping.channel=orders.channel AND search_mapping.source_sku=search_line.source_sku WHERE search_line.order_id=orders.id AND (search_line.source_sku ILIKE ANY("+p+") OR coalesce(search_line.target_sku,search_mapping.target_sku) ILIKE ANY("+p+")))");
  const rawSearch=String(params.get('search')||'').trim();
  // A numeric identifier can itself contain spaces. Prefer its whole exact match
  // when present; otherwise retain the existing grouped-reference search.
  if(/^\d+(?:[ \u00a0]+\d+)+$/.test(rawSearch)){
   args.push(rawSearch.replace(/[ \u00a0]+/g,' '));const exactParam='$'+args.length;
   const normalized=field=>"regexp_replace(btrim("+field+"),'[[:space:]]+',' ','g')";
   const exactFor=alias=>'('+normalized(alias+'.reference')+'='+exactParam+' OR EXISTS (SELECT 1 FROM lines exact_line LEFT JOIN mappings exact_mapping ON exact_mapping.channel='+alias+'.channel AND exact_mapping.source_sku=exact_line.source_sku WHERE exact_line.order_id='+alias+'.id AND ('+normalized('exact_line.source_sku')+'='+exactParam+' OR '+normalized('coalesce(exact_line.target_sku,exact_mapping.target_sku)')+'='+exactParam+')))';
   parts.push('(CASE WHEN EXISTS (SELECT 1 FROM orders exact_order WHERE exact_order.archived=false AND '+exactFor('exact_order')+') THEN '+exactFor('orders')+' ELSE ('+clauses.join(' OR ')+') END)');
  }else parts.push('('+clauses.join(' OR ')+')');
 }

 for(const [key,column] of [['channel','channel'],['status',"CASE WHEN coalesce(suspension->>'active','false')='true' THEN '__suspended' ELSE coalesce((SELECT CASE WHEN status='ready' AND environment='production' THEN 'production_ready' WHEN status='ready' THEN 'sandbox_ready' ELSE status END FROM carrier_jobs WHERE order_id=orders.id),label_status) END"],['carrier','carrier'],['country',"address->>'country'"],['tracking','tracking_status']]){
  const values=params.getAll(key).flatMap(v=>v.split(',')).filter(Boolean).slice(0,30);
  if(!values.length)continue;
  if(key==='status'&&values.includes('__problems')){const predicate="(archived IS NOT TRUE AND label_status IS DISTINCT FROM 'cancelled' AND tracking_status IS DISTINCT FROM 'cancelled' AND coalesce(suspension->>'active','false')<>'true' AND ("+persistedRecheckProblemSql+" OR "+catalogProblemSql+" OR "+pendingEquivalentProblemSql+" OR "+partiallyAllocatedSql+" OR (label_status IN ('blocked','waiting_catalog') AND NOT ("+awaitingPurchaseSql+" AND coalesce("+currentReasonSql("issue")+",'')='' AND NOT EXISTS(SELECT 1 FROM lines l LEFT JOIN mappings m ON m.channel=orders.channel AND m.source_sku=l.source_sku JOIN catalog_results c ON c.sku=coalesce(l.target_sku,m.target_sku,l.source_sku) WHERE l.order_id=orders.id AND coalesce(c.message,'')<>'' AND l.source_payload->>'erplainCorrectedWeightKg' IS NULL) AND NOT EXISTS(SELECT 1 FROM resolution_jobs r WHERE r.order_id=orders.id AND r.status='review' AND coalesce(r.error,'')<>''))) OR (carrier IS NULL AND NOT coalesce(partial_mode,false)) OR (erp_status='live_review' AND NOT EXISTS(SELECT 1 FROM erp_live_jobs valid_erp WHERE valid_erp.order_id=orders.id AND valid_erp.status='complete')) OR (SELECT CASE WHEN r.error IS NOT NULL OR NOT coalesce(r.result->'stockIncidentRecheck'->>'status'='resolved',false) THEN r.status ELSE 'diagnostic_resolved' END FROM resolution_jobs r WHERE r.order_id=orders.id ORDER BY r.created_at DESC LIMIT 1)='review' OR EXISTS(SELECT 1 FROM carrier_jobs c WHERE c.order_id=orders.id AND c.status IN ('failed','review')) OR EXISTS(SELECT 1 FROM temu_label_jobs t WHERE orders.channel='temu' AND t.reference=orders.reference AND nullif(btrim(t.error),'') IS NOT NULL) OR EXISTS(SELECT 1 FROM erp_live_jobs e WHERE e.order_id=orders.id AND e.status IN ('failed','review')) OR EXISTS(SELECT 1 FROM partial_deliveries d WHERE d.order_id=orders.id AND d.status IN ('failed','review')) OR EXISTS(SELECT 1 FROM extra_parcels x WHERE x.order_id=orders.id AND x.status IN ('failed','review'))))";const rest=values.filter(v=>v!=='__problems');if(rest.length){args.push(rest);parts.push('('+predicate+' OR '+column+'=ANY($'+args.length+'::text[]))');}else parts.push(predicate);
  }else if(key==='channel'){
   const ordinary=values.filter(v=>!v.startsWith('amazon_')&&!v.startsWith('shopify_')),amazon=values.filter(v=>['amazon_standard','amazon_prime','amazon_priority','shopify_boutique','shopify_relay'].includes(v)),clauses=[];
   if(ordinary.length){args.push(ordinary);clauses.push('channel=ANY($'+args.length+'::text[])');}
   if(amazon.length){args.push(amazon);clauses.push('('+managerSql+')=ANY($'+args.length+'::text[])');}
   if(clauses.length)parts.push('('+clauses.join(' OR ')+')');else parts.push('false');
  }else add(column+'=ANY(?::text[])',values);
 }
 for(const [key,op] of [['from','>='],['to','<=']])if(params.get(key)){const v=params.get(key);if(!/^\d{4}-\d{2}-\d{2}$/.test(v))throw new Error('Date invalide');add('received_at::date'+op+'?::date',v);}
 const problem=params.getAll('problem').filter(Boolean);
 if(problem.length){const text="coalesce((SELECT CASE WHEN r.status='review' THEN r.error ELSE null END FROM resolution_jobs r WHERE r.order_id=orders.id ORDER BY r.created_at DESC LIMIT 1),'')||' '||coalesce("+currentReasonSql("issue")+",'')||' '||coalesce((SELECT error FROM carrier_jobs WHERE order_id=orders.id),'')||' '||coalesce((SELECT error FROM temu_label_jobs WHERE orders.channel='temu' AND reference=orders.reference),'')||' '||coalesce("+currentReasonSql("(SELECT error FROM erp_live_jobs WHERE order_id=orders.id)")+",'')||' '||coalesce((SELECT string_agg(c.message,' ') FROM lines l LEFT JOIN mappings m ON m.channel=orders.channel AND m.source_sku=l.source_sku JOIN catalog_results c ON c.sku=coalesce(l.target_sku,m.target_sku,l.source_sku) WHERE l.order_id=orders.id),'')"+"||' '||coalesce((SELECT state->>'result' FROM order_recheck_monitor WHERE order_id=orders.id AND state->>'blocked'='true'),'')"; const predicates={partial:partiallyAllocatedSql,mapping:"EXISTS(SELECT 1 FROM lines l WHERE l.order_id=orders.id AND orders.channel IN ('amazon','shopify') AND l.target_sku IS NULL AND NOT EXISTS(SELECT 1 FROM mappings m WHERE m.channel=orders.channel AND m.source_sku=l.source_sku))",weight:`(${text}) ~* 'poids|weight'`,stock:`(${text}) ~* 'stock insuffisant|reliquat'`,product:`(${text}) ~* 'introuvable|inactif|plusieurs produits|ambigu'`,address:`(${text}) ~* 'postal|adresse|city information|ville refus|shipping address'`,routing:`(${text}) ~* 'mode shopify|règle transport|gestionnaire transport'`,api:`(${text}) ~* 'HTTP|timeout|fetch failed|délai|réseau|non reç|non vérifiable'`,relay:`(${text}) ~* 'relais|ParcelShop'`,pdf:`(${text}) ~* 'PDF.*(attend|attente|manquant)'`,other:`(${text}) ~* 'motif non enregistré|inconnu|exception|reprise historique'`,uncertain:`(${text}) ~* 'incertain|interrompu|création.*vérifier'`,bc:`(${text}) ~* 'écart BC|BC existant contient|commande V3 et BC'`};if(problem.some(p=>!predicates[p]))throw Error('Type de problème invalide');parts.push('('+problem.map(p=>predicates[p]).join(' OR ')+')');}
 const sorts={sku:"(SELECT min(coalesce(target_sku,source_sku)) FROM lines WHERE order_id=orders.id)",supplier:"source_payload->>'supplier'",reference:'reference',channel:'channel',manager:managerSql,date:orderDateSql,recipient:'recipient',country:"address->>'country'",products:'item_quantity',weight:'weight_kg',carrier:'carrier',label:'label_status',tracking:'tracking_status',bc:"erp_live->'bc'->>'label'",bl:"erp_live->'bl'->>'label'"};
 const sort=sorts[params.get('sort')]||orderDateSql,direction=params.get('direction')==='asc'?'ASC':'DESC';
 return {where:parts.length?'WHERE '+parts.join(' AND '):'',args,order:`${sort} ${direction} NULLS LAST,id`};
}

