import {PDFDocument,PDFName,PDFNumber,PDFRawStream,PDFRef,decodePDFRawStream,StandardFonts,rgb} from 'pdf-lib';

const marker='NEXTECH TEMU BL v2:',legacyMarker='NEXTECH TEMU BL v1:';
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
function footerText(page,doc){
 const streams=[],blocks=[];
 for(const ref of page.node.normalizedEntries().Contents.asArray()){
  const stream=doc.context.lookup(ref);if(!(stream instanceof PDFRawStream))continue;
  const text=Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1'),entry={ref,text};streams.push(entry);
  for(const match of text.matchAll(/BT\b[\s\S]*?\bET/g)){
   const font=/\/(Helvetica(?:-Bold)?-\d+) ([\d.]+) Tf/.exec(match[0]),position=/1 0 0 1 ([\d.-]+) ([\d.-]+) Tm/.exec(match[0]),hex=/<([a-fA-F0-9]+)>\s*Tj/.exec(match[0]);
   if(!font||!position||!hex)continue;
   blocks.push({entry,block:match[0],text:new TextDecoder('windows-1252').decode(Buffer.from(hex[1],'hex')),bold:font[1].startsWith('Helvetica-Bold-'),size:Number(font[2]),x:Number(position[1]),y:Number(position[2])});
  }
 }
 return {streams,blocks};
}
function removeFooterText(doc,streams,removed){
 for(const entry of streams){
  let text=entry.text;
  for(const block of removed.filter(b=>b.entry===entry))text=text.replace(block.block,'');
  // Only the gray separators authored by these V3 footers are removed.
  text=text.replace(/q\s+0\.45 0\.45 0\.45 RG\s+0\.5 w\s+\[\] 0 d\s+9 [\d.-]+ m\s+9 [\d.-]+ m\s+[\d.-]+ [\d.-]+ l\s+S\s+Q/g,'');
  if(text!==entry.text&&entry.ref instanceof PDFRef)doc.context.assign(entry.ref,doc.context.flateStream(Buffer.from(text,'latin1')));
 }
}
function inlineReferences(text,notes){
 const byReference=new Map();
 for(const note of notes){const numbers=byReference.get(note.reference)||[];numbers.push(note.number);byReference.set(note.reference,numbers);}
 // Match complete references once; a short reference cannot consume a longer one.
 const escaped=[...byReference.keys()].sort((a,b)=>b.length-a.length).map(r=>r.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'));
 const matched=new Set(),result=text.replace(new RegExp('('+escaped.join('|')+')(?![A-Za-z0-9-])','g'),reference=>{matched.add(reference);return reference+' | BL : '+byReference.get(reference).join(', ');});
 if(matched.size!==byReference.size)throw Error('Référence du pied d’étiquette différente du BL : rapprocher cette copie avant impression');
 return result;
}
export async function addTemuBlNumbers(bytes,notes){
 if(!notes?.length)return Buffer.from(bytes);
 const identity=marker+JSON.stringify(notes),source=await PDFDocument.load(bytes);
 if(source.getSubject()===identity)return Buffer.from(bytes);
 const legacy=source.getSubject()?.startsWith(legacyMarker);
 if(source.getSubject()?.startsWith(marker)||legacy&&source.getSubject()!==legacyMarker+JSON.stringify(notes))throw Error('BL de la copie d’étiquette différent : rapprocher cette copie avec le BL actuel avant impression');
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
 const font=await output.embedFont(StandardFonts.HelveticaBold),regular=await output.embedFont(StandardFonts.Helvetica),margin=9,size=10,leading=13;
 for(const page of output.getPages()){
  let {width,height}=page.getSize();if(width<72)throw Error('Étiquette TEMU trop étroite pour le numéro de BL');
  const {streams,blocks}=footerText(page,output);
  const first=blocks.find(b=>!b.bold&&b.size===7.5&&b.x===margin&&/^(SKU Erplain|Articles de préparation) - /.test(b.text));
  const oldRows=legacy?notes.flatMap(n=>wrap('BL : '+n.number+(notes.length>1?' - '+n.reference:''),font,size,width-2*margin)):[];
  const oldBl=legacy?blocks.filter(b=>b.bold&&b.size===size&&b.x===margin&&oldRows.some((text,i)=>b.text===text&&Math.abs(b.y-(margin+oldRows.length*leading-size-i*leading))<0.001)):[];
  if(legacy){
   if(oldBl.length!==oldRows.length)throw Error('Ancien pied BL introuvable : vérifier cette copie avant impression');
   const oldStrip=2*margin+oldRows.length*leading;height-=oldStrip;
   page.setMediaBox(0,0,width,height);page.setCropBox(0,0,width,height);page.translateContent(0,-oldStrip);
  }
  if(first){
   const headers=[first];
   for(let y=first.y-10;;y-=10){const next=blocks.find(b=>!b.bold&&b.size===7.5&&b.x===margin&&Math.abs(b.y-y)<0.001);if(!next)break;headers.push(next);}
   const items=blocks.filter(b=>b.x===margin&&b.y<headers.at(-1).y&&(b.bold&&b.size===9.5||!b.bold&&b.size===7.5));
   if(!items.length)throw Error('Articles du pied d’étiquette TEMU introuvables');
   const header=wrap(inlineReferences(headers.map(b=>b.text).join(' '),notes),regular,7.5,width-2*margin);
   const oldFooter=first.y+margin+7.5,footer=2*margin+header.length*10+4+items.reduce((n,b)=>n+(b.bold?12:10),0),delta=footer-oldFooter;
   if(height+delta>14400)throw Error('Liste des BL trop longue pour ce PDF');
   removeFooterText(output,streams,[...headers,...items,...oldBl]);
   page.setMediaBox(0,0,width,height+delta);page.setCropBox(0,0,width,height+delta);page.translateContent(0,delta);page.resetPosition();
   page.drawLine({start:{x:margin,y:footer-3},end:{x:width-margin,y:footer-3},thickness:0.5,color:rgb(0.45,0.45,0.45)});
   let y=footer-margin-7.5;
   for(const text of header){page.drawText(text,{x:margin,y,size:7.5,font:regular});y-=10;}
   y-=4;
   for(const item of items){page.drawText(item.text,{x:margin,y,size:item.size,font:item.bold?font:regular});y-=item.bold?12:10;}
   continue;
  }
  if(legacy)removeFooterText(output,streams,oldBl);
  const rows=notes.flatMap(n=>wrap(n.reference+' | BL : '+n.number,font,size,width-2*margin));
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
