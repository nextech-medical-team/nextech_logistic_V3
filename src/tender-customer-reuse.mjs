import {erplainCustomerLabel} from './customer-identity.mjs';

const nameKey=value=>String(value??'').normalize('NFC').trim().replace(/\s+/g,' ').toLocaleLowerCase('fr');

// Called inside the live workflow's shared lock, before any customer mutation.
// Never infer an identity from the delivery recipient or update a reused account.
export async function reuseTenderCustomer(api,order,save){
 if(order.channel!=='tender'||order.erp_live?.bc||order.erp_live?.customer)return false;
 const label=String(order.source_payload?.client??'').trim();
 if(!label)throw Error('Appels d’offres · Nom du client absent : vérifier le fichier avant création');
 const matches=new Map(),seen=new Set();
 for(let page=1;;page++){
  const result=await api.request('query V3TenderCustomer($page:Int!,$where:QueryCustomersWhereWhereConditions!){Customers(first:100,page:$page,where:$where){data{id label customer_number active} paginatorInfo{hasMorePages}}}',{page,where:{column:'LABEL',operator:'EQ',value:erplainCustomerLabel(order)}});
  const list=result?.Customers;
  if(!Array.isArray(list?.data)||typeof list.paginatorInfo?.hasMorePages!=='boolean')throw Error('Appels d’offres · Recherche client Erplain incomplète : aucune création');
  for(const customer of list.data){
   if(!customer?.id||typeof customer.label!=='string'||seen.has(String(customer.id)))throw Error('Appels d’offres · Recherche client Erplain incohérente : aucune création');
   seen.add(String(customer.id));
   if(nameKey(customer.label)===nameKey(label))matches.set(String(customer.id),customer);
   else throw Error('Appels d’offres · Résultat client inattendu : aucune création');
  }
  if(!list.paginatorInfo.hasMorePages)break;
  if(!list.data.length||page>=1000)throw Error('Appels d’offres · Recherche client Erplain incomplète : aucune création');
 }
 if(matches.size>1)throw Error('Appels d’offres · Plusieurs clients Erplain portent ce nom : sélectionner la bonne fiche avant de continuer');
 if(!matches.size)return false;
 const customer=[...matches.values()][0];
 if(customer.active!==true)throw Error('Appels d’offres · Client Erplain inactif ou non vérifié : aucune création');
 order.erp_live??={};
 order.erp_live.customer={id:customer.id,label:customer.label,customer_number:customer.customer_number};
 order.erp_live.phase='customer_created';
 order.erp_live.customerReuse={matchedBy:'label',checkedAt:new Date().toISOString()};
 await save(order);
 return true;
}
