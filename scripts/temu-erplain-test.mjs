// Loaded only by the loopback sandbox, never by the production server.
import {readFile,writeFile,mkdir,rename,open,unlink} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {excelAmounts,excelPricing,temuInternalNotes,customerDetails,findCustomer,matchesCustomer,customerFields} from './temu-excel-commercial.mjs';
import {verifyBcPricing} from '../src/bc-pricing.mjs';
import {erplainFetch} from '../src/erplain-transport.mjs';
import {assertFullOrderStock} from '../src/stock-gate.mjs';

export const TEST_COMPANY=101406;
export function testApi(key,{fetchImpl=fetch,transportOptions={}}={}){
 if(!key)throw Error('Clé Erplain TEST absente de .env.erplain-test');
 async function request(query,variables={}){
  const readOnly=!/^\s*mutation\b/.test(query);
  const r=await erplainFetch({apiKey:key},'https://api.erplain.app/graphql',()=>({method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:{'content-type':'application/json',authorization:'Bearer '+key,'x-company-id':String(TEST_COMPANY)},body:JSON.stringify({query,variables})}),{fetchImpl,readOnly,...transportOptions});
  if(!r.ok)throw Object.assign(Error(r.status===429?'Erplain limite les requêtes. Attendez une minute puis relancez ; cette requête a été refusée.':'Erplain TEST : HTTP '+r.status+' ; réessayer plus tard.'),{notApplied:r.status===429});
  const result=await r.json();if(result.errors?.length)throw Object.assign(Error(result.errors.map(e=>e.message).join(' ; ')),{notApplied:result.data==null&&result.errors.every(e=>/^Variable \"/.test(e.message)&&/got invalid value|was not provided/.test(e.message))});
  if(!result.data)throw Error('Réponse Erplain incomplète');return result.data;
 }
 async function verify(){const {Company:c}=await request('query LocalTestIdentity { Company { id label currency { id label } default_location { id label } } }');if(Number(c?.id)!==TEST_COMPANY)throw Error('Connexion refusée : société TEST 101406 requise. Aucun document créé.');return c;}
 return {verify,read:request,async mutate(query,variables){try{await verify();}catch(e){e.notApplied=true;throw e;}return request(query,variables);}};
}
export async function loadTestApi(filename){const env=await readFile(filename,'utf8');return testApi(env.match(/^ERPLAIN_TEST_API_KEY=(.*)$/m)?.[1]?.trim());}
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const totals=lines=>{const sums=new Map();for(const l of lines||[]){if(l.type==='shipping_cost'&&!l.variant)continue;const k=l.variant?.id+':'+l.location?.id;sums.set(k,(sums.get(k)||0)+Number(l.quantity));}return JSON.stringify([...sums].sort());};
export function testDocuments({db,api,directory}){
 let busy=false;
 const file=ref=>path.join(directory,digest(ref)+'.json');
 async function state(ref){try{return JSON.parse(await readFile(file(ref),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;return {};}}
 async function save(ref,s){await mkdir(directory,{recursive:true,mode:0o700});const temp=file(ref)+'.'+randomUUID();await writeFile(temp,JSON.stringify(s),{mode:0o600});await rename(temp,file(ref));await db.query("UPDATE orders SET erp_test=$2 WHERE channel='temu' AND reference=$1",[ref,JSON.stringify(s)]);}
 async function orders(){const rows=(await db.query("SELECT * FROM orders WHERE channel='temu' ORDER BY reference")).rows;return Promise.all(rows.map(async o=>({id:o.id,reference:o.reference,recipient:o.recipient,country:o.address.country,lines:(await db.query('SELECT source_line,source_sku,quantity FROM lines WHERE order_id=$1',[o.id])).rows,documents:await state(o.reference),commercial:await previewAmounts(o.id,o.address.country)})));}
 async function previewAmounts(id,country){try{return excelAmounts((await db.query('SELECT * FROM lines WHERE order_id=$1',[id])).rows,{country});}catch(e){return {error:e.message};}}
 async function create(input){
  if(busy)throw Error('Un test est déjà en cours');
  if(!Array.isArray(input?.orders)||input.orders.length<1||input.orders.length>5||new Set(input.orders.map(o=>o.id)).size!==input.orders.length)throw Error('Sélectionnez de 1 à 5 commandes distinctes');
  busy=true;let lock;
  try{
   await mkdir(directory,{recursive:true,mode:0o700});
   try{lock=await open(path.join(directory,'running.lock'),'wx',0o600);}catch{throw Error('Test en cours ou interrompu : vérifier le journal local avant reprise.');}
   const company=await api.verify();
   if(!company.currency?.id||!company.default_location?.id)throw Error('Devise ou lieu de stockage TEST absent');
   const result=[];
   for(const selection of input.orders){
    const o=(await db.query("SELECT * FROM orders WHERE id=$1 AND channel='temu'",[selection.id])).rows[0];
    if(!o||o.source_payload?.origin!=='temu_excel')throw Error('Commande Excel TEMU importée requise');
    let s=await state(o.reference);
    try{
     if(s.pending)throw Error('Résultat précédent incertain ('+s.pending+') : contrôle manuel requis, création bloquée.');
     const lines=(await db.query('SELECT * FROM lines WHERE order_id=$1 ORDER BY source_line',[o.id])).rows;
     if(!lines.length||lines.length>100)throw Error('Commande vide ou plus de 100 lignes');
     const choices=lines.map(l=>{const override=selection.lines?.find(x=>x.source_line===l.source_line);const sku=String(override?.sku??l.source_sku).trim(),quantity=Number(override?.quantity??l.quantity);if(!sku||sku.length>300||!Number.isFinite(quantity)||quantity<=0||quantity>1000000)throw Error('SKU ou quantité invalide');return {source_line:l.source_line,sku,quantity};});
     const fingerprint=digest({reference:o.reference,address:o.address,choices});
     if(s.fingerprint&&s.fingerprint!==fingerprint&&(s.customer||s.bc||s.bl||s.pending||s.complete))throw Error('Commande ou correspondance modifiée après création : contrôle manuel requis');
     if(s.complete&&s.version===2){result.push({reference:o.reference,...s,replayed:true});continue;}
     s={...s,fingerprint,companyId:TEST_COMPANY,reference:o.reference,complete:false};
     const items=[];
     for(const l of choices){
      const {Variants:v}=await api.read('query LocalTestSku($where:QueryVariantsWhereWhereConditions){Variants(first:100,where:$where){data{id sku active product{active}} paginatorInfo{hasMorePages}}}',{where:{column:'SKU',operator:'EQ',value:l.sku}});
      const hits=v?.data?.filter(v=>v.sku===l.sku&&v.active!==false&&v.product?.active!==false)||[];
      if(v?.paginatorInfo?.hasMorePages||hits.length!==1)throw Error('SKU TEST absent ou ambigu : '+l.sku+'. Renseignez le SKU Erplain et la quantité correspondante.');
      items.push({variant:{id:String(hits[0].id)},location:{id:String(company.default_location.id)},quantity:l.quantity,price:0,tax_codes:[],description:l.sku});
     }
     const amounts=excelAmounts(lines,{country:o.address.country});
     const {TaxCodes:taxes}=await api.read('query LocalTestTaxes {TaxCodes(first:100){data{id label active tax_rates{rate}} paginatorInfo{hasMorePages}}}');
     if(!taxes||taxes.paginatorInfo?.hasMorePages)throw Error('Catalogue TVA incomplet');
     const pricing=excelPricing(o,lines,items,taxes.data);
     let currency=company.currency;
     if(currency.label!==amounts.currency){const {Currencies:c}=await api.read('query LocalTestCurrencies {Currencies(first:100){data{id label} paginatorInfo{hasMorePages}}}');const hits=c?.data?.filter(v=>v.label===amounts.currency)||[];if(c?.paginatorInfo?.hasMorePages||hits.length!==1)throw Error('Devise TEST absente ou ambiguë : '+amounts.currency);currency=hits[0];}
     s.pricing=pricing;
     async function mutation(field,query,variables){
      s.pending=field;await save(o.reference,s);
      let response;try{response=await api.mutate(query,variables);}catch(e){if(e.notApplied){delete s.pending;await save(o.reference,s);}throw e;}const doc=Object.values(response)[0];if(!doc?.id)throw Error('Réponse de création incomplète');
      s[field]=doc;delete s.pending;delete s.error;await save(o.reference,s);
     }
     const details=customerDetails(o,lines),found=await findCustomer(api,details);
     if(found){s.customer={id:found.id,label:found.label,reused:true};await save(o.reference,s);}
     else if(s.customer){
      const {Customer:c}=await api.read(`query LocalTestExistingCustomer($id:ID!){Customer(id:$id){${customerFields}}}`,{id:String(s.customer.id)});
      if(c?.customer_number==='TEMU-LOCAL-'+digest(o.reference).slice(0,24))await mutation('customer','mutation LocalTestCompleteCustomer($id:ID!,$input:CustomerInput!){UpdateCustomer(id:$id,input:$input){id label}}',{id:String(c.id),input:details.input});
      else if(!c||!matchesCustomer(c,details))throw Error('Client enregistré différent : rapprochement requis');
     }else await mutation('customer','mutation LocalTestCustomer($input:CustomerInput!){CreateCustomer(input:$input){id label}}',{input:details.input});
     const {type,default:isDefault,...address}=details.input.addresses.data[0];
     const orderInput={status:'active',update_stock:false,customer:{id:String(s.customer.id)},currency:{id:String(currency.id),label:currency.label},price_level:{id:'109498'},dated_at:String(o.source_date||new Date().toISOString()).slice(0,10),external_reference:'TEST-LOCAL:'+o.reference,shipping_address:address,billing_address:address,tax_type:pricing.tax_type,line_items:pricing.items,notes:'TEST LOCAL TEMU '+o.reference,internal_notes:temuInternalNotes(o,lines)};
     if(!s.bc)await mutation('bc','mutation LocalTestOrder($input:OrderInput!){CreateOrder(input:$input){id label status}}',{input:orderInput});
     else if(s.version!==2){
      const {Order:prior}=await api.read('query LocalTestBeforePricing($id:ID!){Order(id:$id){id total status external_reference line_items{id type quantity price variant{id} location{id}}}}',{id:String(s.bc.id)});
      if(!prior||prior.status!=='active'||prior.external_reference!==orderInput.external_reference||Number(prior.total)!==0||totals(prior.line_items)!==totals(items))throw Error('BC existant modifié : rapprochement avant mise à jour des montants');
      const unused=[...prior.line_items];orderInput.line_items=pricing.items.map(item=>{const i=unused.findIndex(l=>(l.type||'normal')===(item.type||'normal')&&String(l.variant?.id||'')===String(item.variant?.id||'')&&Number(l.quantity)===Number(item.quantity));return i<0?item:{...item,id:String(unused.splice(i,1)[0].id)};});
      if(unused.length)throw Error('Lignes BC supplémentaires : rapprochement requis');
      await mutation('bc','mutation LocalTestUpdatePrices($id:ID!,$input:OrderInput!){UpdateOrder(id:$id,input:$input){id label status}}',{id:String(s.bc.id),input:orderInput});
     }
     s.version=2;await save(o.reference,s);
     const {Order:bc}=await api.read('query LocalTestStock($id:ID!){Order(id:$id){id status update_stock total tax_type currency{label} line_items{id type quantity price tax_amount tax_codes{id} discount discount_rule_amount ecotax reserved_quantity available on_hand location{id} variant{id sku track_inventory}} shipping_orders(first:10){data{id label status update_stock line_items{quantity location{id} variant{id}}} paginatorInfo{hasMorePages}}}}',{id:String(s.bc.id)});
     if(!bc||bc.status!=='active'||bc.update_stock!==false||totals(bc.line_items)!==totals(items))throw Error('BC TEST modifié : références, quantités ou statut différents');
     s.confirmed=verifyBcPricing(bc,pricing);await save(o.reference,s);
     assertFullOrderStock(bc.line_items);
     const existing=bc.shipping_orders?.data||[];
     if(bc.shipping_orders?.paginatorInfo?.hasMorePages||existing.length>1)throw Error('Plusieurs BL : contrôle manuel requis');
     if(!s.bl&&existing.length){s.bl=existing[0];await save(o.reference,s);}
     if(!s.bl)await mutation('bl','mutation LocalTestShipping($input:ShippingOrderFromInput!){CreateShippingOrderFrom(input:$input){id label status update_stock}}',{input:{Order:[String(s.bc.id)]}});
     const {ShippingOrder:before}=await api.read('query LocalTestBeforePublish($id:ID!){ShippingOrder(id:$id){id status update_stock orders(first:10){data{id}} line_items{id type quantity variant{id} location{id}}}}',{id:String(s.bl.id)});
     if(!before||before.update_stock!==false||!before.orders?.data?.some(v=>String(v.id)===String(s.bc.id))||totals(before.line_items)!==totals(items))throw Error('BL non rattaché au BC attendu ou quantités différentes');
     const remainingBl=[...before.line_items];const blItems=pricing.items.map(({apply_discount_rules,...item})=>{const i=remainingBl.findIndex(l=>(l.type||'normal')===(item.type||'normal')&&String(l.variant?.id||'')===String(item.variant?.id||'')&&Number(l.quantity)===Number(item.quantity));return i<0?item:{...item,id:String(remainingBl.splice(i,1)[0].id)};});if(remainingBl.length)throw Error('BL : lignes supplémentaires à rapprocher');
     if(before.status==='unpublished')await mutation('bl','mutation LocalTestPublishBL($id:ID!,$input:ShippingOrderInput!){UpdateShippingOrder(id:$id,input:$input){id label status}}',{id:String(s.bl.id),input:{label:'SHO-TEST-'+s.bc.id,status:'pending',external_reference:orderInput.external_reference,internal_notes:orderInput.internal_notes,shipping_address:address,line_items:blItems}});
     else if(before.status!=='pending')throw Error('BL déjà traité : contrôle manuel requis');
     const {ShippingOrder:bl}=await api.read('query LocalTestVerifyBL($id:ID!){ShippingOrder(id:$id){id label status update_stock orders(first:10){data{id}} line_items{type quantity variant{id} location{id}}}}',{id:String(s.bl.id)});
     if(!bl||bl.status!=='pending'||bl.update_stock!==false||!bl.orders?.data?.some(v=>String(v.id)===String(s.bc.id))||totals(bl.line_items)!==totals(items))throw Error('BL TEST : quantités ou politique de stock différentes');
     const {Order:linked}=await api.read('query LocalTestLinkedBL($id:ID!){Order(id:$id){shipping_orders(first:100){data{id}}}}',{id:String(s.bc.id)});
     if(!linked?.shipping_orders?.data?.some(v=>String(v.id)===String(bl.id)))throw Error('Lien du BL non confirmé dans le BC');
     s.bl={id:bl.id,label:bl.label,status:bl.status};s.complete=true;delete s.error;await save(o.reference,s);
     result.push({reference:o.reference,...s});
    }catch(e){s.error=e.message;await save(o.reference,s);result.push({reference:o.reference,...s});}
   }
   return {company,results:result};
  }finally{if(lock){await lock.close();await unlink(path.join(directory,'running.lock'));}busy=false;}
 }
 return {orders,create,state};
}
