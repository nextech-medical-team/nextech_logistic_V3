import {erplainAccount} from './erplain-accounts.mjs';
import {fileURLToPath} from 'node:url';
import {tenderPhone} from './tender-label-fields.mjs';
const clean=v=>String(v??'').replace(/\s+/g,' ').trim();
export const isImportedErplain=o=>o.source_payload?.erplainImported===true&&o.source_payload?.account==='live';
export function erplainTransportChannel(o){
 if(!isImportedErplain(o))return o.channel;
 const manager=clean(o.erp_live?.bc?.account_representative?.label).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');
 return ['appelsdoffres','appeldoffres'].includes(manager)?'tender':o.channel;
}
export function importedLabelMissingFields(bc,bl){
 const a=bc?.shipping_address||{},isTender=erplainTransportChannel({source_payload:{erplainImported:true,account:'live'},erp_live:{bc}})==='tender';
 const fields=[['Client',bc.customer?.label],...(isTender?[['Adresse de livraison – Nom',a.label]]:[]),['Adresse de livraison – Adresse 1',a.address_1],['Adresse de livraison – Code postal',a.postal_code],['Numéro de téléphone',a.phone],['Référence externe',bc.external_reference],['BL Erplain',bl.label],['Adresse de livraison – Ville',a.city],['Adresse de livraison – Pays',a.country]];
 return fields.filter(([,v])=>!clean(v)).map(([name])=>name);
}
// This read is part of the user's label request, never a publication recipe.
export async function resolveImportedLabelOrder(o,api=erplainAccount(process.env.DATA_DIR||fileURLToPath(new URL('../data/',import.meta.url)),'live')){
 if(!isImportedErplain(o))return o;
 const bcId=o.erp_live?.bc?.id,blId=o.label_bl_id||o.erp_live?.bl?.id;
 if(!bcId||!blId)throw Error('Erplain LIVE · BC et BL requis avant création de l’étiquette');
 await api.verify();
 const r=await api.request('query V3ImportedLabelFields($bc:ID!,$bl:ID!){Order(id:$bc){id customer{id label} account_representative{id label} external_reference shipping_address{label address_1 address_2 postal_code city country phone}} ShippingOrder(id:$bl){id label status orders(first:100){data{id} paginatorInfo{hasMorePages}}}}',{bc:String(bcId),bl:String(blId)});
 const bc=r.Order,bl=r.ShippingOrder,a=bc?.shipping_address||{};
 if(String(bc?.id)!==String(bcId)||String(bl?.id)!==String(blId)||bl.orders?.paginatorInfo?.hasMorePages!==false||!Array.isArray(bl.orders?.data)||!bl.orders.data.some(x=>String(x.id)===String(bcId)))throw Error('Erplain LIVE · Association BC/BL non confirmée');
 if(!['pending','make_the_shipment','in_preparation','ready_to_ship'].includes(bl.status))throw Error('Erplain LIVE · Le BL n’est plus en attente de préparation : aucune étiquette créée');
 const missing=importedLabelMissingFields(bc,bl);
 if(missing.length)throw Error('Erplain LIVE · Informations obligatoires manquantes : '+missing.join(', '));
 if(!bc.customer?.id||/^V3[PT]-/i.test(clean(bl.label)))throw Error('Erplain LIVE · Client ou numéro de BL non confirmé');
 const country=clean(a.country).toUpperCase(),phone=tenderPhone(a.phone,country),postal=clean(a.postal_code).replace(/\s/g,'');
 const validPhone=/^\+?\d{7,15}$/.test(phone)&&!/^0+$/.test(phone)&&(country!=='FR'||/^0[1-9]\d{8}$/.test(phone)||/^(?:\+33|0033)[1-9]\d{8}$/.test(phone));
 if(!validPhone)throw Error('Erplain LIVE · Numéro de téléphone invalide : corriger avant création de l’étiquette');
 if(!/^[A-Z]{2}$/.test(country)||country==='FR'&&!/^\d{5}$/.test(postal))throw Error('Erplain LIVE · Pays ou code postal invalide');
 const result={...o,erp_live:{...o.erp_live,bc:{...o.erp_live.bc,account_representative:bc.account_representative}},erplain_label_customer:bc.customer,external_reference:clean(bc.external_reference),source_reference:clean(bc.external_reference),label_bl:clean(bl.label),label_bl_id:String(bl.id),source_payload:{...o.source_payload,referenceexterne:clean(bc.external_reference)},address:{...o.address,name:clean(a.label)||clean(bc.customer?.label),street:clean(a.address_1),street1:clean(a.address_1),street2:clean(a.address_2),postal,city:clean(a.city),country,phone}};
 if(erplainTransportChannel(result)==='tender'&&(o.carrier!=='gls_pharma'||country!=='FR'))throw Error('Appels d’offres · GLS Pharma obligatoire : actualiser la préparation selon les règles transporteurs');
 return result;
}
