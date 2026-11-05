const nameKey=value=>String(value??'').normalize('NFC').trim().replace(/\s+/g,' ').toLocaleLowerCase('fr');

const textKey=value=>nameKey(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,'');
const phoneKey=value=>{
 let digits=String(value??'').replace(/\D/g,'');
 if(digits.startsWith('00'))digits=digits.slice(2);
 if(digits.length===11&&digits.startsWith('33'))digits='0'+digits.slice(2);
 return digits;
};
const same=(a,b,normalize=textKey)=>Boolean(normalize(a)&&normalize(b)&&normalize(a)===normalize(b));

export function bestTenderCustomer(order,customers){
 const source=order.source_payload||{},a=order.address||{};
 const email=String(source.emailclient||a.email||'').trim();
 const phone=source.numerodetelephone||a.phone;
 const ranked=customers.filter(c=>c.active===true).map(customer=>{
  const addresses=customer.addresses;
  if(!Array.isArray(addresses?.data)||addresses.paginatorInfo?.hasMorePages!==false)throw Error('Appels d’offres · Adresses client incomplètes : rapprochement à vérifier');
  const reasons=[];
  if(same(email,customer.email,nameKey))reasons.push(['email',100]);
  let best={points:0,reasons:[]};
  for(const address of [customer.default_shipping_address,customer.default_billing_address,...addresses.data].filter(Boolean)){
   if(a.country&&address.country&&!same(a.country,address.country))continue;
   const hits=[];
   if(same(a.street1||a.street,address.address_1))hits.push(['street',40]);
   if(same(a.postal,address.postal_code))hits.push(['postal',15]);
   if(same(a.city,address.city))hits.push(['city',10]);
   if(same(phone,address.phone,phoneKey))hits.push(['phone',50]);
   const points=hits.reduce((sum,[,weight])=>sum+weight,0);
   if(points>best.points)best={points,reasons:hits};
  }
  reasons.push(...best.reasons);
  return {customer,score:reasons.reduce((sum,[,weight])=>sum+weight,0),evidence:reasons.map(([field])=>field)};
 }).sort((a,b)=>b.score-a.score);
 const winner=ranked[0];
 if(!winner||!winner.score||ranked[1]?.score===winner.score)throw Error('Appels d’offres · Plusieurs fiches client sans meilleure correspondance : vérifier les coordonnées ou renseigner le numéro client');
 return winner;
}

// Called inside the live workflow's shared lock, before any customer mutation.
// Never infer an identity from the delivery recipient or update a reused account.
export async function reuseTenderCustomer(api,order,save){
 if(order.channel!=='tender'||order.erp_live?.bc||order.erp_live?.customer)return false;
 const label=String(order.source_payload?.client??'').trim();
 if(!label)throw Error('Appels d’offres · Nom du client absent : vérifier le fichier avant création');
 const number=String(order.source_payload?.numerodeclient??order.source_payload?.numeroclient??'').trim();
 const matches=new Map(),seen=new Set();
 for(let page=1;;page++){
  const result=await api.request('query V3TenderCustomer($page:Int!,$where:QueryCustomersWhereWhereConditions!){Customers(first:100,page:$page,where:$where){data{id label customer_number active email default_shipping_address{address_1 postal_code city country phone} default_billing_address{address_1 postal_code city country phone} addresses(first:100){data{address_1 postal_code city country phone} paginatorInfo{hasMorePages}}} paginatorInfo{hasMorePages}}}',{page,where:{column:number?'CUSTOMER_NUMBER':'LABEL',operator:'EQ',value:number||label}});
  const list=result?.Customers;
  if(!Array.isArray(list?.data)||typeof list.paginatorInfo?.hasMorePages!=='boolean')throw Error('Appels d’offres · Recherche client Erplain incomplète : aucune création');
  for(const customer of list.data){
   if(!customer?.id||typeof customer.label!=='string'||seen.has(String(customer.id)))throw Error('Appels d’offres · Recherche client Erplain incohérente : aucune création');
   seen.add(String(customer.id));
   if(nameKey(customer.label)===nameKey(label)&&(!number||String(customer.customer_number??'').trim()===number))matches.set(String(customer.id),customer);
   else throw Error('Appels d’offres · Résultat client inattendu : aucune création');
  }
  if(!list.paginatorInfo.hasMorePages)break;
  if(!list.data.length||page>=1000)throw Error('Appels d’offres · Recherche client Erplain incomplète : aucune création');
 }

 if(!matches.size){if(number)throw Error('Appels d’offres · Numéro client Erplain introuvable : aucune création');return false;}
 const choice=matches.size>1&&!number?bestTenderCustomer(order,[...matches.values()]):null;
 if(number&&matches.size>1)throw Error('Appels d’offres · Numéro client dupliqué : vérifier les fiches');
 const customer=choice?.customer||[...matches.values()][0];
 if(customer.active!==true)throw Error('Appels d’offres · Client Erplain inactif ou non vérifié : aucune création');
 order.erp_live??={};
 order.erp_live.customer={id:customer.id,label:customer.label,customer_number:customer.customer_number};
 order.erp_live.phase='customer_created';
 order.erp_live.customerReuse={matchedBy:number?'customer_number':choice?'coordinates':'label',...(choice?{score:choice.score,evidence:choice.evidence}:{}),checkedAt:new Date().toISOString()};
 await save(order);
 return true;
}
