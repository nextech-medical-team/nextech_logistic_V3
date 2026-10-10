import {temuCommercialSource} from './temu-commercial-source.mjs';
import {temuCountryAmounts} from './temu-country-vat.mjs';
import {createHash} from 'node:crypto';

// A current source proof is separate from evidence of what Erplain contained
// before an old failed request. It authorizes no mutation and is not a claim
// that the old shipping charge was preserved. A new UI preview is required.
export function proveLegacyCurrentSource({order,rows,failed,preview,bc}){
 const fail=reason=>{throw Error('Rapprochement du remplacement : '+reason);};
 const req=failed?.payload,plan=preview?.result;
 const same=(a,b)=>a&&b&&['scope','sku','replacementSku'].every(k=>a[k]===b[k])&&['replaceQuantity','replacementQuantity'].every(k=>Number(a[k])===Number(b[k]));
 if(failed?.status!=='review'||failed.error!=='Frais de livraison modifiés : rapprochement requis'||req?.confirmEquivalent!==true||req.scope!=='order'||preview?.status!=='complete'||!same(req,preview.payload)||plan?.previewFingerprint!==req.previewFingerprint||plan?.commercialBefore)fail('preuve historique non applicable');
 if(req.id!==order.id||!same(req,{scope:req.scope,sku:plan.originalSku,replacementSku:plan.replacementSku,replaceQuantity:plan.replaceQuantity,replacementQuantity:plan.replacementQuantity}))fail('demande ou aperçu d’une autre commande');
 if(order.archived||order.partial_mode||order.erp_live?.bl?.id||order.erp_live?.stockDocument||order.source_payload?.marketplacePendingCorrection||order.source_payload?.erplainImported||['shipped','delivered','in_transit','delivered_simulated'].includes(order.tracking_status))fail('commande déjà livrée, fractionnée ou modifiée');
 if(String(bc?.id)!==String(plan.bcId)||String(bc?.id)!==String(order.erp_live?.bc?.id)||bc.status!=='active'||bc.update_stock!==false||bc.tax_type!=='exclusive'||bc.shipping_orders?.paginatorInfo?.hasMorePages!==false||!Array.isArray(bc.shipping_orders.data)||bc.shipping_orders.data.length)fail('identité ou état du BC non vérifié');
 // Multi-source, split and historical-stock cases retain their stricter
// recorded-snapshot reconciliation; never guess their price allocation here.
 if(!Array.isArray(rows)||rows.length!==1||!Array.isArray(plan.expected)||plan.expected.length!==1||plan.remaining!==0)fail('ventilation de plusieurs lignes à rapprocher');
 const row=rows[0],expected=plan.expected[0];
 if((row.target_sku||row.source_sku)!==req.sku||expected.sku!==req.replacementSku||Number(expected.quantity)!==Number(req.replacementQuantity)||Number(row.target_quantity??row.quantity)!==Number(req.replaceQuantity))fail('quantités source ou remplacement différentes');
 if(!Array.isArray(bc.line_items)||!Array.isArray(plan.items)||bc.line_items.length!==plan.items.length||bc.line_items.some(l=>!l?.id)||new Set(bc.line_items.map(l=>String(l.id))).size!==bc.line_items.length)fail('lignes du BC incomplètes');
 const products=bc.line_items.filter(l=>l.type==='normal'),ships=bc.line_items.filter(l=>l.type==='shipping_cost');
 if(products.length!==1||ships.length>1||products.length+ships.length!==bc.line_items.length)fail('lignes du BC non prises en charge');
 const product=products[0],target=plan.items.filter(l=>!l.id);
 if(target.length!==1||String(product.variant?.id)!==String(target[0].variant?.id)||String(product.location?.id)!==String(target[0].location?.id)||product.variant?.sku!==expected.sku||Number(product.quantity)!==Number(expected.quantity)||product.variant?.active!==true||product.variant?.product?.active!==true)fail('produit physique ou quantité différents');
 if(plan.items.filter(l=>l.id).some(l=>!ships.some(s=>String(s.id)===String(l.id)&&Number(s.quantity)===Number(l.quantity))))fail('ligne livraison différente');
 const numeric=v=>v!==null&&v!==undefined&&String(v).trim()!==''&&Number.isFinite(Number(v));
 const amount=(v,label)=>{if(!numeric(v)||Number(v)<0)fail(label+' absent ou invalide');return Number(v);};
 for(const l of bc.line_items){
  if(['discount','discount_rule_amount','ecotax'].some(k=>l[k]!=null&&(!numeric(l[k])||Number(l[k])!==0)))fail('remise ou frais additionnels à rapprocher');
  if(!Array.isArray(l.tax_codes)||l.tax_codes.length!==1||!l.tax_codes[0]?.id||!Array.isArray(l.tax_codes[0].tax_rates)||l.tax_codes[0].tax_rates.length!==1)fail('TVA de ligne incomplète');
  amount(l.price,'prix');amount(l.tax_amount,'TVA');
 }
 let source;
 if(order.channel==='amazon'){
  const r=row.source_payload||{};
  if(['itempromotiondiscount','shippromotiondiscount'].some(k=>r[k]!=null&&r[k]!==''&&(!numeric(r[k])||Number(r[k])!==0)))fail('remise Amazon à rapprocher');
  source={currency:r.currency,productGross:amount(r.itemprice,'prix Amazon'),productTax:amount(r.itemtax,'TVA Amazon'),shippingGross:amount(r.shippingprice,'livraison Amazon'),shippingTax:amount(r.shippingtax,'TVA livraison Amazon')};
 }else if(order.channel==='temu'){
  const d=temuCommercialSource(order,temuCountryAmounts(order)),l=d.orderList[0];
  if(d.orderList.length!==1||String(l.orderSn)!==String(row.source_payload?.temuOrderSn||row.source_line)||Number(l.quantity)!==Number(row.quantity))fail('ligne financière TEMU différente');
  source={currency:d.parentOrderMap.estimatedRevenue.currency,productGross:(Number(l.basePrice.amount)+Number(l.productTaxAmount.amount))/100,productTax:Number(l.productTaxAmount.amount)/100,shippingGross:Number(l.shipAmountTotalTaxIncl.amount)/100,shippingTax:Number(l.shipTaxAmount.amount)/100,productRate:Number(l.productTaxRate)/1e6,shippingRate:Number(l.shipTaxRate)/1e6};
 }else fail('source commerciale non prise en charge');
 if(!source.currency||source.currency!==bc.currency?.label)fail('devise différente');
 const cent=v=>Math.round(Number(v)*100),sameCent=(a,b)=>Math.abs(cent(a)-cent(b))<=1;
 const check=(line,gross,tax,rate)=>{
  if(!line){if(cent(gross)!==0||cent(tax)!==0)fail('livraison source absente du BC');return;}
  const net=Number(line.price)*Number(line.quantity),actualTax=Number(line.tax_amount),actualRate=amount(line.tax_codes[0].tax_rates[0].rate,'taux TVA');
  if(!sameCent(net,gross-tax)||!sameCent(actualTax,tax)||!sameCent(net+actualTax,gross)||!sameCent(net*actualRate/100,actualTax)||rate!==undefined&&actualRate!==rate)fail('montants ou taux de ligne différents de la source actuelle');
 };
 if(ships[0]&&Number(ships[0].quantity)!==1)fail('quantité livraison différente');
 check(product,source.productGross,source.productTax,source.productRate);
 check(ships[0],source.shippingGross,source.shippingTax,source.shippingRate);
 const total=amount(bc.total,'total BC'),tax=bc.line_items.reduce((n,l)=>n+Number(l.tax_amount),0);
 const computed=bc.line_items.reduce((n,l)=>n+Number(l.price)*Number(l.quantity)+Number(l.tax_amount),0);
 if(!sameCent(total,source.productGross+source.shippingGross)||!sameCent(total,computed)||!sameCent(tax,source.productTax+source.shippingTax))fail('totaux différents de la source actuelle');
 const proof={version:1,kind:'current-source-not-prior-shipping',bcId:String(bc.id),failedId:failed.id,source,actual:{total,tax,shippingNet:ships.reduce((n,l)=>n+Number(l.price)*Number(l.quantity),0)}};
 return {...proof,fingerprint:createHash('sha256').update(JSON.stringify({proof,bc,rows,request:req})).digest('hex')};
}
