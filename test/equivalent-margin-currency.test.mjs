import test from 'node:test';import assert from 'node:assert/strict';
import {equivalentReceipts,excelEquivalentReceipts} from '../src/temu-equivalent-margin.mjs';
import {excelCommercialSource} from '../src/temu-excel-commercial.mjs';
const m=(amount,currency='PLN')=>({amount,currency});
const data={parentOrderMap:{parentOrderSn:'PO-1',basePriceTotal:m(10000)},orderList:[{orderSn:'L1',quantity:2,basePrice:m(10000),unitBasePrice:m(5000),shipAmountTotalTaxIncl:m(1230),shipTaxAmount:m(230)}]};
const detail={orderList:[{orderSn:'L1',quantity:2}]};
test('API equivalent receipts convert original totals once with the published currency rate',()=>{
 const r=equivalentReceipts(data,detail,'PO-1',{c:'PLN',fx:5});assert.equal(r.revenue,20);assert.equal(r.credit,2);assert.match(r.conversionWarning,/1 EUR = 5 PLN/);
 for(const p of [undefined,{c:'EUR',fx:5},{c:'PLN',fx:0},{c:'PLN',fx:NaN}])assert.throws(()=>equivalentReceipts(data,detail,'PO-1',p),/conversion/);
 const bad=structuredClone(data);bad.orderList[0].shipTaxAmount.currency='EUR';assert.throws(()=>equivalentReceipts(bad,detail,'PO-1',{c:'PLN',fx:5}),/incohérente/);
});
test('Excel equivalent receipts preserve destination tax rounding before currency conversion',()=>{
 const o={channel:'temu',reference:'PO-1',address:{country:'PL'},source_payload:{origin:'temu_excel'}};
 const l={source_line:'L1',source_sku:'old',quantity:1,source_payload:{excel:{'Total du prix de base après réduction':'100 PLN','Taxe sur les produits':'23 PLN',"Total de l'expédition (hors taxes)":'10 PLN',"Taxe d'expédition":'2.30 PLN'}}};
 o.source_payload.temuExcelCommercial=excelCommercialSource(o,[l]);o.erp_live={equivalentOriginalLines:[l]};
 const r=excelEquivalentReceipts(o,[],{c:'PLN',fx:5});assert.equal(r.revenue,20);assert.equal(r.credit,2);assert.throws(()=>excelEquivalentReceipts(o,[]),/conversion/);
});
