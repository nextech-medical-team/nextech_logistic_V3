const carrierFields=['shipCompanyName','shippingCompanyName','carrier','carrierName','channelName','shippingServiceName'];
export function excludedTemuCarrier(offer){
 return carrierFields.some(key=>typeof offer?.[key]==='string'&&/cainiao/i.test(offer[key].normalize('NFKC').replace(/[\s_-]/g,'')));
}
export function automaticTemuMarginDecision(snapshot,reference,plan,now=Date.now()){
 const row=snapshot?.rows?.find(r=>r.reference===reference);
 const at=Date.parse(snapshot?.calculatedAt);
 const denied=reason=>({allowed:false,message:'Achat d’étiquette TEMU à confirmer',reason});
 if(!plan||plan.currency!=='EUR'||!Number.isFinite(plan.amount)||plan.amount<0||!(plan.expiresAt>now))return denied('Devis TEMU absent, expiré ou devise non prise en charge');
 const selected=plan.offers?.find(o=>o.channelId===plan.selected);
 if(!selected||selected.unavailableReason||excludedTemuCarrier(selected))return denied('Transporteur TEMU admissible à sélectionner');
 if(!Number.isFinite(at)||at>now||now-at>60000)return denied('Calcul de marge à actualiser');
 if(!row||row.status==='incomplete'||row.issues?.length)return denied(row?.issues?.join(' ; ')||'Marge inconnue');
 if(row.status!=='positive'||!Number.isFinite(row.profit)||row.profit<=0)return denied('Marge nulle ou négative');
 if(!Number.isFinite(row.shipping)||Math.abs(row.shipping-plan.amount/1.2)>0.00001||!row.shippingSource?.startsWith('Devis TEMU'))return denied('Marge non rapprochée du devis TEMU retenu');
 return {allowed:true,profit:row.profit,planId:plan.id};
}
