export const documentBlFields='id label external_reference notes status update_stock shipping_address{id label address_1 address_2 postal_code city country phone} line_items{id type parent_id quantity price tax_amount description variant{id sku} location{id}}';
const orderFields='id label external_reference notes dated_at status total currency{id label} update_stock customer{id label} account_representative{id label} shipping_address{id label address_1 address_2 postal_code city country phone} line_items{id type label description quantity price tax_amount shipped_quantity reserved_quantity available on_hand location{id} variant{id sku track_inventory}}';
export async function readErplainDocuments(api,id){
 const bc=(await api.request(`query V3DocumentRead($id:ID!){Order(id:$id){${orderFields} shipping_orders(first:100,page:1){data{${documentBlFields}} paginatorInfo{hasMorePages}}}}`,{id:String(id)})).Order;
 if(!bc||String(bc.id)!==String(id))throw Error('BC Erplain introuvable : aucune donnée locale remplacée');
 const seen=new Set();let connection=bc.shipping_orders,bls=[];
 for(let page=1;page<=100;page++){
  if(!Array.isArray(connection?.data)||typeof connection.paginatorInfo?.hasMorePages!=='boolean')throw Error('Erplain · Historique des BL incomplet');
  for(const bl of connection.data){if(!bl.id||seen.has(String(bl.id)))throw Error('Erplain · Pagination BL incohérente');seen.add(String(bl.id));bls.push(bl)}
  if(!connection.paginatorInfo.hasMorePages){bc.shipping_orders={data:bls,paginatorInfo:{hasMorePages:false}};return bc}
  if(!connection.data.length||page===100)throw Error('Erplain · Historique des BL incomplet');
  const next=(await api.request(`query V3DocumentBlPage($id:ID!,$page:Int!){Order(id:$id){id shipping_orders(first:100,page:$page){data{${documentBlFields}} paginatorInfo{hasMorePages}}}}`,{id:String(id),page:page+1})).Order;
  if(String(next?.id)!==String(id))throw Error('Erplain · BC modifié pendant pagination');connection=next.shipping_orders;
 }
}
export const documentBusySql="SELECT 1 FROM erp_live_jobs WHERE order_id=$1 AND status='processing' UNION ALL SELECT 1 FROM partial_deliveries WHERE order_id=$1 AND status IN ('creating_bl','publishing_bl','creating_stock','finalizing_bl','creating_label','awaiting_pdf') UNION ALL SELECT 1 FROM resolution_jobs WHERE order_id=$1 AND status IN ('queued','running','waiting') UNION ALL SELECT 1 FROM carrier_jobs WHERE order_id=$1 AND status='creating'";
export async function assertDocumentIdle(db,id){if((await db.query(documentBusySql,[id])).rows.length)throw Error('Traitement en cours : attendre sa fin avant actualisation Erplain')}
