// Keep alternative estimates separate from the margin used to authorize a purchase.
export function marginScenario(result,extra={}){
 const complete=result?.complete===true&&Number.isFinite(result.profit);
 const out={status:complete?(result.profit<0?'negative':result.profit>0?'positive':'zero'):'incomplete'};
 for(const key of ['revenue','credit','totalReceipts','purchase','supplierShipping','shipping','fees','other','totalCosts'])out[key]=Number.isFinite(result?.[key])?result[key]:null;
 out.profit=complete?result.profit:null;out.margin=complete&&Number.isFinite(result.marginTotalReceipts)?result.marginTotalReceipts:null;
 out.markup=complete&&Number.isFinite(result.markup)?result.markup:null;
 return {...out,shippingSource:result?.shippingSource||null,issues:result?.issues||[],...extra};
}

export function temuMarginScenario(result,job,now=Date.now()){
 const purchased=!!job?.result?.packageInfoResultList?.length;
 if(!purchased&&!job?.plan)return marginScenario(null,{basis:'unavailable',stale:false,issues:['Devis ou coût d’étiquette TEMU absent']});
 const expiresAt=Number(job?.plan?.expiresAt);
 return marginScenario(result,{basis:purchased?'label':'quote',stale:!purchased&&(!Number.isFinite(expiresAt)||expiresAt<=now),expiresAt:!purchased&&Number.isFinite(expiresAt)?expiresAt:null});
}
