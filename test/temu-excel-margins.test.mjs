import test from 'node:test';
import assert from 'node:assert/strict';
import {createMarginsService} from '../src/margins-service.mjs';
import {excelMargins} from '../scripts/temu-excel-margins.mjs';
const snapshot={countries:{FR:{n:'France',c:'EUR',fx:1,k:2.99,t:30}},services:[],transportGrids:{},amazon:[],temu:[{sku_temu:'SKU',sku_erplain:'ERP',sku_id:'123',mapping:2,purchase_unit_ht:3,supplier_transport_unit_ht:.5,weight_kg:.25,vat:.2}],context:{suppliers:[],margins:[],tariffs:[],fees:{},gls:[],gofo:[]},numSource:'function num(v){return Number(v);}',interpSource:'',transportSource:'function transport(){return {price:5,name:"fixture"};}',version:'test-only'};
function fixture(){
 const order={id:'o',reference:'PO-1-2',channel:'temu',carrier:'temu',address:{country:'FR'},source_payload:{origin:'temu_excel'}};
 const line={id:'l',order_id:'o',source_line:'line',source_sku:'SKU',quantity:2,target_sku:'ERP',target_quantity:4,source_payload:{skuId:'123',excel:{'Prix de base total':'20 EUR','Total du prix de base après réduction':'18 EUR',"Total de l'expédition (hors taxes)":'2 EUR',"Taxe d'expédition":'.40 EUR','Taxe sur les produits':'3.60 EUR','Total du prix de vente après réductions (hors taxes)':'18 EUR','quantité annulée':'0','statut de la commande':'Non expédié'}}};
 const job={reference:order.reference,plan:{amount:6,currency:'EUR'}};
 const db={async query(sql){if(sql.includes('FROM temu_label_jobs'))return {rows:[job]};if(sql.includes('FROM orders'))return {rows:[order]};if(sql.includes('FROM lines'))return {rows:[line]};throw Error(sql);}};
 const options={loadData:async()=>({orders:[order],lines:[line]}),snapshotLoader:async()=>structuredClone(snapshot)};
 return {order,line,job,db,options};
}
test('existing calculator uses Excel seller revenue, contribution once, catalogue mapping and actual TEMU quote',async()=>{
 const f=fixture();f.line.source_payload.excel["Taxe d'expédition"]='0.40 EUR';
 const service=await createMarginsService(f.db,f.options),result=(await service.get({fresh:true})).rows[0];
 assert.deepEqual(result.issues,[]);assert.equal(result.status,'positive');
 assert.equal(result.revenue,18);assert.equal(result.purchase,12);assert.equal(result.supplierShipping,2);assert.equal(result.shipping,5);assert.equal(result.credit,2);assert.equal(result.profit,1);assert.match(result.shippingSource,/Devis TEMU/);
 f.job.plan.amount=12;const updated=(await service.get({fresh:true})).rows[0];assert.equal(updated.profit,-4);assert.equal(updated.status,'negative');
 f.job.result={packageInfoResultList:[{packageSn:'PK-1',estimatedAmount:3,estimatedCurrencyCode:'EUR',orderSendInfoList:[{parentOrderSn:f.order.reference}]}]};const paid=(await service.get({fresh:true})).rows[0];assert.equal(paid.shipping,2.5);assert.match(paid.shippingSource,/Coût étiquette/);
});
test('Excel margin follows destination VAT rather than the retail tax in the report',async()=>{
 const f=fixture();f.order.address.country='SK';f.line.source_payload.excel["Taxe d'expédition"]='0.40 EUR';
 f.options.snapshotLoader=async()=>({...structuredClone(snapshot),countries:{...snapshot.countries,SK:{...snapshot.countries.FR,n:'Slovakia'}}});
 const result=(await (await createMarginsService(f.db,f.options)).get({fresh:true})).rows[0];
 assert.deepEqual(result.issues,[]);assert.equal(result.revenue,17.56);assert.equal(result.credit,1.95);
 assert.ok(Math.abs(result.profit-.51)<.00001);
});
test('missing prices, unknown SKUs and mismatched prepared quantities never give a complete margin',async()=>{
 for(const change of [f=>{delete f.line.source_payload.excel['Prix de base total'];delete f.line.source_payload.excel['Total du prix de base après réduction'];},f=>f.line.target_sku='OTHER',f=>f.line.target_quantity=20,f=>{f.line.source_sku='unknown';f.line.source_payload.skuId='unknown';}]){
  const f=fixture();change(f);const service=await createMarginsService(f.db,f.options);const row=(await service.get({fresh:true})).rows[0];assert.equal(row.status,'incomplete');assert.ok(row.issues.length);
 }
});

test('published BL costs prepared units instead of vetoing a changed global mapping',async()=>{
 const f=fixture();f.order.erp_live={bl:{id:'bl',status:'ready_to_ship'}};
 f.line.source_payload.excel["Taxe d'expédition"]='0.40 EUR';f.line.target_quantity=20;
 const row=(await (await createMarginsService(f.db,f.options)).get({fresh:true})).rows[0];
 assert.deepEqual(row.issues,[]);assert.equal(row.purchase,60);assert.equal(row.supplierShipping,10);assert.equal(row.profit,-55);assert.equal(row.status,'negative');
 // A negative result remains a purchase veto, not an obsolete mapping veto.
 assert.ok(!row.issues.some(s=>/Mapping|SKU préparé/.test(s)));
});

test('published BL replacement uses its own unit purchase costs; missing costs remain unknown',async()=>{
 const f=fixture();f.order.erp_live={bl:{id:'bl',status:'ready_to_ship'}};
 f.line.source_payload.excel["Taxe d'expédition"]='0.40 EUR';f.line.target_sku='REPLACEMENT';
 f.options.snapshotLoader=async()=>({...structuredClone(snapshot),temu:[...snapshot.temu,{...snapshot.temu[0],sku_temu:'NEW',sku_id:'456',sku_erplain:'REPLACEMENT',purchase_unit_ht:1}]});
 const service=await createMarginsService(f.db,f.options),row=(await service.get({fresh:true})).rows[0];
 assert.deepEqual(row.issues,[]);assert.equal(row.purchase,4);assert.equal(row.profit,9);assert.equal(row.status,'positive');
 f.line.target_sku='UNKNOWN';const missing=(await service.get({fresh:true})).rows[0];assert.equal(missing.status,'incomplete');assert.ok(missing.issues.some(s=>s.includes('Coût du SKU préparé')));
});
test('Excel adapter projects BC quantities and reports absent private costs explicitly',async()=>{
 const f=fixture();f.line.source_payload.excel["Taxe d'expédition"]='0.40 EUR';
 const documents={state:async()=>({pricing:{items:[{variant:{id:'v'},description:'ERP',quantity:4}]}})};
 const service=excelMargins({db:f.db,documents,snapshotLoader:f.options.snapshotLoader});assert.equal((await service.get({reference:f.order.reference})).rows[0].profit,1);
 const missing=excelMargins({db:f.db,documents,snapshotLoader:async()=>{throw Object.assign(Error('missing'),{code:'ENOENT'});}});
 const result=await missing.get({reference:f.order.reference});assert.equal(result.rows[0].profit,null);assert.match(result.rows[0].issues[0],/Référentiel privé/);
});
test('identical seller amounts from API and Excel give the same margin through the existing calculator',async()=>{
 const excel=fixture(),api=fixture(),m=amount=>({amount,currency:'EUR'});
 excel.line.source_payload.excel["Taxe d'expédition"]='0.40 EUR';
 api.order.source_payload={temuAmounts:{data:{parentOrderMap:{parentOrderSn:api.order.reference,estimatedRevenue:m(2400),basePriceTotal:m(1800),shippingAmountTotal:m(200),taxTotal:m(400)},orderList:[{orderSn:'line',quantity:2,basePrice:m(1800),unitBasePrice:m(900),productTaxAmount:m(360),shipAmountTotalTaxIncl:m(240),shipTaxAmount:m(40),productTaxRate:20000000,shipTaxRate:20000000}]}}};
 api.line.source_payload={skuId:'123'};
 const a=(await (await createMarginsService(excel.db,excel.options)).get({fresh:true})).rows[0];
 const b=(await (await createMarginsService(api.db,api.options)).get({fresh:true})).rows[0];
 assert.deepEqual(b.issues,[]);
 for(const key of ['status','profit','revenue','purchase','supplierShipping','shipping','credit','totalCosts','margin','markup'])assert.equal(a[key],b[key],key);
});

test('shipping a BL retains its prepared-unit margin without making it eligible for another label',async()=>{
 const {hasCreatedBl}=await import('../src/created-bl-label.mjs');
 const f=fixture();f.order.erp_live={bl:{id:'bl',status:'ready_to_ship'}};f.line.target_quantity=20;f.line.source_payload.excel["Taxe d'expédition"]='0.40 EUR';
 const service=await createMarginsService(f.db,f.options),before=(await service.get({fresh:true})).rows[0];
 f.order.erp_live.bl.status='shipped';const after=(await service.get({fresh:true})).rows[0];
 assert.equal(JSON.stringify(after),JSON.stringify(before));assert.equal(after.purchase,60);assert.equal(after.status,'negative');assert.equal(hasCreatedBl(f.order),false);
 f.line.target_sku='UNKNOWN';assert.equal((await service.get({fresh:true})).rows[0].status,'incomplete');
});
test('verified replacement receipts retire only stale revenue/contribution issues',async()=>{
 const {applyEquivalentReceipts}=await import('../src/temu-equivalent-margin.mjs');
 const fixture=()=>({issues:['Montant de vente absent ou invalide','Contribution invalide'],lines:[],purchase:5,supplierShipping:1,shipping:2,fees:0,other:0});
 const r=fixture();applyEquivalentReceipts(r,{revenue:10,credit:2});assert.equal(r.complete,true);assert.equal(r.profit,4);assert.deepEqual(r.issues,[]);
 const blocked=fixture();blocked.issues.push('Prix unitaire ou mapping manquant');applyEquivalentReceipts(blocked,{revenue:10,credit:2});assert.equal(blocked.complete,false);assert.deepEqual(blocked.issues,['Prix unitaire ou mapping manquant']);
 for(const totals of [{revenue:NaN,credit:2},{revenue:10,credit:NaN},{revenue:10,credit:-1},{revenue:undefined,credit:0}]){const r=fixture(),before=JSON.stringify(r);assert.throws(()=>applyEquivalentReceipts(r,totals),/invalides/);assert.equal(JSON.stringify(r),before);}
});

test('legacy shipped import without prepared quantities retains catalogue checks',async()=>{
 const f=fixture();f.line.source_payload.excel["Taxe d'expédition"]='0.40 EUR';f.line.target_quantity=null;
 const service=await createMarginsService(f.db,f.options),before=(await service.get({fresh:true})).rows[0];
 f.order.erp_live={bl:{id:'legacy',status:'shipped'}};const after=(await service.get({fresh:true})).rows[0];
 assert.equal(JSON.stringify(after),JSON.stringify(before));assert.equal(after.status,'positive');
 f.line.target_sku='UNKNOWN';assert.equal((await service.get({fresh:true})).rows[0].status,'incomplete');
});
