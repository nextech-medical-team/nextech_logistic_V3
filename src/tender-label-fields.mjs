import {erplainAccount} from './erplain-accounts.mjs';
import {fileURLToPath} from 'node:url';
const clean=v=>String(v??'').replace(/\s+/g,' ').trim();
export function tenderPhone(value,country='FR'){let phone=clean(value).replace(/[\s().-]/g,'');if(String(country).toUpperCase()==='FR'&&/^\d{9}$/.test(phone))phone='0'+phone;return phone;}
function validPhone(phone,country){if(!/^\+?\d{7,15}$/.test(phone)||/^0+$/.test(phone))return false;if(String(country).toUpperCase()==='FR')return /^0[1-9]\d{8}$/.test(phone)||/^(?:\+33|0033)[1-9]\d{8}$/.test(phone);return true;}
function wrapNames(value,max=35,maxRows=3){const rows=[];let row='';for(const word of value.split(' ')){if(word.length>max)throw Error('Appels d’offres · Nom trop long pour GLS : vérifier le destinataire');if((row?row+' ':'').length+word.length>max){rows.push(row);row=word;}else row+=(row?' ':'')+word;}if(row)rows.push(row);if(rows.length>maxRows)throw Error('Appels d’offres · Noms et complément d’adresse trop longs pour les trois lignes GLS');return rows;}
export function tenderGlsAddress(o){const s=o.source_payload||{},a=o.address||{},client=clean(o.erplain_label_customer?.label),delivery=clean(a.name||s.adressedelivraisonnom),street=clean(a.street1||s.adressedelivraisonadresse1||a.street),postal=clean(a.postal||s.adressedelivraisoncodepostal).replace(/\s/g,''),country=clean(a.country||s.adressedelivraisonpays).toUpperCase(),phone=tenderPhone(a.phone||s.numerodetelephone||s.adressedelivraisontelephone,country),reference=clean(s.referenceexterne||o.source_reference||o.reference);
 for(const [name,value]of [['Nom du client',client],['Adresse de livraison – Nom',delivery],['Adresse de livraison – Adresse 1',street],['Adresse de livraison – Code postal',postal],['Référence externe',reference]])if(!value)throw Error('Appels d’offres · '+name+' obligatoire avant création de l’étiquette GLS');
 const phoneValid=validPhone(phone,country),publishedBl=!!o.label_bl_id||!!o.erp_live?.bl?.id;
 // ShipIT phone fields are optional for the PARCEL/PHARMA services used here.
 // Preserve an extension as printed contact text, never invent a dialable number.
 if(!phoneValid&&!publishedBl)throw Error('Appels d’offres · Numéro de téléphone absent ou invalide : renseigner un numéro joignable avant création de l’étiquette GLS');
 if(street.length>40||reference.length>40)throw Error('Appels d’offres · Adresse 1 ou référence externe dépasse 40 caractères GLS : vérifier avant création');
 const total=Number(o.parcel_total||o.parcel_count||1),suffix=total>1?' ('+Number(o.parcel_index||1)+'/'+total+')':'',destination=[delivery,clean(a.street2||s.adressedelivraisonadresse2)].filter(Boolean).join(' ')+suffix;
 let names;try{names=[...wrapNames(client,35,Infinity),...wrapNames(destination,35,Infinity)];if(names.length>3)names=wrapNames(client+' '+destination);}catch{names=wrapNames(client+' '+destination,40);}
 // Keep established layouts when they fit. Pack the same complete text only
 // when separate wrapping wastes a fourth line; never truncate any name.
 const frenchMobile=/^(?:0[67]|\+33[67]|0033[67])/.test(phone);return {Name1:names[0],Name2:names[1]||'',Name3:names[2]||'',Street:street,ZIPCode:postal,...(phone?{ContactPerson:'Tél : '+phone}:{}),...(phoneValid?(frenchMobile?{MobilePhoneNumber:phone}:{FixedLinePhonenumber:phone}):{})};
}

// Read-only: the customer is the sales-order customer, never the delivery name.
export async function resolveTenderLabelOrder(o,api=erplainAccount(process.env.DATA_DIR||fileURLToPath(new URL('../data/',import.meta.url)),'source')){
 if(o.channel!=='tender')return o;
 const bcId=o.erp_live?.bc?.id,blId=o.label_bl_id||o.erp_live?.bl?.id;
 if(!bcId||!blId)throw Error('Appels d’offres · BC et BL Erplain requis avant création de l’étiquette');
 const result=await api.request('query V3TenderLabelCustomer($bc:ID!,$bl:ID!){Order(id:$bc){id customer{id label} external_reference} ShippingOrder(id:$bl){id label orders(first:100){data{id} paginatorInfo{hasMorePages}}}}',{bc:String(bcId),bl:String(blId)});
 const bc=result.Order,bl=result.ShippingOrder;
 if(String(bc?.id)!==String(bcId)||String(bl?.id)!==String(blId)||!bl.orders?.data?.some(x=>String(x.id)===String(bcId)))throw Error('Appels d’offres · Rapprochement BC/BL Erplain non confirmé');
 if(!clean(bc.customer?.label))throw Error('Appels d’offres · Nom du client Erplain absent');
 if(!clean(bl.label)||/^V3[PT]-/i.test(bl.label))throw Error('Appels d’offres · Numéro du BL Erplain non confirmé');
 return {...o,erplain_label_customer:bc.customer,label_bl:bl.label,external_reference:clean(bc.external_reference)||clean(o.source_payload?.referenceexterne||o.source_reference||o.reference)};
}
