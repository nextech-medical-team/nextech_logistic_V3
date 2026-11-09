import {PDFDocument,PDFName,PDFNumber,StandardFonts,rgb} from 'pdf-lib';

const marker='NEXTECH TEMU BL v1:';
const clean=value=>String(value||'').replace(/[\r\n\t]+/g,' ').trim();
export function temuBlReferences(orders){
 const notes=new Map();
 for(const order of orders){
  const bl=order.bl||order.erp_live?.bl,reference=clean(order.reference),number=clean(bl?.label);
  if(!reference||!bl?.id||!number||bl.status==='unpublished')continue;
  notes.set(reference+'\0'+number,{reference,number});
 }
 return [...notes.values()].sort((a,b)=>a.reference.localeCompare(b.reference)||a.number.localeCompare(b.number));
}
function wrap(text,font,size,width){
 const rows=[];let line='';
 for(const word of text.split(' ')){
  const next=line?line+' '+word:word;
  if(font.widthOfTextAtSize(next,size)<=width){line=next;continue;}
  if(line){rows.push(line);line='';}
  for(const char of word){if(font.widthOfTextAtSize(line+char,size)>width){rows.push(line);line='';}line+=char;}
 }
 if(line)rows.push(line);return rows;
}
export async function addTemuBlNumbers(bytes,notes){
 if(!notes?.length)return Buffer.from(bytes);
 const identity=marker+JSON.stringify(notes),source=await PDFDocument.load(bytes);
 if(source.getSubject()===identity)return Buffer.from(bytes);
 if(source.getSubject()?.startsWith(marker))throw Error('BL de la copie d’étiquette différent : rapprocher cette copie avec le BL actuel avant impression');
 if(!source.getPageCount())throw Error('Étiquette TEMU sans page');
 const form=source.getForm();if(form.getFields().length)form.flatten();
 // Prepared labels and SKU editions are already normalized. Keep their text
 // streams editable, rather than hiding SKU text inside another PDF XObject.
 const normal=source.getPages().every(p=>{
  const media=p.getMediaBox(),crop=p.getCropBox(),unit=p.node.lookupMaybe(PDFName.of('UserUnit'),PDFNumber)?.asNumber()??1;
  return p.getRotation().angle===0&&unit===1&&media.x===0&&media.y===0&&crop.x===0&&crop.y===0&&crop.width===media.width&&crop.height===media.height;
 });
 let output=source;
 if(!normal){
  output=await PDFDocument.create();
  for(const original of source.getPages()){
   const media=original.getMediaBox(),crop=original.getCropBox(),unit=original.node.lookupMaybe(PDFName.of('UserUnit'),PDFNumber)?.asNumber()??1;
   const left=Math.max(media.x,crop.x),bottom=Math.max(media.y,crop.y),right=Math.min(media.x+media.width,crop.x+crop.width),top=Math.min(media.y+media.height,crop.y+crop.height),angle=((original.getRotation().angle%360)+360)%360;
   if(![0,90,180,270].includes(angle)||!Number.isFinite(unit)||unit<=0||unit>75000||right<=left||top<=bottom)throw Error('Orientation ou échelle de l’étiquette TEMU invalide');
   const w=(right-left)*unit,h=(top-bottom)*unit,page=output.addPage(angle%180?[h,w]:[w,h]);
   const matrix=angle===0?[1,0,0,1,-left,-bottom]:angle===90?[0,-1,1,0,-bottom,right]:angle===180?[-1,0,0,-1,right,top]:[0,1,-1,0,top,-left];
   page.drawPage(await output.embedPage(original,{left,bottom,right,top},matrix),{x:0,y:0,xScale:unit,yScale:unit});
  }
 }
 const font=await output.embedFont(StandardFonts.HelveticaBold),margin=9,size=10,leading=13;
 for(const page of output.getPages()){
  const {width,height}=page.getSize();if(width<72)throw Error('Étiquette TEMU trop étroite pour le numéro de BL');
  const rows=notes.flatMap(n=>wrap('BL : '+n.number+(notes.length>1?' - '+n.reference:''),font,size,width-2*margin));
  const footer=2*margin+rows.length*leading;
  if(height+footer>14400)throw Error('Liste des BL trop longue pour ce PDF');
  page.setMediaBox(0,0,width,height+footer);page.setCropBox(0,0,width,height+footer);
  page.translateContent(0,footer);
  page.resetPosition();
  page.drawLine({start:{x:margin,y:footer-2},end:{x:width-margin,y:footer-2},thickness:0.5,color:rgb(0.45,0.45,0.45)});
  let y=footer-margin-size;for(const text of rows){page.drawText(text,{x:margin,y,size,font});y-=leading;}
 }
 output.setSubject(identity);output.setProducer('NEXTECH LOGISTIC V3');
 return Buffer.from(await output.save());
}
