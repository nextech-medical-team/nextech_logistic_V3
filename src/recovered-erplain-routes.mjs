import {recoverOrderLabels} from './recovered-bl-label.mjs';

// Run label admission after the recovery service has committed its document
// changes. Include the confirmed attachment path used for existing V3 orders.
export async function recoveredErplainRoute(ctx,{db,api,targeted,manualReview,recover=recoverOrderLabels}){
 const {p,req,res,user,body,json}=ctx;
 if(req.method!=='POST')return false;
 const actions={
  '/api/erplain-refresh/targeted-lookup':[targeted,'lookup'],
  '/api/erplain-refresh/targeted-reread':[targeted,'reread'],
  '/api/erplain-refresh/targeted-reconcile':[targeted,'reconcile'],
  '/api/erplain-refresh/targeted-reactivate':[targeted,'reactivate'],
  '/api/erplain-refresh/manual-review/approve':[manualReview,'approve']
 };
 const action=actions[p];if(!action||typeof action[0]?.[action[1]]!=='function')return false;
 const result=await action[0][action[1]](await body(req),user);
 json(res,200,await recover(db,api,result,user));return true;
}
