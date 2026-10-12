import {matchesLabelStageDecision} from '../src/local-label-stage-decision.mjs';
const o={id:'test',reference:'TEST',channel:'amazon',erp_live:{bc:{id:1},bl:{id:2,status:'in_preparation'},verifiedAt:'checked',stockCheckedAt:'checked',stockDocument:{id:3},labelPreparationFingerprint:'fingerprint'}},d={decision:'remove_label_stage_error_only',orderId:'test',reference:'TEST',bcId:'1',blId:'2',fingerprint:'fingerprint'},context={erp:{status:'complete',error:null}};
const n=100000,start=performance.now();let matched=0;for(let i=0;i<n;i++)matched+=matchesLabelStageDecision(o,d,'fingerprint',context)?1:0;
console.log(JSON.stringify({iterations:n,matched,durationMs:performance.now()-start,providerCalls:0,queryBudget:{noOrder:1,noDecision:2,explicitDecision:5},scope:'pure guard benchmark; database latency excluded'}));
if(matched!==n)process.exitCode=1;
