const present=v=>v!==null&&v!==undefined&&String(v).trim()!=='';
const cents=n=>Math.round((n+Number.EPSILON)*100);
export const monetaryPolicy='lt-0.50-eur-or-lt-5-percent-order-total';
export function acceptedMonetaryDifference(actual,source,{currency='EUR',eurExchangeRate,total}={}){
 if(!present(actual)||!present(source))return false;
 const a=Number(actual),s=Number(source);
 if(!Number.isFinite(a)||!Number.isFinite(s)||a<0||s<0)return false;
 const difference=Math.abs(cents(a)-cents(s));
 if(difference===0)return true;
 const reference=total===undefined?s:Number(total);
 if(Number.isFinite(reference)&&reference>0&&difference*100<cents(reference)*5)return true;
 const rate=currency==='EUR'?1:Number(eurExchangeRate);
 // The legacy eurExchangeRate field retains Erplain's quote: foreign units
 // per EUR. Divide the foreign difference to apply the EUR half-unit limit.
 return Number.isFinite(rate)&&rate>0&&difference/rate<50-1e-9;
}
