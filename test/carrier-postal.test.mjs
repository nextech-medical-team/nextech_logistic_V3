import test from 'node:test';
import assert from 'node:assert/strict';
import {carrierPostal} from '../src/carrier-postal.mjs';
import {createProductionCarriers} from '../src/carriers-test.mjs';
test('Spanish four-digit numeric input restores the missing zero without changing other countries or complete values',()=>{
 for(const [country,input,expected] of [['ES','8870','08870'],[' es ',8870,'08870'],['ES','08870','08870'],['ES','28001','28001'],['FR','8870','8870'],['DE','8870','8870'],['GB','ab1 2cd','AB12CD'],['ES','870','870'],['ES',null,''],['ES','A870','A870']])assert.equal(carrierPostal(country,input),expected);
});
test('Amazon carrier payload uses 08870 while the order, BL and source address stay immutable',async()=>{
 const o={id:'o',reference:'ORDER',channel:'amazon',carrier:'gls',source_payload:{},address:{name:'Recipient',street:'Street',city:'SITGES',country:'ES',postal:'8870'},weight_kg:1,parcel_count:1,erp_live:{bl:{id:'bl',label:'BL'}}};
 const before=JSON.stringify(o);let requests=0;
 const c={GLS_AUTH_BASE_URL:'https://api.gls-group.net',GLS_BASE_URL:'https://api.gls-group.net/shipit-farm/v1/backend/rs',GOFO_BASE_URL:'https://api-eu.gofoexpress.com'};
 const fetchImpl=async(url,opt)=>{
  if(url.endsWith('/token'))return {ok:true,status:200,text:async()=>JSON.stringify({access_token:'test',expires_in:60})};
  assert.ok(url.endsWith('/shipments'));requests++;assert.equal(JSON.parse(opt.body).Shipment.Consignee.Address.ZIPCode,'08870');
  return {ok:true,status:200,text:async()=>JSON.stringify({CreatedShipment:{ParcelData:[{TrackID:'TRACK'}],PrintData:[{Data:Buffer.from('%PDF-1.4').toString('base64')}]}})};
 };
 const result=await createProductionCarriers(c,{fetchImpl}).gls(o);assert.equal(requests,1);assert.deepEqual(result.tracking,['TRACK']);assert.equal(JSON.stringify(o),before);
});
