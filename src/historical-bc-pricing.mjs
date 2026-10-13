import {usesRecordedBc,recordedBcPricing} from './existing-bc-execution.mjs';
import {verifyBcLineIdentity,verifySourceCommercialTotals} from './bc-pricing.mjs';
// Historical BCs are the existing commercial document. Rebuilding a unit-price
// allocation is not an authority to change it when current seller totals agree.
export async function readPreservedHistoricalBc(api,o,source){
 if(o.channel!=='temu'||o.erp_live?.phase!=='historical_review'||!o.erp_live.bc?.id)return null;
 const {Order:bc}=await api.request('query V3PreservedHistoricalBC($id:ID!){Order(id:$id){id label status external_reference update_stock tax_type total currency{label} line_items{type quantity price tax_amount discount discount_rule_amount ecotax tax_codes{id} variant{id sku} location{id}}}}',{id:String(o.erp_live.bc.id)});
 if(String(bc?.id)!==String(o.erp_live.bc.id)||bc.status!=='active'||bc.external_reference!==o.reference||typeof bc.update_stock!=='boolean')throw Error('BC historique · Identité, état actif ou politique de stock non confirmés');
 if(usesRecordedBc(o))return {bc,confirmed:recordedBcPricing(o,bc).confirmed,preserved:true,authority:'recorded_bc'};
 if(!['exclusive','inclusive'].includes(bc.tax_type)||bc.tax_type!==o.pricing.tax_type)throw Error('BC historique · Base fiscale différente de la source');
 const confirmed=verifySourceCommercialTotals(bc,source);
 const zero=(l,k)=>Object.hasOwn(l,k)&&(l[k]===null||l[k]!==''&&Number.isFinite(Number(l[k]))&&Number(l[k])===0);
 const neutral=l=>l.type==='shipping_cost'&&Number(l.quantity)===1&&zero(l,'price')&&zero(l,'tax_amount')&&['discount','discount_rule_amount','ecotax'].every(k=>zero(l,k));
 const compared=o.pricing.items.some(l=>l.type==='shipping_cost')?bc.line_items:bc.line_items.filter(l=>!neutral(l));
 verifyBcLineIdentity(compared,o.pricing.items);
 for(const l of bc.line_items)for(const k of ['price','discount','discount_rule_amount','ecotax'])if(!Object.hasOwn(l,k)||k==='price'&&l[k]===null||l[k]!==null&&(l[k]===''||!Number.isFinite(Number(l[k]))||Number(l[k])<0))throw Error('BC historique · Prix, remises ou écotaxes non reçus');
 return {bc,confirmed,preserved:true};
}
