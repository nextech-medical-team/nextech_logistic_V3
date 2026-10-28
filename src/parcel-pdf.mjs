import {savedSkuCopy} from './label-sku-copy.mjs';
import {PDFDocument,StandardFonts,rgb} from 'pdf-lib';
import {readableGofoPdf} from './gofo-pdf.mjs';
import {parcelRecipient,labelReferences} from './label-text.mjs';
export async function currentParcelPdf(db,bytes,orderId,index=0,extraId=null){
 const saved=await savedSkuCopy(db,bytes,extraId?'extra:'+extraId:'carrier:'+orderId+':'+index);if(saved)return saved;
 const o=(await db.query('SELECT * FROM orders WHERE id=$1',[orderId])).rows[0];if(!o)return Buffer.from(bytes);
 o.lines=(await db.query('SELECT * FROM lines WHERE order_id=$1 ORDER BY source_line',[orderId])).rows;
 const base=(await db.query('SELECT count(*)::int n FROM carrier_documents WHERE order_id=$1',[orderId])).rows[0].n;
 const extras=(await db.query("SELECT id,carrier FROM extra_parcels WHERE order_id=$1 AND delivery_id IS NULL AND status='ready' ORDER BY created_at,id",[orderId])).rows;
 const position=extraId?base+extras.findIndex(x=>x.id===extraId)+1:index+1;
 const carrier=extraId?extras.find(x=>x.id===extraId)?.carrier:o.carrier;
 return displayParcelPdf(bytes,o,carrier,position,base+extras.length);
}
export async function displayParcelPdf(bytes,o,carrier,index,total){
 if(carrier==='gofo')bytes=await readableGofoPdf(bytes,o);
 if(String(carrier).startsWith('gls')){const doc=await PDFDocument.load(bytes),font=await doc.embedFont(StandardFonts.Helvetica);for(const page of doc.getPages()){const {width,height}=page.getSize();if(Math.abs(width-283.465)>1||Math.abs(height-425.197)>1)continue;const text=labelReferences(o,40).join(' ; ');const x=70.8,y=height-415.8;page.drawRectangle({x,y,width:207,height:10,color:rgb(1,1,1)});page.drawText(text,{x,y:y+1.6,size:Math.min(7,206/Math.max(1,font.widthOfTextAtSize(text,1))),font});}bytes=Buffer.from(await doc.save());}
 if(total<=1)return Buffer.from(bytes);
 const pdf=await PDFDocument.load(bytes),font=await pdf.embedFont(StandardFonts.HelveticaBold);
 for(const p of pdf.getPages()){
  const {width,height}=p.getSize(),gofo=carrier==='gofo';
  if(Math.abs(width-(gofo?283.92:283.465))>1||Math.abs(height-(gofo?425.04:425.197))>1)throw Error('Format étiquette inconnu : numérotation à vérifier');
  const x=gofo?16.8:5.7,y=height-(gofo?180.7:157.2),text=parcelRecipient(o,index,total,gofo?60:35);
  p.drawRectangle({x,y:y-1,width:gofo?260:258,height:15,color:rgb(1,1,1)});
  p.drawText(text,{x,y:y+2,size:Math.min(10,258/Math.max(1,font.widthOfTextAtSize(text,1))),font});
  if(!gofo){const contact=parcelRecipient(o,index,total,60),regular=await pdf.embedFont(StandardFonts.Helvetica);p.drawRectangle({x:70.8,y:height-390.2,width:207,height:8.5,color:rgb(1,1,1)});p.drawText(contact,{x:70.9,y:height-390.2+1.6,size:Math.min(7,205/Math.max(1,regular.widthOfTextAtSize(contact,1))),font:regular});}
 }
 return Buffer.from(await pdf.save());
}
