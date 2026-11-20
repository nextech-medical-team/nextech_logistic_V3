import {createHash,timingSafeEqual} from 'node:crypto';

const route='/api/relais/delivery';
const pattern=/^[A-Z0-9#][A-Z0-9 ._/#-]{0,99}$/;
const hash=value=>createHash('sha256').update(value).digest();

function identifiers(params){
 const names=['bl','reference','tracking'];
 if(names.some(name=>params.getAll(name).length>1))return null;
 const [bl,reference,tracking]=names.map(name=>(params.get(name)||'').trim().toUpperCase());
 if(!bl&&!reference&&!tracking)return null;
 if([bl,reference,tracking].some(value=>value&&!pattern.test(value)))return null;
 if(bl&&!/^SHO\d{5,12}$/.test(bl)||tracking&&!/^[A-Z0-9]{8,36}$/.test(tracking))return null;
 return {bl,reference,tracking};
}

export async function lookupRelaisDelivery(db,api,{bl,reference,tracking}){
 const {rows}=await db.query(`
 WITH deliveries AS (
  SELECT o.id AS order_id, o.reference, o.erp_live->'bl' AS bl, NULL::text AS partial_id,
   COALESCE(c.tracking,'[]'::jsonb)||COALESCE(t.packages,'[]'::jsonb) AS tracking
  FROM orders o
  LEFT JOIN carrier_jobs c ON c.order_id=o.id AND c.environment='production' AND c.status='ready'
  LEFT JOIN temu_label_jobs t ON o.channel='temu' AND t.reference=o.reference AND t.status='complete'
  WHERE NOT o.archived AND NOT o.partial_mode AND NOT o.simulation
  UNION ALL
  SELECT o.id,o.reference,p.bl,p.id,COALESCE(p.tracking,'[]'::jsonb)
  FROM partial_deliveries p JOIN orders o ON o.id=p.order_id
  WHERE NOT o.archived AND NOT o.simulation AND p.environment='production' AND p.status='ready'
 )
 SELECT DISTINCT d.bl->>'id' AS id,d.bl->>'label' AS label
 FROM deliveries d WHERE d.bl->>'id' ~ '^[0-9]+$'
 AND ($1='' OR upper(d.bl->>'label')=$1)
 AND ($2='' OR upper(d.reference)=$2 OR upper(d.bl->>'external_reference')=$2)
 AND ($3='' OR d.tracking ? $3 OR EXISTS(
   SELECT 1 FROM extra_parcels x WHERE x.order_id=d.order_id AND x.delivery_id IS NOT DISTINCT FROM d.partial_id
   AND x.environment='production' AND x.status='ready' AND x.tracking=$3))
 LIMIT 2`,[bl,reference,tracking]);
 if(!rows.length)return {status:404,error:'Aucun BL correspondant dans la V3.'};
 if(rows.length!==1)return {status:409,error:'Plusieurs BL correspondent dans la V3. Ajoutez le numéro exact du BL.'};
 const match=rows[0];
 await api.verify();
 const response=await api.request(`query RelaisReadDelivery($id:ID!){
  ShippingOrder(id:$id){id label status external_reference customer{id label}
   line_items{id sku label quantity variant{id sku barcode barcode2 has_batch_numbers} batch_numbers{quantity batch_number{label expiry_date}}}}
 }`,{id:match.id});
 const doc=response.ShippingOrder;
 if(!doc||String(doc.id)!==match.id||match.label&&doc.label!==match.label||!Array.isArray(doc.line_items)){
  return {status:409,error:'Le BL enregistré dans la V3 doit être rapproché avec Erplain.'};
 }
 return {status:200,delivery:doc};
}

export async function handleRelaisDeliveryLookup({req,res,url,db,api,json,token}){
 if(url.pathname!==route)return false;
 if(req.method!=='GET'){res.setHeader('Allow','GET');json(res,405,{error:'Méthode interdite.'});return true;}
 const authorization=req.headers.authorization;
 if(typeof token!=='string'||token.length<32||typeof authorization!=='string'||!timingSafeEqual(hash(authorization),hash('Bearer '+token))){
  json(res,401,{error:'Accès Relais refusé.'});return true;
 }
 const keys=identifiers(url.searchParams);
 if(!keys){json(res,400,{error:'Identifiants de livraison invalides.'});return true;}
 try{
  const {status,...result}=await lookupRelaisDelivery(db,api,keys);
  json(res,status,result);
 }catch{
  json(res,503,{error:'Recherche V3 temporairement indisponible.'});
 }
 return true;
}
