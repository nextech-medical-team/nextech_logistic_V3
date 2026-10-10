import {savedSkuCopy} from './label-sku-copy.mjs';
import {PDFDocument,StandardFonts,PDFName,PDFNumber,rgb} from 'pdf-lib';

const positive=value=>Number.isFinite(Number(value))&&Number(value)>0;
const round=value=>Math.round(value*1e6)/1e6;
const quantity=value=>new Intl.NumberFormat('fr-FR',{maximumFractionDigits:6,useGrouping:false}).format(value);

// A package quantity is expressed in TEMU units. Convert it using the same
// prepared line (or shared mapping) that supplies the Erplain SKU.
export function assertWholeTemuPackage(order,originals,result,packageSn){
 const parcels=(result?.packageInfoResultList||[]).filter(p=>(p.orderSendInfoList||[]).some(a=>a.parentOrderSn===order.reference));
 if(parcels.length!==1||parcels[0].packageSn!==packageSn)throw Error('Remplacement TEMU : répartition sur plusieurs colis à vérifier avant modification');
 const allocations=parcels[0].orderSendInfoList.filter(a=>a.parentOrderSn===order.reference);
 if(allocations.length!==originals.length||originals.some(l=>allocations.filter(a=>a.orderSn===l.source_line&&Number(a.quantity)===Number(l.quantity)).length!==1))throw Error('Remplacement TEMU : contenu du colis incomplet ou différent de la commande');
}
export function temuPreparationLines(order,lines,result,packageSn){
 if(order?.erp_live?.equivalentOriginalLines){
  assertWholeTemuPackage(order,order.erp_live.equivalentOriginalLines,result,packageSn);
  const items=new Map();for(const l of lines){if(!l.target_sku||!positive(l.target_quantity))throw Error('SKU et quantité équivalents à vérifier');items.set(l.target_sku,(items.get(l.target_sku)||0)+Number(l.target_quantity));}
  if(!items.size)throw Error('Articles équivalents absents');
  return {reference:order.reference,scope:'colis',items:[...items].map(([sku,quantity])=>({sku,quantity:round(quantity),source:'erplain',warning:null}))};
 }

 if(!order||order.channel!=='temu')throw Error('Commande TEMU introuvable pour compléter le PDF');
 if(!lines?.length)throw Error('Articles de la commande TEMU absents');
 const parcels=result?.packageInfoResultList||[];
 const matches=parcels.filter(p=>p.packageSn===packageSn);
 if(matches.length>1)throw Error('Colis TEMU ambigu');
 const allocation=matches[0]?.orderSendInfoList;
 const quantities=new Map();
 if(allocation?.length){
  if(!allocation.some(a=>a.parentOrderSn===order.reference))throw Error('Articles du colis TEMU incohérents');
  for(const a of allocation.filter(a=>a.parentOrderSn===order.reference)){
   if(a.parentOrderSn!==order.reference||!a.orderSn||!positive(a.quantity)||quantities.has(a.orderSn))throw Error('Articles du colis TEMU incohérents');
   quantities.set(a.orderSn,Number(a.quantity));
  }
  if([...quantities.keys()].some(id=>!lines.some(l=>l.source_line===id)))throw Error('Article du colis TEMU absent de la commande');
 }
 const items=new Map();
 for(const line of lines){
  if(quantities.size&&!quantities.has(line.source_line))continue;
  const sourceQty=Number(line.quantity),selectedQty=quantities.size?quantities.get(line.source_line):sourceQty;
  if(!positive(sourceQty)||!positive(selectedQty)||selectedQty>sourceQty)throw Error('Quantité du colis TEMU incompatible avec la commande');
  const sku=String(line.target_sku||line.mapped_sku||'').trim();
  let converted;
  if(sku&&line.target_sku&&positive(line.target_quantity))converted=Number(line.target_quantity)*selectedQty/sourceQty;
  else if(sku&&sku===line.mapped_sku&&positive(line.source_qty)&&positive(line.target_qty))converted=selectedQty*Number(line.target_qty)/Number(line.source_qty);
  const mapped=sku&&positive(converted);
  const key=mapped?'erplain:'+sku:'temu:'+line.source_sku;
  if(!items.has(key))items.set(key,{sku:mapped?sku:String(line.source_sku),quantity:0,source:mapped?'erplain':'temu',warning:mapped?null:sku?'Quantité Erplain à vérifier':'Mapping manquant'});
  const item=items.get(key);item.quantity=round(item.quantity+(mapped?converted:selectedQty));
 }
 if(!items.size)throw Error('Aucun article à imprimer pour ce colis TEMU');
 return {reference:order.reference,scope:quantities.size?'colis':'commande',items:[...items.values()]};
}

function wrap(text,font,size,width){
 const rows=[];let line='';
 for(const word of String(text).replace(/[\r\n\t]+/g,' ').split(' ').filter(Boolean)){
  const joined=line?line+' '+word:word;
  if(font.widthOfTextAtSize(joined,size)<=width){line=joined;continue;}
  if(line){rows.push(line);line='';}
  if(font.widthOfTextAtSize(word,size)<=width){line=word;continue;}
  for(const char of word){if(font.widthOfTextAtSize(line+char,size)>width){rows.push(line);line='';}line+=char;}
 }
 if(line)rows.push(line);return rows;
}

export async function addTemuPreparationFooter(bytes,details){
 const source=await PDFDocument.load(bytes);
 if(!source.getPageCount())throw Error('PDF TEMU sans page');
 // Keep form appearances, if a carrier uses PDF form fields in its label.
 const form=source.getForm();if(form.getFields().length)form.flatten();
 const output=await PDFDocument.create();
 const regular=await output.embedFont(StandardFonts.Helvetica),bold=await output.embedFont(StandardFonts.HelveticaBold);
 const margin=9,size=9.5,leading=12;
 for(const original of source.getPages()){
  const media=original.getMediaBox(),crop=original.getCropBox();
  const box={left:Math.max(media.x,crop.x),bottom:Math.max(media.y,crop.y),right:Math.min(media.x+media.width,crop.x+crop.width),top:Math.min(media.y+media.height,crop.y+crop.height)};
  const unit=original.node.lookupMaybe(PDFName.of('UserUnit'),PDFNumber)?.asNumber()??1;
  const angle=((original.getRotation().angle%360)+360)%360;
  if(![0,90,180,270].includes(angle)||!positive(unit)||unit>75000)throw Error('Orientation ou échelle du PDF TEMU invalide');
  const w=(box.right-box.left)*unit,h=(box.top-box.bottom)*unit;
  const width=angle%180?h:w,labelHeight=angle%180?w:h;
  if(width<72||labelHeight<=0)throw Error('Format du PDF TEMU trop petit ou invalide');
  const contentWidth=width-2*margin;
  const heading=(details.items.every(i=>i.source==='erplain')?'SKU Erplain':'Articles de préparation')+' - '+details.scope;
  const header=wrap(heading+' · '+details.reference,regular,7.5,contentWidth);
  const rows=[];
  for(const item of details.items){
   const text=(item.source==='temu'?'SKU TEMU ':'')+item.sku+' ('+quantity(item.quantity)+')';
   rows.push(...wrap(text,bold,size,contentWidth).map(text=>({text,font:bold,size,leading})));
   if(item.warning)rows.push(...wrap(item.warning,regular,7.5,contentWidth).map(text=>({text,font:regular,size:7.5,leading:10})));
  }
  const footerHeight=round(2*margin+header.length*10+4+rows.reduce((n,r)=>n+r.leading,0));
  if(labelHeight+footerHeight>14400)throw Error('Liste des articles trop longue pour ce format PDF');
  const page=output.addPage([width,labelHeight+footerHeight]);
  // Exact quarter-turn matrices avoid floating-point rotations that can alter
  // barcode edge rasterization. The carrier artwork stays vector at 100%.
  const {left,bottom,right,top}=box;
  const matrix=angle===0?[1,0,0,1,-left,-bottom]:angle===90?[0,-1,1,0,-bottom,right]:angle===180?[-1,0,0,-1,right,top]:[0,1,-1,0,top,-left];
  const embedded=await output.embedPage(original,box,matrix);
  page.drawPage(embedded,{x:0,y:footerHeight,xScale:unit,yScale:unit});
  page.drawLine({start:{x:margin,y:footerHeight-3},end:{x:width-margin,y:footerHeight-3},thickness:0.5,color:rgb(0.45,0.45,0.45)});
  let y=footerHeight-margin-7.5;
  for(const text of header){page.drawText(text,{x:margin,y,size:7.5,font:regular});y-=10;}
  y-=4;
  for(const row of rows){page.drawText(row.text,{x:margin,y,size:row.size,font:row.font});y-=row.leading;}
 }
 output.setTitle('Étiquettes TEMU - '+details.reference+' - SKU et quantités');
 output.setProducer('NEXTECH LOGISTIC V3');
 return Buffer.from(await output.save());
}

export async function currentTemuPdf(db,bytes,reference,packageSn){
 const saved=await savedSkuCopy(db,bytes,'temu:'+reference+':'+packageSn);if(saved)return saved;
 const order=(await db.query("SELECT o.*,j.result AS label_result FROM orders o LEFT JOIN temu_label_jobs j ON j.reference=o.reference WHERE o.channel='temu' AND o.reference=$1",[reference])).rows[0];
 if(!order)throw Error('Commande TEMU introuvable pour compléter le PDF');
 const lines=(await db.query('SELECT l.*,m.target_sku AS mapped_sku,m.source_qty,m.target_qty FROM lines l LEFT JOIN mappings m ON m.channel=$2 AND m.source_sku=l.source_sku WHERE l.order_id=$1 ORDER BY l.source_line,l.id',[order.id,'temu'])).rows;
 const parcel=order.label_result?.packageInfoResultList?.find(p=>p.packageSn===packageSn),refs=[...new Set((parcel?.orderSendInfoList||[]).map(l=>l.parentOrderSn))].sort();
 if(refs.length<2)return addTemuPreparationFooter(bytes,temuPreparationLines(order,lines,order.label_result,packageSn));
 if(!refs.includes(reference))throw Error('Colis TEMU d’une autre commande');
 const grouped=(await db.query("SELECT * FROM orders WHERE channel='temu' AND reference=ANY($1::text[])",[refs])).rows;
 const groupedLines=(await db.query('SELECT l.*,m.target_sku AS mapped_sku,m.source_qty,m.target_qty FROM lines l LEFT JOIN mappings m ON m.channel=$2 AND m.source_sku=l.source_sku WHERE l.order_id=ANY($1::text[]) ORDER BY l.source_line,l.id',[grouped.map(o=>o.id),'temu'])).rows;
 for(const ref of refs.filter(ref=>!grouped.some(o=>o.reference===ref))){const remote=(order.label_result?.groupedOrderLines||[]).filter(l=>l.reference===ref);if(!remote.length)throw Error('Articles TEMU du colis groupé à actualiser : '+ref);
  const id='temu-grouped:'+ref;grouped.push({id,channel:'temu',reference:ref});const mapping=new Map((await db.query("SELECT * FROM mappings WHERE channel='temu' AND source_sku=ANY($1::text[])",[remote.map(l=>l.source_sku)])).rows.map(m=>[m.source_sku,m]));
  groupedLines.push(...remote.map(l=>{const m=mapping.get(l.source_sku);return {...l,order_id:id,mapped_sku:m?.target_sku,source_qty:m?.source_qty,target_qty:m?.target_qty};}));
 }
 return addTemuPreparationFooter(bytes,temuGroupedPreparation(grouped,groupedLines,order.label_result,packageSn));
}

export function temuGroupedPreparation(orders,lines,result,packageSn){
 const parcel=result?.packageInfoResultList?.find(p=>p.packageSn===packageSn);if(!parcel?.orderSendInfoList?.length)throw Error('Répartition du colis groupé TEMU absente');
 const refs=[...new Set(parcel.orderSendInfoList.map(l=>l.parentOrderSn))].sort(),items=new Map();
 for(const ref of refs){const order=orders.find(o=>o.reference===ref);if(!order)throw Error('Commande du colis groupé absente de V3 : '+ref);
  const details=temuPreparationLines(order,lines.filter(l=>l.order_id===order.id),result,packageSn);
  for(const item of details.items){const key=item.source+':'+item.sku;const old=items.get(key);if(old)old.quantity=round(old.quantity+item.quantity);else items.set(key,{...item});}
 }
 return {reference:refs.join(' + '),scope:'colis groupé',items:[...items.values()]};
}
