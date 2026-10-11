import test from 'node:test';
import assert from 'node:assert/strict';
import {currentMappingLine,mappingSelectionFingerprint} from '../src/current-mapping-line.mjs';
import {comparisonLines} from '../src/bc-comparison-lines.mjs';
const line={source_sku:'source',quantity:20,target_sku:'old',target_quantity:3000,mapped_sku:'680483',source_qty:1,target_qty:1};
test('current mapping defeats cached SKU and 3000-unit quantity for every channel',()=>{
 for(const channel of ['temu','shopify','amazon','tender','samples'])assert.deepEqual(comparisonLines([line],channel),[{sku:'680483',quantity:20}]);
});
test('a subsequent permanent mapping is used without requiring cache clearing',()=>{
 assert.deepEqual(currentMappingLine({...line,mapped_sku:'new',target_qty:2},'temu'),{sku:'new',quantity:40});
});
test('explicit order-only decision is preserved',()=>{
 assert.deepEqual(currentMappingLine({...line,source_payload:{mappingScope:'order'}},'temu'),{sku:'old',quantity:3000});
});
test('invalid current conversion fails instead of falling back to cached quantity',()=>{
 for(const source_qty of [0,null,undefined])assert.throws(()=>currentMappingLine({...line,source_qty},'temu'),/Conversion/);
});

test('preparation proof follows current mapping and quantities independently from stale line caches',()=>{const l={id:'1',source_sku:'SOURCE',quantity:20,target_sku:'OLD',target_quantity:3000,mapped_sku:'NEW',source_qty:1,target_qty:1};const a=mappingSelectionFingerprint([l],'temu');assert.notEqual(a,mappingSelectionFingerprint([{...l,target_qty:2}],'temu'));assert.notEqual(a,mappingSelectionFingerprint([{...l,mapped_sku:'LATEST'}],'temu'));assert.equal(a,mappingSelectionFingerprint([{...l,target_quantity:4000}],'temu'));assert.notEqual(a,mappingSelectionFingerprint([{...l,quantity:21}],'temu'));});
