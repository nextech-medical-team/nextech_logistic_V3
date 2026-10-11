import test from 'node:test';import assert from 'node:assert/strict';
import {createProductionCarriers} from '../src/carriers-test.mjs';
import {normalizeShopifyOrders} from '../src/marketplace-local-import.mjs';
import {marketplaceChanged} from '../src/marketplace-comparison.mjs';
import {chosenRoute} from '../src/routing.mjs';
const config={GLS_AUTH_BASE_URL:'https://api.gls-group.net',GLS_BASE_URL:'https://api.gls-group.net/shipit-farm/v1/backend/rs',GOFO_BASE_URL:'https://api-eu.gofoexpress.com',GLS_CONTACT_ID_MONO:'test-contact'};
const address={name:'Client Test',street:'10 rue Client',postal:'75001',city:'Paris',country:'FR',phone:'0600000000'};
function raw(selected='GLS_FR-222'){return {id:'123',name:'#TEST',created_at:'2026-10-01T00:00:00Z',updated_at:'2026-10-11T00:00:00Z',shipping_lines:[{title:'Relais GLS'}],shipping_address:{name:'Client Test',address1:'20 rue Relais',address2:'Commerce',zip:'75002',city:'Paris',country_code:'FR'},glsRelayId:{value:selected||'GLS_FR-111'},glsRelayMetadata:{value:JSON.stringify({selectedRelais:selected,defaultRelais:'GLS_FR-111',originalShippingAddress:{firstName:'Client',lastName:'Test',address1:'10 rue Client',zip:'75001',city:'Paris',countryCodeV2:'FR',phone:'0600000000'}})},line_items:[{id:'7',sku:'A',quantity:2}]};}
function order(){return {id:'order-id',reference:'#TEST',channel:'shopify',carrier:'gls_shop',address:{...address},weight_kg:1,parcel_count:1,source_payload:{id:'123',shopifyDeliveryMode:'relay',glsParcelShopId:'GLS_FR-OLD',glsParcelShop:{parcelShopId:'GLS_FR-OLD',selection:'nearest_gls'}}};}
test('selected relay replaces stale nearest in memory; proper ShopDelivery payload keeps customer address',async()=>{
 let calls=0,body;
 const client=createProductionCarriers(config,{shopifyReader:{order:async()=>raw()},fetchImpl:async(url,opt)=>{calls++;if(url.endsWith('/token'))return Response.json({access_token:'fake',expires_in:300});if(url.endsWith('/shipments')){body=JSON.parse(opt.body);return Response.json({CreatedShipment:{ParcelData:[{TrackID:'TEST'}],PrintData:[]}});}throw Error('Unexpected GLS lookup');}});
 const o=order(),shop=await client.resolveParcelShop(o);assert.equal(shop.parcelShopId,'GLS_FR-222');assert.equal(calls,0);
 o.source_payload.glsParcelShop=shop;o.source_payload.glsParcelShopId=shop.parcelShopId;
 await client.gls(o);assert.equal(body.Shipment.Service[0].ShopDelivery.ParcelShopID,'GLS_FR-222');assert.equal(body.Shipment.Service[0].ShopDelivery.ServiceName,'service_shopdelivery');assert.equal(body.Shipment.Consignee.Address.Street,'10 rue Client');
});
test('no customer choice searches around original client address and uses minimum measured distance',async()=>{
 let search;
 const client=createProductionCarriers(config,{shopifyReader:{order:async()=>raw(null)},fetchImpl:async(url,opt)=>{if(url.endsWith('/token'))return Response.json({access_token:'fake'});search=JSON.parse(opt.body);return Response.json({ParcelShop:[{ParcelShopID:'GLS_FR-3',AirlineDistance:3},{ParcelShopID:'GLS_FR-2',AirlineDistance:1}]});}});
 const shop=await client.resolveParcelShop(order());assert.equal(shop.parcelShopId,'GLS_FR-2');assert.equal(shop.selection,'nearest_gls');assert.equal(search.ZIPCode,'75001');assert.equal(search.Street,'rue Client');
});
test('source read failure never falls back to old nearest or creates shipment',async()=>{
 let calls=0;const client=createProductionCarriers(config,{shopifyReader:{order:async()=>{throw Error('Shopify unavailable');}},fetchImpl:async()=>{calls++;}});
 await assert.rejects(()=>client.resolveParcelShop(order()),/Shopify unavailable/);assert.equal(calls,0);
});
test('wrong source identity rejected before GLS calls',async()=>{let calls=0;const client=createProductionCarriers(config,{shopifyReader:{order:async()=>({...raw(),name:'#OTHER'})},fetchImpl:async()=>{calls++;}});await assert.rejects(()=>client.resolveParcelShop(order()),/Identité/);assert.equal(calls,0);});
test('direct creation cannot bypass source freshness gate',async()=>{let calls=0;const client=createProductionCarriers(config,{fetchImpl:async()=>{calls++;}});await assert.rejects(()=>client.gls(order()),/relire/);assert.equal(calls,0);});
test('normalization preserves client address: relay conversion does not block unchanged lines',()=>{const incoming={...normalizeShopifyOrders([raw()])[0],channel:'shopify'};assert.equal(incoming.address.street,address.street);assert.equal(incoming.source_payload.shopifyRelay.destinationAddress.street,'20 rue Relais, Commerce');assert.equal(marketplaceChanged(order(),[{source_line:'7',source_sku:'A',quantity:2}],incoming),false);const changed=raw();changed.glsRelayMetadata.value=JSON.stringify({selectedRelais:'GLS_FR-222',originalShippingAddress:{firstName:'Client',lastName:'Test',address1:'99 autre rue',zip:'75001',city:'Paris',countryCodeV2:'FR'}});assert.equal(marketplaceChanged(order(),[{source_line:'7',source_sku:'A',quantity:2}],normalizeShopifyOrders([changed])[0]),true);});
test('manual carrier choice cannot turn a relay order into home delivery',()=>{assert.equal(chosenRoute({...order(),transport_choice:'gofo'},1).carrier,'gls_shop');assert.equal(chosenRoute({...order(),transport_choice:'gls'},1).carrier,'gls_shop');});
test('customer selected relay rejected by GLS never switches to nearest',async()=>{let lookups=0,creates=0;const client=createProductionCarriers(config,{shopifyReader:{order:async()=>raw()},fetchImpl:async(url)=>{if(url.endsWith('/token'))return Response.json({access_token:'fake'});if(url.includes('/parcelshop/'))lookups++;if(url.endsWith('/shipments'))creates++;return Response.json({message:'ParcelShop unavailable'},{status:400});}});const o=order(),shop=await client.resolveParcelShop(o);o.source_payload.glsParcelShop=shop;o.source_payload.glsParcelShopId=shop.parcelShopId;await assert.rejects(()=>client.gls(o),/unavailable/);assert.equal(creates,1);assert.equal(lookups,0);});
