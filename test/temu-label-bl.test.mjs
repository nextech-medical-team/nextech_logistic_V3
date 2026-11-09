import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {PDFDocument,PDFRawStream,decodePDFRawStream,degrees,StandardFonts} from 'pdf-lib';
import {addTemuBlNumbers,temuBlReferences} from '../src/temu-label-bl.mjs';
import {currentTemuPdf,addTemuPreparationFooter} from '../src/temu-label-pdf.mjs';
import {currentPartialSkuPdf,initializeSkuCopies,skuContextHash,digest,skuTextBlocks,replaceSkuText} from '../src/label-sku-copy.mjs';

async function label({rotate=0}={}){
 const doc=await PDFDocument.create(),page=doc.addPage([283,425]);
 page.drawText('CARRIER TRACK 123456',{x:18,y:350,size:12});
 for(let i=0;i<60;i++)if(i%3)page.drawRectangle({x:18+i*3,y:250,width:2,height:60});
 if(rotate)page.setRotation(degrees(rotate));
 return Buffer.from(await doc.save());
}
async function texts(bytes){
 const doc=await PDFDocument.load(bytes),found=[];
 for(const page of doc.getPages())for(const ref of page.node.normalizedEntries().Contents.asArray()){
  const stream=doc.context.lookup(ref);if(!(stream instanceof PDFRawStream))continue;
  const text=Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1');
  for(const m of text.matchAll(/<([a-fA-F0-9]+)>\s*Tj/g))found.push(Buffer.from(m[1],'hex').toString('latin1'));
 }
 return found;
}
test('BL references require a recorded document and retain each grouped order identity',()=>{
 const notes=temuBlReferences([{reference:'PO-069-2',erp_live:{bl:{id:'2',label:'SHO00000002'}}},{reference:'PO-069-1',erp_live:{bl:{id:'1',label:'SHO00000001'}}},{reference:'PO-069-1',erp_live:{bl:{id:'1',label:'SHO00000001'}}},{reference:'PO-069-3',erp_live:{bl:{label:'UNCONFIRMED'}}},{reference:'PO-069-4',erp_live:{bl:{id:'4',label:'DRAFT',status:'unpublished'}}}]);
 assert.deepEqual(notes,[{reference:'PO-069-1',number:'SHO00000001'},{reference:'PO-069-2',number:'SHO00000002'}]);
});
test('BL strip extends the page without scaling the carrier label and is idempotent',async()=>{
 const raw=await label(),notes=[{reference:'PO-069-1',number:'SHO00747728'}],out=await addTemuBlNumbers(raw,notes),doc=await PDFDocument.load(out);
 assert.deepEqual(doc.getPage(0).getSize(),{width:283,height:456});
 assert((await texts(out)).includes('CARRIER TRACK 123456'));
 assert((await texts(out)).some(x=>x.includes('BL : SHO00747728')));
 assert.deepEqual(await addTemuBlNumbers(out,notes),out);
 assert.deepEqual(await addTemuBlNumbers(raw,[]),raw);
 await assert.rejects(()=>addTemuBlNumbers(out,[{reference:'PO-069-1',number:'SHO99999999'}]),/BL.*différent/);
});
test('rotated carrier labels are normalized without shrinking their visible dimensions',async()=>{
 const out=await addTemuBlNumbers(await label({rotate:90}),[{reference:'PO-069-1',number:'SHO00747728'}]),doc=await PDFDocument.load(out);
 assert.deepEqual(doc.getPage(0).getSize(),{width:425,height:314});assert.equal(doc.getPage(0).getRotation().angle,0);
 assert((await texts(out)).some(x=>x.includes('BL : SHO00747728')));
});
test('prepared labels place the BL after the reference, above editable SKU quantities',async()=>{
 const reference='PO-069-13440077845112163',notes=[{reference,number:'SHO00747787'}];
 const raw=await addTemuPreparationFooter(await label(),{reference,scope:'colis',items:[{sku:'491930',quantity:250,source:'erplain',warning:'Quantité à vérifier'}]});
 const out=await addTemuBlNumbers(raw,notes),text=await texts(out);
 assert(text.join(' ').includes(reference+' | BL : SHO00747787'));
 assert.equal(text.filter(x=>x.includes('SHO00747787')).length,1);
 assert(!text.includes('BL : SHO00747787'));
 assert(text.indexOf('491930 (250)')>text.findIndex(x=>x.includes('SHO00747787')));
 assert((await skuTextBlocks(out,'temu')).blocks.some(b=>b.value==='491930 (250)'));
 assert.deepEqual(await addTemuBlNumbers(out,notes),out);
 const edited=await replaceSkuText(out,'temu',[{from:'491930',to:'NEW-SKU',units:250}]);
 assert((await texts(edited.pdf)).includes('NEW-SKU (250)'));
});
test('v1 copies migrate their bottom BL strip into the header without adding label height twice',async()=>{
 const reference='PO-069-13440077845112163',notes=[{reference,number:'SHO00747787'}];
 const raw=await addTemuPreparationFooter(await label(),{reference,scope:'colis',items:[{sku:'EDITED-SKU',quantity:250,source:'erplain'}]});
 const legacy=await PDFDocument.load(raw),page=legacy.getPage(0),{width,height}=page.getSize(),font=await legacy.embedFont(StandardFonts.HelveticaBold);
 page.setMediaBox(0,0,width,height+31);page.setCropBox(0,0,width,height+31);page.translateContent(0,31);page.resetPosition();
 page.drawText('BL : SHO00747787',{x:9,y:12,size:10,font});legacy.setSubject('NEXTECH TEMU BL v1:'+JSON.stringify(notes));
 const out=await addTemuBlNumbers(await legacy.save(),notes),expected=await addTemuBlNumbers(raw,notes);
 assert.deepEqual((await PDFDocument.load(out)).getPage(0).getSize(),(await PDFDocument.load(expected)).getPage(0).getSize());
 assert.deepEqual(await texts(out),await texts(expected));
 assert.deepEqual(await addTemuBlNumbers(out,notes),out);
 assert((await skuTextBlocks(out,'temu')).blocks.some(b=>b.value==='EDITED-SKU (250)'));
 await assert.rejects(async()=>addTemuBlNumbers(await legacy.save(),[{reference,number:'SHO99999999'}]),/BL.*différent/);
});

test('served TEMU labels use the correct parent, grouped and partial BL while keeping saved SKU editions',async t=>{
 const e=new PGlite(),calls=[],db={query:async(q,p)=>{calls.push(q);return e.query(q,p);},exec:q=>e.exec(q)};t.after(()=>e.close());
 await e.exec(`CREATE TABLE orders(id text PRIMARY KEY,reference text,channel text,erp_live jsonb,carrier text,address jsonb,transport_choice text,parcel_count int,partial_mode boolean);
 CREATE TABLE temu_label_jobs(reference text PRIMARY KEY,result jsonb);
 CREATE TABLE lines(id text,order_id text,source_line text,source_sku text,quantity numeric,target_sku text,target_quantity numeric);
 CREATE TABLE mappings(channel text,source_sku text,target_sku text,source_qty numeric,target_qty numeric);
 CREATE TABLE carrier_jobs(order_id text,carrier text,tracking jsonb,reference text);
 CREATE TABLE carrier_documents(order_id text,document_index int);
 CREATE TABLE extra_parcels(id text,order_id text,carrier text,tracking jsonb,status text,created_at timestamptz);
 CREATE TABLE partial_deliveries(id text,order_id text,carrier text,bl jsonb,selection jsonb,tracking jsonb);`);
 await initializeSkuCopies(db);
 const ref='PO-069-1',other='PO-069-2',raw=await label();
 for(const [id,reference,bl] of [['o1',ref,'SHO00000001'],['o2',other,'SHO00000002']]){
  await e.query("INSERT INTO orders(id,reference,channel,erp_live,carrier,address) VALUES($1,$2,'temu',$3,'temu','{}')",[id,reference,JSON.stringify({bl:{id:id==='o1'?'101':'102',label:bl,status:'ready_to_ship'}})]);
  await e.query('INSERT INTO lines VALUES($1,$2,$3,$4,1,$4,50)',[id+'-line',id,id+'-item','SKU-'+id]);
 }
 const parcel={packageInfoResultList:[{packageSn:'PK-1',orderSendInfoList:[{parentOrderSn:ref,orderSn:'o1-item',quantity:1}]}]};
 await e.query('INSERT INTO temu_label_jobs VALUES($1,$2)',[ref,JSON.stringify(parcel)]);
 await t.test('normal label carries its recorded BL and SKU text stays editable',async()=>{
  calls.length=0;const out=await currentTemuPdf(db,raw,ref,'PK-1'),text=await texts(out);
  assert(text.some(x=>x.includes('PO-069-1 | BL : SHO00000001')));assert(!text.some(x=>x.includes('SHO00000002')));
  assert((await skuTextBlocks(out,'temu')).blocks.some(b=>b.value==='SKU-o1 (50)'));
  const edited=await replaceSkuText(out,'temu',[{from:'SKU-o1',to:'NEW-SKU',units:50}]);
  assert((await texts(edited.pdf)).some(x=>x.includes('NEW-SKU')));
  assert(calls.every(q=>/^SELECT/.test(q)));
 });
 await t.test('legacy saved SKU notes are preserved and get the BL once',async()=>{
  const legacy=await addTemuPreparationFooter(raw,{reference:ref,scope:'colis',items:[{sku:'MANUAL-SKU',quantity:50,source:'erplain'}]});
  const context=await skuContextHash(db,'o1');
  await e.query("INSERT INTO label_sku_copies(id,document_key,order_id,source_hash,context_hash,before_pdf,pdf,replacements,user_email) VALUES('copy',$1,'o1',$2,$3,$4,$5,'[]','test@example.invalid')",['temu:'+ref+':PK-1',digest(raw),context,raw,legacy]);
  const served=await currentTemuPdf(db,raw,ref,'PK-1');assert((await texts(served)).includes('MANUAL-SKU (50)'));assert((await texts(served)).some(x=>x.includes('PO-069-1 | BL : SHO00000001')));
  await e.query("UPDATE label_sku_copies SET pdf=$1 WHERE id='copy'",[served]);assert.deepEqual(await currentTemuPdf(db,raw,ref,'PK-1'),served);
  await e.exec('DELETE FROM label_sku_copies');
 });
 await t.test('shared parcel prints both BL numbers with their matching references',async()=>{
  await e.query('UPDATE temu_label_jobs SET result=$2 WHERE reference=$1',[ref,JSON.stringify({packageInfoResultList:[{...parcel.packageInfoResultList[0],orderSendInfoList:[...parcel.packageInfoResultList[0].orderSendInfoList,{parentOrderSn:other,orderSn:'o2-item',quantity:1}]}]})]);
  const text=await texts(await currentTemuPdf(db,raw,ref,'PK-1'));
  assert(text.join(' ').includes(ref+' | BL : SHO00000001'));assert(text.join(' ').includes(other+' | BL : SHO00000002'));
 });
 await t.test('partial label uses its own BL and other carrier circuits remain unchanged',async()=>{
  await e.query("INSERT INTO partial_deliveries(id,order_id,carrier,bl) VALUES('partial','o1','temu',$1)",[JSON.stringify({id:'999',label:'SHO00000999',status:'ready_to_ship'})]);
  const text=await texts(await currentPartialSkuPdf(db,raw,'partial',0));assert(text.some(x=>x.includes(ref+' | BL : SHO00000999')));assert(!text.some(x=>x.includes('SHO00000001')));
  await e.query("UPDATE partial_deliveries SET carrier='gls' WHERE id='partial'");assert.deepEqual(await currentPartialSkuPdf(db,raw,'partial',0),raw);
 });
});
