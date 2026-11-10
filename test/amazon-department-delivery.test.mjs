import test from 'node:test';
import assert from 'node:assert/strict';
import {departmentFromPostal,validateAmazonDelivery,amazonDeliveryEstimate} from '../src/amazon-delivery-policy.mjs';
import {chosenRoute,configuredRoute,defaultRouting,validateRouting,loadRouting} from '../src/routing.mjs';

const policy={gofoExcludedDepartments:['75','2B','971'],amazonDeliveryOrigins:{gofo:'02100',gls:'77540'},amazonDeliveryRules:[{carrier:'gofo',originPostal:'02100',department:'13',workDays:1},{carrier:'gls',originPostal:'77540',department:'75',workDays:2}]};
const config=()=>({...structuredClone(defaultRouting),...structuredClone(policy)});
const order=(postal='75001',carrier='gofo')=>({channel:'amazon',carrier,address:{country:'FR',postal},erp_live:{}});
test('French departments preserve leading zeros, distinguish Corsica and overseas, and refuse unknown destinations',()=>{
 for(const [postal,department] of [['01000','01'],['75001','75'],['13001','13'],['20000','2A'],['20190','2A'],['20200','2B'],['20600','2B'],['97100','971'],['98800','988']])assert.equal(departmentFromPostal(postal),department);
 for(const postal of ['',null,'1000','ABCDE','00000','96000','97900'])assert.equal(departmentFromPostal(postal),null);
 assert.equal(departmentFromPostal('75001','BE'),null);
});
test('Amazon threshold and department exclusion select GLS without affecting other channels or destinations',()=>{
 assert.equal(configuredRoute('amazon',3,config(),'FR','13001').carrier,'gofo');
 assert.equal(configuredRoute('amazon',3.01,config(),'FR','13001').carrier,'gls');
 const route=chosenRoute(order(),2,config());assert.equal(route.carrier,'gls');assert.equal(route.gofoDepartmentExclusion.department,'75');assert.equal(route.parcels,1);
 assert.equal(chosenRoute({...order(),transport_choice:'gofo'},2,config()).carrier,'gls');
 assert.equal(chosenRoute({...order('13001'),transport_choice:'gls'},2,config()).carrier,'gls');
 assert.equal(chosenRoute(order('13001'),2,config()).carrier,'gofo');
 assert.equal(chosenRoute({...order(),channel:'shopify',source_payload:{shopifyDeliveryMode:'direct'}},2,config()).carrier,'gofo');
 assert.equal(configuredRoute('amazon',2,config(),'BE','75001').carrier,'gls');
 assert.equal(chosenRoute(order(''),2,config()).carrier,'gofo');
});
test('BL destination has authority over an older Amazon order address',()=>{
 const o={...order('13001'),erp_live:{bl:{id:'BL',shipping_address:{country:'FR',postal_code:'75001'}}}};
 assert.equal(chosenRoute(o,2,config()).carrier,'gls');
 const inverse={...order('75001'),erp_live:{bl:{id:'BL',shipping_address:{country:'FR',postal_code:'13001'}}}};
 assert.equal(chosenRoute(inverse,2,config()).carrier,'gofo');
 assert.equal(chosenRoute({...o,erp_live:{bl:{shipping_address:{country:'FR',postal_code:''}}}},2,config()).carrier,'gofo');
});
test('estimates require a matching carrier, departure warehouse and department; no invented service guarantee',()=>{
 const gls=amazonDeliveryEstimate(order('75001','gls'),config());assert.equal(gls.state,'configured');assert.equal(gls.workDays,2);assert.equal(gls.estimated,true);
 assert.equal(amazonDeliveryEstimate(order('13001'),config()).workDays,1);
 assert.equal(amazonDeliveryEstimate(order('75001'),config()).workDays,null);
 assert.equal(amazonDeliveryEstimate(order('75001','gls'),{...config(),amazonDeliveryOrigins:{gls:'02100'}}).workDays,null);
 assert.equal(amazonDeliveryEstimate({...order(),partial_mode:true},config()).state,'partial_deliveries');
 assert.equal(amazonDeliveryEstimate({...order(),channel:'temu'},config()),null);
 assert.equal(amazonDeliveryEstimate(order(),defaultRouting).workDays,null);
});
test('configuration roundtrips and rejects duplicate or invalid delay rules',async()=>{
 const stored=validateRouting(config());assert.deepEqual(stored.gofoExcludedDepartments,policy.gofoExcludedDepartments.slice().sort());assert.deepEqual(stored.amazonDeliveryRules,policy.amazonDeliveryRules);
 const loaded=await loadRouting({query:async()=>({rows:[{value:stored}]})});assert.deepEqual(loaded.amazonDeliveryOrigins,policy.amazonDeliveryOrigins);
 for(const overrides of [{gofoExcludedDepartments:['20']},{gofoExcludedDepartments:'75'},{amazonDeliveryOrigins:{gls:'1000'}},{amazonDeliveryRules:[{...policy.amazonDeliveryRules[0],workDays:0}]},{amazonDeliveryRules:[{...policy.amazonDeliveryRules[0],workDays:1.5}]},{amazonDeliveryRules:[policy.amazonDeliveryRules[0],policy.amazonDeliveryRules[0]]}])assert.throws(()=>validateAmazonDelivery({...policy,...overrides}));
 assert.deepEqual(validateAmazonDelivery({}).gofoExcludedDepartments,[]);
});
