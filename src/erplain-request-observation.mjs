import {AsyncLocalStorage} from 'node:async_hooks';
const origins=new AsyncLocalStorage();
export const withErplainOrigin=(origin,fn)=>origins.run(String(origin).replace(/[^a-zA-Z0-9_.:-]/g,'_').slice(0,80),fn);
export function observeErplainRequest({operation='unknown',kind='query',status=null,outcome,attempt=0,durationMs=0,waitMs=0},logger=console){
 if(process.env.ERPLAIN_REQUEST_TELEMETRY==='0')return;
 // Never log URLs, headers, variables, provider error messages or order data.
 const event={event:'erplain.request',at:new Date().toISOString(),origin:origins.getStore()||'unattributed',operation:/^[A-Za-z_][A-Za-z0-9_]{0,79}$/.test(operation)?operation:'unknown',kind:['query','mutation','http'].includes(kind)?kind:'http',status:Number.isInteger(status)?status:null,outcome,attempt,durationMs:Math.max(0,Math.round(durationMs)),waitMs:Math.max(0,Math.round(waitMs))};
 try{logger.info(JSON.stringify(event));}catch{/* Telemetry cannot alter provider results. */}
}
export function erplainOperation(options){
 try{const query=JSON.parse(options.body).query;const m=/^\s*(query|mutation)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(query);if(m)return {kind:m[1],operation:m[2]};}catch{}
 return {kind:'http',operation:'http'};
}
