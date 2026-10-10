import {comparisonLines} from './bc-comparison-lines.mjs';
import {shippingProductLines} from './erplain-shipping-lines.mjs';
import {resolutionBcLines} from './resolution-bc-scope.mjs';
const identified=id=>(typeof id==='number'&&Number.isSafeInteger(id)&&id>0)||(typeof id==='string'&&/^[1-9]\d*$/.test(id));
const numeric=value=>(typeof value==='number'||typeof value==='string'&&value.trim()!=='')&&Number.isFinite(Number(value));
function quantities(lines){
 const map=new Map();
 for(const l of shippingProductLines(lines)){
  const sku=l.sku||l.variant?.sku,q=Number(l.quantity);
  if(typeof sku!=='string'||!sku.trim()||!numeric(l.quantity)||q<=0)throw Error('Ligne produit ou quantité non confirmée');
  const sum=(map.get(sku)||0)+q;
  if(!Number.isFinite(sum))throw Error('Somme des quantités produit non vérifiable');
  map.set(sku,sum);
 }
 return [...map].sort(([a],[b])=>a<b?-1:a>b?1:0);
}
export function bcComparisonDiagnostic(order,bc,lines){
 if(!identified(order.erp_live?.bc?.id)||!identified(bc?.id)||String(bc.id)!==String(order.erp_live.bc.id))throw Error('API Erplain · Identité BC différente ou non confirmée');
 if(!Array.isArray(bc.line_items)||!Array.isArray(bc.shipping_orders?.data)||bc.shipping_orders.paginatorInfo?.hasMorePages!==false)throw Error('API Erplain · BC ou liste des BL incomplète');
 if(typeof bc.status!=='string'||!bc.status.trim())throw Error('API Erplain · État BC non reçu');
 const errors=[],physical=shippingProductLines(bc.line_items),ids=new Set(),blIds=new Set();
 for(const l of physical){if(!identified(l.id)||!identified(l.variant?.id)||ids.has(String(l.id)))throw Error('API Erplain · Identité des lignes BC non confirmée');ids.add(String(l.id));}
 for(const bl of bc.shipping_orders.data){
  if(!identified(bl.id)||blIds.has(String(bl.id))||!Array.isArray(bl.line_items))throw Error('API Erplain · Identité ou lignes BL non confirmées');blIds.add(String(bl.id));
  if(typeof bl.status!=='string'||!bl.status.trim())throw Error('API Erplain · État BL non reçu');
  for(const l of shippingProductLines(bl.line_items)){
   if(!identified(l.variant?.id))throw Error('API Erplain · Identité produit BL non confirmée');
   if(!numeric(l.quantity)||Number(l.quantity)<0)throw Error('API Erplain · Quantité BL non confirmée');
   if(l.parent_id!=null&&(!identified(l.parent_id)||!physical.some(p=>String(p.id)===String(l.parent_id)&&String(p.variant.id)===String(l.variant.id))))throw Error('API Erplain · Lien BL et ligne BC non confirmé');
   if(l.parent_id==null&&physical.filter(p=>String(p.variant.id)===String(l.variant.id)).length!==1)throw Error('API Erplain · Ligne BL sans parent identifiable de manière unique');
   const parent=physical.find(p=>l.parent_id!=null?String(p.id)===String(l.parent_id):String(p.variant.id)===String(l.variant.id));
   if(typeof l.variant.sku!=='string'||!l.variant.sku.trim()||l.variant.sku!==parent.variant.sku)throw Error('API Erplain · SKU BL différent ou non confirmé par la ligne BC');
  }
 }
 if(order.erp_live?.bl?.id&&!blIds.has(String(order.erp_live.bl.id)))errors.push({code:'local_bl_missing',message:'Le BL enregistré localement ne figure plus dans ce BC : rapprochement requis'});
 let comparison=null,scope=order.source_payload?.erplainImported?'pending':order.partial_mode?'partial':'full';
 try{
  const expected=quantities(comparisonLines(lines,order.channel)),observed=quantities(order.source_payload?.erplainImported?resolutionBcLines(order,bc):physical);
  const different=expected.length!==observed.length||expected.some(([sku,q],i)=>sku!==observed[i]?.[0]||Math.abs(q-observed[i][1])>1e-6);
  comparison={scope,expected,observed,different};
  if(different)errors.push({code:'physical_difference',message:scope==='partial'?'Écart entre la commande partielle et le BC complet : vérifier le périmètre des livraisons et les unités':'Produits ou quantités V3 et BC différents : vérifier les unités, conditionnements et documents avant toute reprise'});
 }catch(e){errors.push({code:'comparison_unconfirmed',message:e.message});}
 return {readOnly:true,provider:'Erplain',message:errors.length?'BC et BL relus ; rapprochement requis, aucune reprise effectuée':'BC et BL relus ; produits et quantités concordants dans le périmètre comparé',bc,lines,comparison,errors};
}
