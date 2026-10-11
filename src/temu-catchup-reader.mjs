import {isMaskedAddressValue} from './temu-address-observation.mjs';
import {isDeepStrictEqual} from 'node:util';
import {temuSourceError} from './temu-catchup-policy.mjs';
const countryNames={France:'FR',Belgium:'BE',Croatia:'HR','Czech Republic':'CZ',Czechia:'CZ',Denmark:'DK',Greece:'GR',Hungary:'HU',Ireland:'IE',Italy:'IT',Latvia:'LV',Netherlands:'NL',Poland:'PL',Portugal:'PT',Slovenia:'SI',Spain:'ES',Sweden:'SE',Austria:'AT',Germany:'DE',Finland:'FI',Luxembourg:'LU',Malta:'MT',Estonia:'EE',Lithuania:'LT',Slovakia:'SK',Romania:'RO',Bulgaria:'BG',Cyprus:'CY','United Kingdom':'GB',Switzerland:'CH',Norway:'NO',Iceland:'IS'};
const countries=new Map(Object.entries(countryNames).map(([n,c])=>[n.toLowerCase(),c]));
const text=x=>typeof x==='string'?x.normalize('NFKC').trim():'';
const invalid=(field,message)=>{throw Object.assign(Error('TEMU · '+message),{code:'TEMU_INCOMPLETE',field});};
export function validateTemuSource(payload,reference,{requireShipping=true}={}){
 const {detail,shipping,amounts}=payload||{},parent=detail?.parentOrderMap,rows=detail?.orderList;
 if(parent?.parentOrderSn!==reference||!Array.isArray(rows)||!rows.length)invalid('detail','Identité ou lignes absentes');
 const status=Number(parent.parentOrderStatus);if(!Number.isSafeInteger(status)||status<1||status>7)invalid('detail','Statut non vérifiable');
 const ids=new Set();for(const l of rows){if(typeof l.orderSn!=='string'||!l.orderSn||ids.has(l.orderSn)||!Number.isSafeInteger(Number(l.quantity))||Number(l.quantity)<0)invalid('detail','Lignes ou quantités invalides');ids.add(l.orderSn);const skus=new Set((l.productList||[]).map(p=>text(p.extCode)).filter(Boolean));if(skus.size!==1)invalid('detail','Référence vendeur absente ou ambiguë');}
 const created=Number(parent.parentOrderTime);if(!Number.isSafeInteger(created)||created<=0)invalid('detail','Date source absente');
 const sourceCountry=text(parent.regionName1).toLowerCase(),shippingCountry=text(shipping?.regionName1).toLowerCase();
 if(!sourceCountry||!countries.has(sourceCountry)||requireShipping&&!isMaskedAddressValue(shipping?.regionName1)&&sourceCountry!==shippingCountry)invalid('shipping','Pays source absent, inconnu ou discordant');
 if(requireShipping&&(!text(shipping?.receiptName)||!text(shipping?.addressLine1)||!text(shipping?.postCode)||!text(shipping?.regionName3)))invalid('shipping','Coordonnées de livraison incomplètes');
 if(amounts?.parentOrderMap?.parentOrderSn!==reference||!Array.isArray(amounts.orderList))invalid('amounts','Identité ou montants absents');
 const money=amounts.parentOrderMap.estimatedRevenue;if(!money||!/^[A-Z]{3}$/.test(money.currency||'')||!/^\d+$/.test(String(money.amount))||!Number.isSafeInteger(Number(money.amount)))invalid('amounts','Règlement vendeur absent ou invalide');
 const amountIds=new Set();for(const a of amounts.orderList){if(!ids.has(a.orderSn)||amountIds.has(a.orderSn))invalid('amounts','Lignes financières étrangères ou dupliquées');amountIds.add(a.orderSn);const l=rows.find(l=>l.orderSn===a.orderSn);if(a.quantity!=null&&Number(a.quantity)!==Number(l.quantity)&&Number(l.orderStatus)!==3)invalid('amounts','Quantité financière différente');}
 if(rows.some(l=>Number(l.quantity)>0&&!amountIds.has(l.orderSn)))invalid('amounts','Montant de ligne absent');
 return {...payload,country:countries.get(sourceCountry)};
}
// No database, purchase, cancellation or PDF capability is accepted.
export async function readTemuSource(api,reference,{shouldStop=()=>false,onProgress=async()=>{},knownPackages=[]}={}){
 if(!/^PO-\d+-\d+$/.test(reference||''))throw Error('Référence TEMU invalide');
 const result={reference,checkedAt:new Date().toISOString(),coverage:{},errors:[],payload:{}};
 async function read(field,type,args){if(shouldStop())throw Object.assign(Error('Arrêt demandé'),{code:'TEMU_STOPPING'});await onProgress();try{const data=await api.read(type,args,{shouldStop});result.coverage[field]=result.coverage[field]!==false;return data;}catch(e){if(shouldStop()||['TEMU_STOPPING','TEMU_LEASE_LOST','source_budget_deferred'].includes(e.code))throw e;result.coverage[field]=false;result.errors.push(temuSourceError(e,field));return undefined;}}
 const detail=await read('detail','bg.order.detail.v2.get',{parentOrderSn:reference});result.payload.detail=detail;
 const created=Number(detail?.parentOrderMap?.parentOrderTime),until=Math.floor(Date.now()/1000);
 async function version(){
  if(!Number.isSafeInteger(created)||created<=0||created>until){result.errors.push({code:'TEMU_INCOMPLETE',field:'version',message:'TEMU · Date source non vérifiable'});return;}
  let total=null;const seen=new Set();
  for(let pageNumber=1;pageNumber<=1000;pageNumber++){
   const response=await read('version','bg.order.list.v2.get',{pageNumber,pageSize:50,updateAtStart:created-1,updateAtEnd:until,sortby:'updateTime'});
   if(!response)return;
   const count=Number(response.totalItemNum),items=response.pageItems;
   if(!Number.isSafeInteger(count)||count<0||!Array.isArray(items)||items.length>50||total!==null&&total!==count){result.errors.push({code:'TEMU_INCOMPLETE',field:'version',message:'TEMU · Pagination source instable'});return;}total=count;
   let match;for(const item of items){const ref=item?.parentOrderMap?.parentOrderSn;if(!ref||seen.has(ref)){result.errors.push({code:'TEMU_IDENTITY',field:'version',message:'TEMU · Identité de liste incohérente'});return;}seen.add(ref);if(ref===reference)match=item;}
   if(seen.size>total||!items.length&&seen.size<total){result.errors.push({code:'TEMU_INCOMPLETE',field:'version',message:'TEMU · Page source manquante'});return;}
   if(match){const updated=Number(match.parentOrderMap.updateTime);if(!Number.isSafeInteger(updated)||updated<=0||updated>until||Number(match.parentOrderMap.parentOrderStatus)!==Number(detail.parentOrderMap.parentOrderStatus)){result.errors.push({code:'TEMU_INCOMPLETE',field:'version',message:'TEMU · Version ou état source non vérifiable'});return;}return match;}
   if(pageNumber*50>=total)break;
   if(items.length!==50)break;
  }
  result.errors.push({code:'TEMU_INCOMPLETE',field:'version',message:'TEMU · Commande absente de la liste source'});
 }
 const firstVersion=await version();
 // Retain independent successes when one endpoint refuses this order.
 const [rawShipping,amounts]=await Promise.all([read('shipping','bg.order.decryptshippinginfo.get',{parentOrderSn:reference}),read('amounts','bg.order.amount.query',{parentOrderSn:reference})]);
 result.payload.shipping=rawShipping?.result||rawShipping;result.payload.amounts=amounts;
 const observedCountry=text(detail?.parentOrderMap?.regionName1).toLowerCase(),deliveryCountry=text(result.payload.shipping?.regionName1).toLowerCase();
 if(detail?.parentOrderMap?.parentOrderSn===reference&&countries.has(observedCountry)&&(!result.payload.shipping||isMaskedAddressValue(result.payload.shipping.regionName1)||deliveryCountry===observedCountry))result.payload.country=countries.get(observedCountry);
 if(detail?.parentOrderMap?.parentOrderSn===reference&&Array.isArray(detail.orderList)&&detail.orderList.length){
  const shipments=[];for(const line of detail.orderList){const r=await read('shipments','bg.logistics.shipment.v2.get',{parentOrderSn:reference,orderSn:line.orderSn});if(r){if(!Array.isArray(r.shipmentInfoDTO)){result.errors.push({code:'TEMU_INCOMPLETE',field:'shipments',message:'TEMU · Réponse expéditions incomplète'});continue;}shipments.push(...r.shipmentInfoDTO);}}
  const parcels=shipments.flatMap(s=>[s,...(s.subPackageShipmentInfoList||[])]);
  if(parcels.some(p=>p.parentOrderSn&&p.parentOrderSn!==reference||p.orderSn&&!detail.orderList.some(l=>l.orderSn===p.orderSn)))result.errors.push({code:'TEMU_IDENTITY',field:'shipments',message:'TEMU · Expédition étrangère'});
  result.payload.shipments=shipments;
  const packages=[...new Set([...knownPackages,...detail.orderList.flatMap(l=>(l.packageSnInfo||[]).map(p=>p.packageSn)),...parcels.map(p=>p.packageSn)].filter(Boolean))];
  if(packages.some(p=>!/^PK-\d+$/.test(p)))result.errors.push({code:'TEMU_IDENTITY',field:'packages',message:'TEMU · Colis invalide'});
  else if(packages.length){const r=await read('packages','bg.logistics.shipment.result.get',{packageSnList:packages});if(r){const rows=r.packageInfoResultList;if(!Array.isArray(rows)||rows.length!==packages.length||new Set(rows.map(p=>p.packageSn)).size!==packages.length||rows.some(p=>!packages.includes(p.packageSn)||!p.orderSendInfoList?.some(l=>l.parentOrderSn===reference)))result.errors.push({code:'TEMU_IDENTITY',field:'packages',message:'TEMU · Résultat colis incomplet ou étranger'});else result.payload.packages=rows;}}
 }
 const last=await read('consistency','bg.order.detail.v2.get',{parentOrderSn:reference});
 if(detail&&last&&!isDeepStrictEqual(detail,last))result.errors.push({code:'TEMU_CHANGED_DURING_READ',field:'consistency',message:'TEMU · Commande modifiée pendant la lecture'});
 const lastVersion=await version();
 if(firstVersion&&lastVersion){
  if(!isDeepStrictEqual(firstVersion,lastVersion)||detail.parentOrderMap.updateTime!=null&&Number(detail.parentOrderMap.updateTime)!==Number(firstVersion.parentOrderMap.updateTime))result.errors.push({code:'TEMU_CHANGED_DURING_READ',field:'version',message:'TEMU · Version modifiée pendant la lecture'});
  else {result.sourceVersion=Number(firstVersion.parentOrderMap.updateTime);result.payload.detail={...detail,parentOrderMap:{...detail.parentOrderMap,updateTime:result.sourceVersion}};}
 }
 const status=Number(detail?.parentOrderMap?.parentOrderStatus);
 result.sourceStage=status===1?'pending':status===3?'cancelled':'fulfillment';
 const expectedShippingRefusal=[1,3].includes(status)&&result.errors.some(e=>e.field==='shipping'&&String(e.code)==='180020006');
 try{result.payload=validateTemuSource(result.payload,reference,{requireShipping:!expectedShippingRefusal});}catch(e){if(!result.errors.some(x=>x.field===e.field))result.errors.push(temuSourceError(e,e.field||'coverage'));}
 result.expectedUnavailable=expectedShippingRefusal?['shipping']:[];
 result.complete=result.errors.length===0;
 result.coreComplete=!!result.coverage.detail&&!!result.coverage.shipping&&!!result.coverage.amounts&&!!result.coverage.consistency&&!result.errors.some(e=>!['shipments','packages'].includes(e.field));
 result.requiredComplete=result.complete||expectedShippingRefusal&&!!result.coverage.detail&&!!result.coverage.amounts&&!!result.coverage.consistency&&result.errors.every(e=>e.field==='shipping'&&String(e.code)==='180020006');
 return result;
}
