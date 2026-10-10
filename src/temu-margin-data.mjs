export function money(value){if(!value||typeof value!=='object'||value.amount===null||value.amount===undefined||String(value.amount).trim()===''||!Number.isFinite(Number(value.amount))||!/^[A-Z]{3}$/.test(value.currency||''))return null;return{amount:Number(value.amount)/100,currency:value.currency};}
export function amountFields(amounts,reference,line){
 if(amounts?.parentOrderMap?.parentOrderSn!==reference)throw Error('TEMU · Montants d’une autre commande');
 const matches=(amounts.orderList||[]).filter(x=>String(x.orderSn)===String(line.source_payload?.temuOrderSn||line.source_line));
 if(matches.length!==1)throw Error('TEMU · Montant de la ligne absent ou ambigu');
 const a=matches[0],q=Number(line.quantity);if(!(q>0)||a.quantity!=null&&Number(a.quantity)!==q)throw Error('TEMU · Quantité du montant différente de la commande');
 const total=money(a.basePrice),unit=money(a.unitBasePrice),base=total||unit&&{...unit,amount:unit.amount*q};
 if(!base||base.amount<0)throw Error('TEMU · Prix de vente absent ou invalide');
 if(total&&unit&&(total.currency!==unit.currency||Math.abs(total.amount-unit.amount*q)>0.02))throw Error('TEMU · Prix total et unitaire incohérents');
 const out={'Total du prix de base après réduction':'','Prix de base total':base.amount+' '+base.currency};
 const shipTtc=money(a.shipAmountTotalTaxIncl),shipTax=money(a.shipTaxAmount);
 if(shipTtc&&shipTax){if(shipTtc.currency!==base.currency||shipTax.currency!==base.currency||shipTax.amount>shipTtc.amount)throw Error('TEMU · Contribution livraison incohérente');out["Total de l'expédition (hors taxes)"]=(shipTtc.amount-shipTax.amount)+' '+base.currency;out["Taxe d'expédition"]=shipTax.amount+' '+base.currency;}
 if(amounts.v3CommercialBasis?.source==='temu_estimated_revenue'){out['Prix de vente (hors taxes)']=base.amount+' '+base.currency;const tax=money(a.productTaxAmount);if(tax)out['Taxe sur les produits']=tax.amount+' '+tax.currency;return out;}
 const retail=money(a.unitRetailPriceVatExcl),retailTtc=money(a.unitRetailPriceVatIncl);
 if(retail&&retail.currency===base.currency){out['Prix de vente (hors taxes)']=retail.amount*q+' '+base.currency;if(retailTtc&&retailTtc.currency===base.currency)out['Taxe sur les produits']=(retailTtc.amount-retail.amount)*q+' '+base.currency;}
 return out;
}
export async function readOrderAmounts(api,reference){let amounts;try{amounts=await api.read('bg.order.amount.query',{parentOrderSn:reference});}catch(e){if(String(e.message).includes('3000032'))throw Error('TEMU · Boutique à réautoriser dans Seller Center : accès aux montants de commande absent (3000032)');throw e;}if(amounts?.parentOrderMap?.parentOrderSn!==reference||!Array.isArray(amounts.orderList)||!amounts.orderList.length)throw Error('TEMU · Réponse montants incomplète ou incohérente');return{data:amounts,at:new Date().toISOString()};}
export function quoteCost(job,vat){
 const parcels=job?.result?.packageInfoResultList||[];
 if(!job?.plan&&!parcels.length)return null;let p=job.plan,source='Devis TEMU final';
 const refs=[...new Set(parcels.flatMap(p=>(p.orderSendInfoList||[]).map(l=>l.parentOrderSn)))];if(refs.length>1)throw Error('TEMU · Répartition du coût du colis groupé à renseigner');
 if(parcels.length){const seen=new Set();let sum=0;
  for(const parcel of parcels){if(!parcel.packageSn||seen.has(parcel.packageSn))throw Error('TEMU · Colis absent ou dupliqué dans le coût d’étiquette');seen.add(parcel.packageSn);
   const currency=parcel.estimatedCurrencyCode||parcel.currency;if(currency!=='EUR')throw Error('TEMU · Conversion du coût d’étiquette '+(currency||'sans devise')+' à renseigner');
   const text=String(parcel.estimatedAmount??parcel.amount??'').trim().replace(/(?:EUR|€)/g,'').trim();if(!/^\d+(?:[.,]\d{1,2})?$/.test(text))throw Error('TEMU · Coût TTC du colis à renseigner');sum+=Number(text.replace(',','.'));
  }p={amount:sum,currency:'EUR'};source='Coût étiquette TEMU';
 }
 if(p.amount===null||p.amount===undefined||!Number.isFinite(Number(p.amount))||Number(p.amount)<0)throw Error('TEMU · Coût TTC de l’étiquette invalide');
 if(p.currency!=='EUR')throw Error('TEMU · Conversion du coût d’étiquette '+p.currency+' à renseigner');
 if(!Number.isFinite(vat)||vat<0||vat>1)throw Error('TEMU · TVA de l’étiquette à renseigner');
 return{ttc:Number(p.amount),ht:Number(p.amount)/(1+vat),vat,currency:'EUR',source};
}
