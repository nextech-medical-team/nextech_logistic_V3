import {hasCreatedBl} from './created-bl-label.mjs';
import {preparedTemuMarginCost} from './post-bl-margin-cost.mjs';
import {temuCommercialSource} from './temu-commercial-source.mjs';
import {excelAmounts} from './temu-excel-commercial.mjs';
import {temuDestinationVat} from './temu-destination-vat.mjs';
import {temuCountryAmounts,temuFixedVat} from './temu-country-vat.mjs';
import {equivalentReceipts,applyEquivalentReceipts} from './temu-equivalent-margin.mjs';
import {amountFields,quoteCost} from './temu-margin-data.mjs';
import vm from 'node:vm';import {readFile} from 'node:fs/promises';
const canonical=s=>String(s).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');
const amazonFields=['amazon-order-id','order-item-id','sku','product-name','quantity','purchase-date','ship-country','sales-channel','currency','order-status','fulfillment-channel','item-price','item-tax','shipping-price','shipping-tax','gift-wrap-price','gift-wrap-tax','item-promotion-discount','ship-promotion-discount'];
const temuFields=['Order ID',"N° de l'article de la commande",'contribution SKU','N° SKU','nom du produit',"date d'achat","pays d'expédition",'quantité achetée','quantité annulée','quantité expédiée','statut de la commande','Total du prix de base après réduction','Prix de base total','Prix de vente (hors taxes)','Total du prix de vente après réductions (hors taxes)',"Total de l'expédition (hors taxes)",'Taxe sur les produits',"Taxe d'expédition",'Remboursement des produits','Réduction de la part du vendeur','Réduction de la part de Temu'];
export async function createMarginsService(db,{confirmedAmazonIds=[],confirmedAmazonImportsFbm=false,readAsset=readFile,loadData=null,snapshotLoader=null}={}){
 const confirmedFbm=new Set(confirmedAmazonIds);
 let snapshot,sources;
 try{
  snapshot=snapshotLoader?await snapshotLoader():JSON.parse(await readAsset(new URL('./margin-published-snapshot.json',import.meta.url),'utf8'));
  sources=JSON.parse(await readAsset(new URL('./margin-published-sources.json',import.meta.url),'utf8'));
 }catch(e){
  if(e.code!=='ENOENT')throw e;
  const reason='Calcul des marges indisponible : référentiel privé manquant';
  console.warn(reason);
  return {async get(){
   const supplied=loadData?await loadData():null;
    const orders=supplied?.orders||(await db.query('SELECT id,reference,channel FROM orders WHERE archived=false ORDER BY received_at DESC')).rows;
   return {available:false,reason,source:{url:null,version:'indisponible',capturedAt:null},calculatedAt:new Date().toISOString(),rows:orders.map(o=>({...o,status:'incomplete',profit:null,markup:null,margin:null,issues:[reason],lines:[]}))};
  }};
 }
 const context=vm.createContext({window:{},Intl,console,countries:snapshot.countries,services:snapshot.services,transportGrids:snapshot.transportGrids,amazonRows:snapshot.amazon,rows:snapshot.temu,amazonEffective:r=>r,effective:r=>r,esc:s=>String(s??'')});
 context.window=context;
 for(const name of ['margin-math.js','amazon-calculation.js'])vm.runInContext(sources[name],context,{timeout:5000});
 context.AmazonCostRules=context.AmazonCalculation.create(snapshot.context);
 vm.runInContext(snapshot.numSource+'\n'+snapshot.interpSource+'\n'+snapshot.transportSource,context,{timeout:5000});
 const marker=' const tab=document.createElement';const at=sources['order-margins.js'].indexOf(marker);if(at<0)throw Error('Version du calculateur incompatible');
 vm.runInContext(sources['order-margins.js'].slice(0,at)+'window.marginEngine={analyze,adapters};})();',context,{timeout:5000});
 const adapters={amazon:context.marginEngine.adapters('amazon'),temu:context.marginEngine.adapters('temu')};
 let cache=null,last=0,inflight=null;
 async function calculate(){
 const supplied=loadData?await loadData():null;
 const orders=supplied?.orders||(await db.query('SELECT id,reference,channel,carrier,address,source_payload,source_date,erp_live FROM orders WHERE archived=false ORDER BY received_at DESC')).rows;
 const lines=supplied?.lines||(await db.query('SELECT l.id,l.order_id,l.source_line,l.source_sku,l.quantity,l.target_sku,l.target_quantity,l.source_payload FROM lines l JOIN orders o ON o.id=l.order_id WHERE o.archived=false')).rows;
 const grouped=new Map();for(const l of lines){if(!grouped.has(l.order_id))grouped.set(l.order_id,[]);grouped.get(l.order_id).push(l);}
 const labelJobs=new Map((await db.query('SELECT reference,plan,result FROM temu_label_jobs')).rows.map(j=>[j.reference,j]));
 const output=[];
 for(const o of orders){
  const sourceLines=grouped.get(o.id)||[];if(!['amazon','temu'].includes(o.channel)){output.push({id:o.id,reference:o.reference,channel:o.channel,status:'incomplete',issues:['Canal non couvert par le calculateur Amazon/TEMU'],lines:[]});continue;}
  const fields=o.channel==='amazon'?amazonFields:temuFields;
  const amountIssues=[];
  const equivalentOrder=o.channel==='temu'&&sourceLines.length>0&&sourceLines.every(l=>['erplain_live_equivalent','erplain_live_bc'].includes(l.source_payload?.origin));
  const raw=sourceLines.map(l=>{const source={...(o.source_payload?.origin==='temu_excel'?l.source_payload?.excel:{}),...o.source_payload,...l.source_payload},lookup=new Map(Object.entries(source).map(([k,v])=>[canonical(k),v]));const r=Object.fromEntries(fields.map(k=>[k,lookup.get(canonical(k))??'']));r.sourceRow=l.id;if(o.channel==='amazon'){r['amazon-order-id']=o.reference;r['order-item-id']=l.id;r.sku=l.source_sku;r.quantity=Number(l.quantity);r['ship-country']=o.address?.country||r['ship-country'];}else{r['Order ID']=o.reference;r["N° de l'article de la commande"]=l.id;r['contribution SKU']=l.source_sku;r['quantité achetée']=Number(l.quantity);r["pays d'expédition"]=o.address?.country||r["pays d'expédition"];r['N° SKU']=r['N° SKU']||source.skuId||'';r['nom du produit']=r['nom du produit']||source.goodsName||'';
   const amounts=o.source_payload?.temuAmounts;
   if(!equivalentOrder&&o.source_payload?.origin==='temu_excel'){try{
    const {rate}=temuDestinationVat(o),a=excelAmounts([l],{country:o.address?.country}),row=a.rows[0];
    const gross=Math.round((row.net+row.tax)*100),shipping=Math.round((row.shipping+row.shippingTax)*100),tax=Math.round(gross*rate/(100+rate)),shippingTax=Math.round(shipping*rate/(100+rate));
    const money=n=>(n/100)+' '+a.currency;
    for(const key of ['Total du prix de base après réduction','Prix de base total','Prix de vente (hors taxes)','Total du prix de vente après réductions (hors taxes)'])r[key]=money(gross-tax);
    r['Taxe sur les produits']=money(tax);r["Total de l'expédition (hors taxes)"]=money(shipping-shippingTax);r["Taxe d'expédition"]=money(shippingTax);
   }catch(e){amountIssues.push(e.message);}}
   if(!equivalentOrder&&o.source_payload?.origin!=='temu_excel'){try{Object.assign(r,amountFields(temuCommercialSource(o,temuCountryAmounts(o)),o.reference,l));}catch(e){amountIssues.push(e.message);}}
   const hasReportPrice=['Total du prix de base après réduction','Prix de base total'].some(k=>String(r[k]).trim()!=='');
   const unit=source.puht,quantity=Number(l.quantity),currency=String(source.currency||'').toUpperCase();
   if(!hasReportPrice&&unit!==null&&unit!==undefined&&String(unit).trim()!==''&&Number.isFinite(Number(unit))&&Number(unit)>=0&&quantity>0&&/^[A-Z]{3}$/.test(currency))r['Prix de base total']=(Number(unit)*quantity)+' '+currency;
}return r;});
  const confirmedFallback=o.channel==='amazon'&&(confirmedAmazonImportsFbm||confirmedFbm.has(o.id))&&raw.some(l=>!String(l['fulfillment-channel']||'').trim());
  if(confirmedFallback)for(const l of raw)if(!String(l['fulfillment-channel']||'').trim())l['fulfillment-channel']='Merchant';
  let transportIssue=null,transportSource=null;
  const checkedAdapter={...adapters[o.channel],shipping(included,weight){
   const carrier=String(o.carrier||'').trim().toLowerCase();
   const name=carrier==='gofo'?'GOFO':['gls','gls_home','gls_shop','gls_pharma'].includes(carrier)?'GLS':null;
   const fail=message=>{transportIssue=message;return null;};
   if(o.channel==='temu'&&(carrier==='temu'||labelJobs.get(o.reference)?.result?.packageInfoResultList?.length)){
    const job=labelJobs.get(o.reference);
    if(job?.plan||job?.result?.packageInfoResultList?.length){try{
     // TVA de 20 % confirmée par l’utilisateur le 05/10/2026 pour les devis TEMU.
     const vat=0.20;
     const cost=quoteCost(job,vat);transportSource=cost.source+' : '+cost.ttc.toFixed(2)+' € TTC · TVA retenue '+(cost.vat*100)+' % · '+cost.ht.toFixed(5)+' € HT';return cost.ht;
    }catch(e){return fail(e.message);}}

    if(!included.length||!(weight>0)||!Number.isFinite(weight))return fail('Poids indisponible pour l’estimation TEMU');
    const country=included[0].country;
    if(included.some(l=>l.country!==country))return fail('Pays contradictoires pour l’estimation TEMU');
    const quote=context.transport(country,weight,{});
    if(!Number.isFinite(quote?.price)||quote.price<0)return fail('Tarif estimé TEMU indisponible dans le calculateur pour '+country+' / '+weight+' kg');
    transportSource='Estimation TEMU · calculateur publié · '+country+' · '+quote.name+' · '+weight+' kg · '+quote.price.toLocaleString('fr-FR',{maximumFractionDigits:5})+' € HT (coût d’étiquette non rapproché)';
    return quote.price;
   }
   if(!name)return fail(carrier?'Tarif du transporteur V3 indisponible : '+carrier:'Transporteur V3 à déterminer');
   if(!included.length||!(weight>0)||!Number.isFinite(weight))return fail('Poids indisponible pour le tarif transporteur');
   if(included.some(l=>l.country!=='FR'))return fail('Tarif '+name+' hors France absent du référentiel publié');
   if(o.channel==='amazon'&&included.some(l=>l.channel!=='Merchant'))return fail('Transport Amazon réservé aux commandes FBM');
   let price=null;
   if(o.channel==='amazon')price=(snapshot.context[name.toLowerCase()]||[]).find(row=>Number(row[0])>=weight)?.[2]??null;
   else {const grid=snapshot.transportGrids[name+' France']||[];const row=grid.find(row=>{const v=Object.values(row);return name==='GLS'?Number(v[0])>=weight:weight>=Number(v[0])&&weight<=Number(v[1]);});price=row?context.num(Object.values(row).at(-1),null):null;}
   if(!Number.isFinite(price)||price<0)return fail('Tarif '+name+' indisponible pour '+weight+' kg');
   transportSource=name+' retenu dans V3 ('+carrier+') · poids calculateur '+weight+' kg · tarif publié '+price.toLocaleString('fr-FR',{maximumFractionDigits:5})+' € HT';
   return price;
  },find(l){const found=adapters[o.channel].find(l);const v3=sourceLines.find(x=>x.id===l.id);
   if(o.channel==='temu'&&hasCreatedBl(o))return preparedTemuMarginCost({profiles:snapshot.temu,line:v3,orderLine:l,adapter:adapters.temu});
   if(o.source_payload?.origin==='temu_excel'&&v3?.target_sku){
    const byId=snapshot.temu.filter(r=>String(r.sku_id||'')===String(l.skuId||'')&&l.skuId);
    const matches=byId.length?byId:snapshot.temu.filter(r=>String(r.sku_temu)===String(l.sku));
    if(matches.length!==1||String(matches[0].sku_erplain||matches[0].sku_temu)!==String(v3.target_sku))return {error:'SKU préparé dans le BC différent du calculateur publié'};
   }
   if(found.cost&&v3?.target_quantity!=null&&Math.abs(Number(v3.target_quantity)/Number(v3.quantity)-found.cost.mapping)>1e-9)return {error:'Mapping V3 différent du calculateur publié'};return found;}};
  let result;try{result=context.marginEngine.analyze(raw,o.channel,checkedAdapter,{},{}).orders[0];}catch(e){result={complete:false,issues:['Diagnostic du calculateur indisponible : '+e.message],lines:[]};}
  const r=result||{complete:false,issues:['Aucune ligne à calculer'],lines:[]};
  if(equivalentOrder){try{applyEquivalentReceipts(r,equivalentReceipts(temuCommercialSource(o,temuCountryAmounts(o)),o.source_payload?.temuOrderDetail,o.reference));}catch(e){amountIssues.push(e.message);r.complete=false;}}
  if(transportSource)r.shippingSource=transportSource;
  if(o.source_payload?.origin==='temu_excel')r.warnings=[...(r.warnings||[]),'Ventes et contribution issues du rapport Excel TEMU ; coûts du calculateur publié.'];
  if(o.channel==='temu'&&sourceLines.some(l=>l.source_payload?.puht!=null))r.warnings=[...(r.warnings||[]),'Ventes API : prix unitaire HT importé × quantité de la ligne, dans la devise d’origine.'];
  if(o.channel==='temu'&&String(o.carrier).toLowerCase()==='temu'&&transportSource?.startsWith('Estimation'))r.warnings=[...(r.warnings||[]),'Marge estimée selon le calculateur publié ; le coût de l’étiquette TEMU reste à rapprocher.'];
  if(confirmedFallback)r.warnings=[...(r.warnings||[]),'Expédition FBM confirmée par l’utilisateur pour cette commande.'];
  const missingFulfillment=o.channel==='amazon'&&raw.some(l=>!String(l['fulfillment-channel']||'').trim());
  r.issues=(r.issues||[]).map(message=>missingFulfillment&&message==='Coûts disponibles uniquement pour Amazon France expédié par le vendeur'?'Mode d’expédition Amazon absent du fichier : confirmer FBM ou FBA':message.startsWith('Coût de livraison HT manquant')?(transportIssue||'Livraison HT non calculable avec le profil disponible'):message);
  if(o.channel==='temu'){r.issues=[...new Set([...(r.issues||[]).map(m=>m==='Montant de vente absent ou invalide'?(o.source_payload?.temuAmountsError?.message||'TEMU · Prix de vente à récupérer par API'):m),...amountIssues])];if(r.issues.length)r.complete=false;}
  output.push({id:o.id,reference:o.reference,channel:o.channel,status:r.complete?(r.profit<0?'negative':r.profit>0?'positive':'zero'):'incomplete',profit:r.profit??null,markup:r.markup??null,margin:r.marginTotalReceipts??null,revenue:r.revenue??null,credit:r.credit??null,totalReceipts:r.totalReceipts??null,purchase:r.purchase??null,supplierShipping:r.supplierShipping??null,shipping:r.shipping??null,fees:r.fees??null,other:r.other??null,totalCosts:r.totalCosts??null,shippingSource:r.shippingSource,creditSource:r.creditSource,issues:r.issues||[],warnings:r.warnings||[],lines:(r.lines||[]).map(l=>({sku:l.sku,product:l.product,quantity:l.q,profit:l.profit??null,revenue:l.revenue??null,purchase:l.purchase??null,shipping:l.shipping??null,fees:l.allocatedFees??null,issues:l.issues||[]}))});
 }
 return {source:{url:snapshot.url,version:snapshot.version,capturedAt:snapshot.capturedAt},calculatedAt:new Date().toISOString(),rows:output};
 }
 return {async get({fresh=false}={}){if(fresh)return calculate();if(cache&&Date.now()-last<30000)return cache;if(!inflight)inflight=calculate().then(r=>{cache=r;last=Date.now();return r;}).finally(()=>inflight=null);return inflight;}};
}
