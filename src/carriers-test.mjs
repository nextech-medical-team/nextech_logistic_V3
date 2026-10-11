import {readShopifyRelay,assertFreshShopifyRelay,chooseNearestParcelShop} from './shopify-relay-source.mjs';
import {shopifyCollector,loadShopifyConfig} from './marketplace-collection.mjs';
import {assertDirectCarrierAllowed} from './temu-label-policy.mjs';
import {isImportedErplain,resolveImportedLabelOrder} from './erplain-label-required.mjs';
import {tenderGlsAddress,resolveTenderLabelOrder} from './tender-label-fields.mjs';
import {labelReference,labelReferences,labelNotes,parcelRecipient,gofoInstructions} from './label-text.mjs';
import {createHmac} from 'node:crypto';
import {existingParcelShop,parcelShopSearch,normalizeParcelShops} from './gls-parcelshop.mjs';

// Test endpoints are deliberately constants. No production URL can be supplied.
const GLS='https://api-sandbox.gls-group.net';
const GOFO='https://uat-api-eu.gofoexpress.com';
export function parseDevelopmentEnv(text){
  return Object.fromEntries(text.split(/\r?\n/).filter(l=>/^\s*[A-Z][A-Z0-9_]*=/.test(l)).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(),l.slice(i+1).trim().replace(/^(['"])(.*)\1$/,'$2')];}));
}
export function pdfBytes(value){const b=Buffer.from(String(value||'').replace(/^data:application\/pdf;base64,/,''),'base64');if(b.subarray(0,5).toString()!=='%PDF-')throw new Error('Le transporteur ne fournit pas un PDF valide');return b;}
export function createTestCarriers(c,{fetchImpl=fetch}={}){
  if(c.GLS_AUTH_BASE_URL!==GLS||c.GLS_BASE_URL!==GLS+'/shipit-farm/v1/backend/rs'||c.GOFO_BASE_URL!==GOFO)throw new Error('Seuls GLS sandbox et GOFO UAT sont autorisés');
  return createCarriers(c,{fetchImpl,gls:GLS,gofo:GOFO,production:false});
}
export function createProductionCarriers(c,{fetchImpl=fetch,erplainApi,shopifyReader}={}){
  const gls='https://api.gls-group.net',gofo='https://api-eu.gofoexpress.com';
  if(c.GLS_AUTH_BASE_URL!==gls||c.GLS_BASE_URL!==gls+'/shipit-farm/v1/backend/rs'||c.GOFO_BASE_URL!==gofo)throw new Error('Adresses de production GLS/GOFO inattendues');
  return createCarriers(c,{fetchImpl,erplainApi,shopifyReader,gls,gofo,production:true});
}
function createCarriers(c,{fetchImpl,erplainApi,shopifyReader,gls:GLS,gofo:GOFO,production}){
  const text=(value,max)=>String(value||'').replace(/\s+/g,' ').trim().slice(0,max);
  const tokens={};
  async function request(url,options,creation=false){
    let r;try{r=await fetchImpl(url,{...options,redirect:'error',signal:AbortSignal.timeout(30000)});}catch{const e=new Error('Transporteur injoignable (délai maximal 30 s).');e.uncertain=creation;throw e;}
    const raw=await r.text();let j;try{j=JSON.parse(raw);}catch{j=null;}
    if(!r.ok||!j){const detail=j?.errors||j?.Issues||j?.issues||j?.message||j||raw.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();const context=url.endsWith('/shipments')?' GLS (création étiquette)':'';const e=new Error(`Transporteur${context} : HTTP ${r.status} — ${detail?JSON.stringify(detail).slice(0,700):'réponse vide, aucun motif fourni par le transporteur'}`);e.uncertain=creation&&(r.status>=500||(r.ok&&!j));throw e;}return j;
  }
  async function token(carrier){
    if(tokens[carrier]?.until>Date.now())return tokens[carrier].value;
    let j,value,seconds;
    if(carrier==='gls'){
      j=await request(GLS+'/oauth2/v2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'client_credentials',client_id:c.GLS_CLIENT_ID,client_secret:c.GLS_CLIENT_SECRET}).toString()});value=j.access_token;seconds=j.expires_in;
    }else{j=await request(GOFO+'/openapi/oauth2/token',{method:'POST',headers:{'Content-Type':'application/json;charset=utf-8'},body:JSON.stringify({grantType:'client_credentials',appId:c.GOFO_APP_ID,appSecret:c.GOFO_APP_SECRET})});value=j.accessToken;seconds=j.expiresIn;}
    if(!value)throw new Error('Authentification '+carrier.toUpperCase()+' refusée');tokens[carrier]={value,until:Date.now()+Math.max(0,Number(seconds||300)-30)*1000};return value;
  }
  async function gofo(uri,body){
    const t=await token('gofo'),date=String(Date.now()),method=body?'POST':'GET',raw=body?JSON.stringify(body):undefined;
    const sign=createHmac('sha256',c.GOFO_APP_SECRET).update([...(raw?['body='+raw]:[]),'date='+date,'method='+method,'uri='+uri].join('&')).digest('base64');
    const j=await request(GOFO+uri,{method,headers:{token:t,date,sign,'route-country':'FR','Content-Type':'application/json;charset=utf-8'},body:raw},!!body);
    if(!(Number(j.code)===200&&(j.status===undefined||Number(j.status)===1))&&!(Number(j.code)===200305000&&(j.data?.cOrderNo||j.data?.waybillNo))){const e=new Error('GOFO '+String(j.code)+' : '+String(j.messageEn||j.message||j.msg||j.code).slice(0,350));e.rejected=true;e.zoneRejected=/this postal code is not currently in service|this postal code service is not available|unsupported area|postal code not exist in system postal code database/i.test(e.message);throw e;}return j;
  }
  return {
    async resolveParcelShop(o){

      let searchAddress=o.address;
      if(production&&o.channel==='shopify'){
       const reader=shopifyReader||shopifyCollector(await loadShopifyConfig(process.env.DATA_DIR||'/var/lib/nextech-live'));
       const raw=await reader.order(String(o.source_payload?.id||''));
       if(raw.name!==o.reference||String(raw.id)!==String(o.source_payload?.id))throw Error('GLS · Identité Shopify différente');
       const relay=readShopifyRelay(raw);if(!relay)throw Error('GLS · Métadonnées relais Shopify non reçues');
       o.source_payload={...o.source_payload,shopifyRelay:relay};searchAddress=relay.clientAddress;
       if(relay.selectedId){const a=relay.destinationAddress;return {parcelShopId:relay.selectedId,selection:'customer_selected',resolvedAt:new Date().toISOString(),environment:'production',sourceVersion:relay.sourceVersion,address:{Name1:raw.shipping_address?.address2||'',Street:a.street,ZIPCode:a.postal,City:a.city,CountryCode:a.country}};}
      }
      const id=production&&o.channel==='shopify'?null:existingParcelShop(o.source_payload);
      if(id)return o.source_payload?.glsParcelShop?.parcelShopId===id?o.source_payload.glsParcelShop:{parcelShopId:id,selection:'provided',address:null};
      const payload=await request(GLS+'/shipit-farm/v1/backend/rs/parcelshop/address',{method:'POST',headers:{Authorization:'Bearer '+await token('gls'),Accept:'application/glsVersion1+json, application/json','Content-Type':'application/glsVersion1+json'},body:JSON.stringify(parcelShopSearch(searchAddress))});
      const shops=normalizeParcelShops(payload),shop=chooseNearestParcelShop(shops);
      return {...shop,selection:'nearest_gls',resolvedAt:new Date().toISOString(),environment:production?'production':'test'};
    },
    async authenticate(carrier){if(!['gls','gofo'].includes(carrier))throw new Error('Transporteur inconnu');await token(carrier);return {carrier,authenticated:true,environment:production?'production':'test'};},
    async gls(o,{onParcel}={}){
      assertDirectCarrierAllowed(o,'gls');
      if(production&&o.channel==='shopify'&&o.carrier==='gls_shop'){
       const relay=assertFreshShopifyRelay(o),id=existingParcelShop(o.source_payload);
       if(relay.selectedId&&id!==relay.selectedId)throw Error('GLS · Relais différent du choix client');
       if(!relay.selectedId&&(o.source_payload?.glsParcelShop?.selection!=='nearest_gls'||!Number.isFinite(o.source_payload.glsParcelShop.distance)))throw Error('GLS · Relais le plus proche non vérifié');
       o={...o,address:relay.clientAddress};
      }
      if(isImportedErplain(o))o=await resolveImportedLabelOrder(o,erplainApi);
      else if(o.channel==='tender')o=await resolveTenderLabelOrder(o,erplainApi);
      const tenderAddress=o.channel==='tender'||isImportedErplain(o)?tenderGlsAddress(o):null;
      const labelOrder=o;
      const shipmentReferences=tenderAddress?[o.external_reference,o.label_bl]:labelReferences(labelOrder,40);
      if(isImportedErplain(o)&&String(o.label_bl).length>40)throw Error('Erplain LIVE · Numéro de BL trop long pour GLS : aucune troncature automatique');
      if(!Number.isInteger(Number(o.parcel_count))||Number(o.parcel_count)<1||Number(o.parcel_count)>100)throw Error('Nombre de colis invalide');
      if(Number(o.parcel_count)>1){const total=Number(o.parcel_total||o.parcel_count),combined={reference:'',tracking:[],documents:[]};for(let i=0;i<Number(o.parcel_count);i++){try{const one=await this.gls({...o,id:o.id+'-'+i,parcel_count:1,parcel_index:Number(o.parcel_start||1)+i,parcel_total:total});combined.reference=one.reference;combined.tracking.push(...one.tracking);combined.documents.push(...one.documents);if(onParcel)await onParcel(combined);}catch(e){if(combined.tracking.length){e.uncertain=true;e.partialResult=combined;}throw e;}}return combined;}
      const shopId=existingParcelShop(o.source_payload);if(o.carrier==='gls_shop'&&!shopId)throw new Error('ParcelShopID GLS manquant : résoudre le point relais avant création');
      const a={...o.address,email:o.address.email||o.source_payload?.buyeremail||o.source_payload?.contact_email||o.source_payload?.email},n=Number(o.parcel_count),w=Number(o.weight_kg);
      if(!Number.isInteger(n)||n<1||n>100||!(w>0))throw new Error('Poids ou nombre de colis invalide');
      const ref=(production?'V3P-':'V3T-')+o.id.replaceAll('-','').slice(0,26);
      const payload={Shipment:{ShipmentReference:shipmentReferences,Middleware:production?'NEXTECH LOGISTIC V3':'NEXTECH LOGISTIC V3 TEST',Product:String(a.country).toUpperCase()!=='FR'?(o.glsInternational?.product||'PARCEL'):(o.carrier==='gls_pharma'?'PHARMA':'PARCEL'),...(String(a.country).toUpperCase()!=='FR'&&o.glsInternational?.incoterm?{Incoterm:o.glsInternational.incoterm}:{}),...(o.carrier==='gls_shop'?{Service:[{ShopDelivery:{ServiceName:'service_shopdelivery',ParcelShopID:shopId}}]}:{}),...(o.carrier==='gls'&&a.email&&(String(a.country).toUpperCase()==='FR'||o.glsInternational?.flexDelivery!==false)?{Service:[{Service:{ServiceName:'service_flexdelivery'}}]}:{}),Consignee:{Address:{Name1:parcelRecipient(o,o.parcel_index||1,o.parcel_total||1,35),Name2:text(o.source_payload?.shipaddress2||o.source_payload?.adressedelivraisonadresse2,35),Name3:text(o.source_payload?.shipaddress3,35),CountryCode:text(a.country,2).toUpperCase(),ZIPCode:String(a.postal||'').replace(/\s+/g,'').toUpperCase(),City:text(a.city,40),Street:text(a.street||o.source_payload?.shipaddress1||o.source_payload?.adressedelivraisonadresse1,40),ContactPerson:parcelRecipient(o,o.parcel_index||1,o.parcel_total||1,40),...(a.email?{eMail:text(a.email,100)}:{}),...(tenderAddress||(a.phone?{MobilePhoneNumber:String(a.phone).replace(/[^\d+]/g,'').slice(0,25)}:{}))}},Shipper:{ContactID:c.GLS_CONTACT_ID_MONO},ShipmentUnit:Array.from({length:n},(_,i)=>({ShipmentUnitReference:shipmentReferences,Weight:0.25,Note1:labelNotes(o).note1,Note2:labelNotes(o).note2}))},PrintingOptions:{ReturnLabels:{TemplateSet:'NONE',LabelFormat:'PDF'}}};
      const create=async()=>request(GLS+'/shipit-farm/v1/backend/rs/shipments',{method:'POST',headers:{Authorization:'Bearer '+await token('gls'),Accept:'application/glsVersion1+json, application/json','Content-Type':'application/glsVersion1+json'},body:JSON.stringify(payload)},true);let j;try{j=await create();}catch(e){if(e.uncertain||payload.Shipment.Incoterm||!e.message.toLowerCase().includes('shipment.incoterm')||!e.message.toLowerCase().includes('shipment_valid_incoterm_if_needed'))throw e;payload.Shipment.Incoterm='DAP';j=await create();}
      const s=j.CreatedShipment;if(!s){const e=new Error('GLS : réponse sans expédition créée');e.uncertain=true;throw e;}
      return {reference:ref,tracking:(s.ParcelData||[]).map(p=>p.TrackID||p.ParcelNumber).filter(Boolean),documents:(s.PrintData||[]).filter(p=>p.Data).map(p=>p.Data)};
    },
    async gofoCreate(o){
      assertDirectCarrierAllowed(o,'gofo');
      if(isImportedErplain(o)){
       o=await resolveImportedLabelOrder(o,erplainApi);
       const client=String(o.erplain_label_customer.label),recipient=String(o.address.name),reference=String(o.external_reference),bl=String(o.label_bl);
       const total=Number(o.parcel_total||o.parcel_count||1),suffix=total>1?' ('+Number(o.parcel_index||1)+'/'+total+')':'';
       if((client+' · '+recipient+suffix).length>100||reference.length>30||(reference+' · '+bl).length>100)throw Error('Erplain LIVE · Client, destinataire ou références trop longs pour GOFO : aucune troncature automatique');
       o={...o,address:{...o.address,name:client+' · '+recipient},erplain_label_remarks:reference+' · '+bl};
      }
      if(String(o.address?.country||'').trim().toUpperCase()!=='FR')throw Error('GOFO réservé à la France : utiliser GLS international pour ce pays');
      const a=o.address,ref=(production?'V3P':'V3T')+o.id.replaceAll('-','').slice(0,26);
      const payload={cOrderNo:ref,referenceNo:labelReference(o,30),productType:c.GOFO_DEFAULT_PRODUCT_TYPE||'ECO',shippingType:c.GOFO_DEFAULT_SHIPPING_TYPE||'HDN',productCode:c.GOFO_DEFAULT_PRODUCT_CODE||'EU002',declaredValue:c.GOFO_DEFAULT_DECLARED_VALUE||'10',isCollectionPlan:production?0:1,orderShipper:{shipperName:c.GOFO_SHIPPER_NAME,shipperPhone:c.GOFO_SHIPPER_PHONE,shipperCountry:c.GOFO_SHIPPER_COUNTRY,shipperState:c.GOFO_SHIPPER_STATE,shipperCity:c.GOFO_SHIPPER_CITY,shipperArea:c.GOFO_SHIPPER_AREA||'',shipperStreet:c.GOFO_SHIPPER_STREET,shipperCode:c.GOFO_SHIPPER_CODE,shipperEmail:c.GOFO_SHIPPER_EMAIL},orderConsignee:{consigneeName:parcelRecipient(o,o.parcel_index||1,o.parcel_total||1,100),consigneePhone:a.phone||'',consigneeEmail:a.email||'',consigneeCountry:a.country,consigneeState:a.state||'',consigneeCity:a.city,consigneeStreet:a.street,consigneeCode:a.postal,remarks:o.erplain_label_remarks||labelReference(o,30),address1:a.street,address2:'',address3:''},orderGoods:{weight:'0.25',length:c.GOFO_DEFAULT_LENGTH||'25',width:c.GOFO_DEFAULT_WIDTH||'20',height:c.GOFO_DEFAULT_HEIGHT||'10'},orderItemList:[{itemNameEn:'Medical supplies',itemQty:1}]};
      const j=await gofo('/open-api/v2/order/create',payload);
      return {reference:j.data?.cOrderNo||ref,tracking:[j.data?.waybillNo].filter(Boolean),documents:[]};
    },
    async gofoLabel(ref){return (await gofo('/open-api/v2/order/getOrderLabelUrlV2?orderNo='+encodeURIComponent(ref))).data?.base64code;},
    async gofoTracking(ref){return (await gofo('/open-api/v2/order/track/'+encodeURIComponent(ref))).data;}
  };
}



