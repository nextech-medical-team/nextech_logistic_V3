const pid=Number(process.argv[2]);
let target;
for(let n=0;n<30;n++){try{target=(await(await fetch('http://127.0.0.1:9229/json/list')).json())[0];break}catch{await new Promise(r=>setTimeout(r,200))}}
if(!target||!target.webSocketDebuggerUrl.startsWith('ws://127.0.0.1:9229/'))throw Error('Inspector unavailable or not loopback');
const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
let seq=0;const pending=new Map();ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error('Inspector error')):p.resolve(m.result)}};
const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
try{
 const identity=await call('Runtime.evaluate',{expression:'process.pid',returnByValue:true});if(identity.result.value!==pid)throw Error('Worker identity changed');
 const proto=await call('Runtime.evaluate',{expression:"process.getBuiltinModule('module').createRequire('/opt/nextech/current/src/server.mjs')('pg').Pool.prototype"});
 const objects=await call('Runtime.queryObjects',{prototypeObjectId:proto.result.objectId});
 const result=await call('Runtime.callFunctionOn',{objectId:objects.objects.objectId,functionDeclaration:`function(){if(this.length!==1)throw Error('Ambiguous pools');const p=this[0];if(![10,20].includes(p.options.max)||p.ending)throw Error('Unexpected pool');const before={max:p.options.max,total:p.totalCount,idle:p.idleCount,waiting:p.waitingCount};p.options.max=20;for(let i=0;i<10&&p.waitingCount;i++)p._pulseQueue();return {at:new Date().toISOString(),before,after:{max:p.options.max,total:p.totalCount,idle:p.idleCount,waiting:p.waitingCount},businessRequestsIssued:0}}`,returnByValue:true});
 if(result.exceptionDetails)throw Error('Pool guard refused');console.log(JSON.stringify(result.result.value));
}finally{await call('Runtime.evaluate',{expression:"setTimeout(()=>process.getBuiltinModule('inspector').close(),1500);'closing'",returnByValue:true});ws.close();}
