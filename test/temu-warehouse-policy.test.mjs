import test from 'node:test';
import assert from 'node:assert/strict';
import {selectTemuWarehouse} from '../src/temu-warehouse-policy.mjs';

const morcourt={warehouseId:'WH-03738368983180591',warehouseName:'Morcourt',defaultWarehouse:true,enableBuyShippingLabel:true};
const rozay={warehouseId:'WH-07213277470860591',warehouseName:'ENTROPOT ROZAY',defaultWarehouse:false,enableBuyShippingLabel:true};

test('France uses Rozay despite Morcourt being the platform default',()=>{
 assert.equal(selectTemuWarehouse([morcourt,rozay]),rozay);
 assert.equal(selectTemuWarehouse([rozay]),rozay);
});

test('France cannot fall back when Rozay is missing, disabled or ambiguous',()=>{
 for(const warehouses of [[morcourt],[morcourt,{...rozay,enableBuyShippingLabel:false}],[morcourt,rozay,{...rozay,warehouseId:'duplicate'}]]){
  assert.throws(()=>selectTemuWarehouse(warehouses),/Rozay/);
 }
});

test('other shops retain the default even when they have a Rosay warehouse',()=>{
 const otherDefault={...morcourt,warehouseId:'other-morcourt'};
 const otherRozay={...rozay,warehouseId:'other-rozay',warehouseName:'ROSAY'};
 assert.equal(selectTemuWarehouse([otherDefault,otherRozay]),otherDefault);
 assert.equal(selectTemuWarehouse([otherDefault]),otherDefault);
 assert.equal(selectTemuWarehouse([{...otherRozay,defaultWarehouse:false}]).warehouseId,'other-rozay');
});

test('other shops still reject missing or ambiguous defaults',()=>{
 assert.throws(()=>selectTemuWarehouse([]),/absent ou ambigu/);
 assert.throws(()=>selectTemuWarehouse([{warehouseId:'A'},{warehouseId:'B'}]),/absent ou ambigu/);
});
