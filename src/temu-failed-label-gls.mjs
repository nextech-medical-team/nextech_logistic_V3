import {createHash} from 'node:crypto';
const orderId=o=>o.duplicate_of||o.id;
const fingerprint=o=>createHash('sha256').update(JSON.stringify({id:orderId(o),reference:o.reference,address:o.address,bc:String(o.erp_live?.bc?.id||''),bl:String(o.erp_live?.bl?.id||'')})).digest('hex');
const fail=()=>{throw Error('GLS manuel : un BL prêt et un refus TEMU confirmé sans suivi sont requis');};
function protectedOrder(o){return o.channel!=='temu'||o.archived||o.partial_mode||o.suspension?.active||o.suspension?.erplainCancellation||['cancelled','shipped','delivered','completed','in_transit','delivered_simulated'].includes(o.tracking_status)||o.source_payload?.externalLabel?.active||o.erp_live?.bc?.status!=='active'||!o.erp_live?.bc?.id||!o.erp_live?.bl?.id||o.erp_live.bl.status!=='ready_to_ship';}
export function failedTemuGlsApproval(o,d,known,{actor,resolutionId,now=Date.now()}={}){
 if(protectedOrder(o)||!actor||!resolutionId)fail();
 const age=now-Date.parse(d?.checkedAt);
 if(d?.provider!=='TEMU'||d.readOnly!==true||d.reference!==o.reference||d.status!==2||d.cancellationRequested!==false||!Number.isFinite(age)||age<0||age>60000||!Array.isArray(d.shipments)||d.shipments.length||!Array.isArray(d.packages)||!d.packages.length||!Array.isArray(d.errors)||!Array.isArray(known)||!known.length)fail();
 const packages=d.packages.map(p=>p.packageSn);
 if(new Set(packages).size!==packages.length||new Set(known).size!==known.length||JSON.stringify([...packages].sort())!==JSON.stringify([...known].sort()))fail();
 for(const p of d.packages)if(!/^PK-\d+$/.test(p.packageSn)||Number(p.shippingLabelStatus)!==2||p.canChangeToManualSend!==true||p.trackingNumber!==''||!p.failReasonText||!Array.isArray(p.shippingInfoList)||p.shippingInfoList.some(s=>s.trackingNumber)||!Array.isArray(p.orderSendInfoList)||!p.orderSendInfoList.length||p.orderSendInfoList.some(l=>l.parentOrderSn!==o.reference))fail();
 if(d.errors.some(e=>!packages.includes(e.packageSn))||packages.some(p=>!d.errors.some(e=>e.packageSn===p)))fail();
 return {version:1,carrier:'gls',orderId:orderId(o),reference:o.reference,blId:String(o.erp_live.bl.id),fingerprint:fingerprint(o),actor,resolutionId,at:new Date(now).toISOString(),checkedAt:d.checkedAt,packages};
}
export function hasFailedTemuGlsApproval(o,{now=Date.now()}={}){
 const p=o?.source_payload?.temuFailedLabelGlsApproval,age=now-Date.parse(p?.at);
 return !!p&&!protectedOrder(o)&&p.version===1&&p.carrier==='gls'&&p.orderId===orderId(o)&&p.reference===o.reference&&p.blId===String(o.erp_live.bl.id)&&p.fingerprint===fingerprint(o)&&!!p.actor&&!!p.resolutionId&&Array.isArray(p.packages)&&p.packages.length>0&&Number.isFinite(age)&&age>=0&&age<=600000;
}
