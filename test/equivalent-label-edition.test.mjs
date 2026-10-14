import test from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument,StandardFonts,PDFRawStream,decodePDFRawStream} from 'pdf-lib';
import {addTemuPreparationFooter} from '../src/temu-label-pdf.mjs';
import {renderEquivalentSkuEdition,equivalentSkuEdition,savedSkuCopy,digest,skuTextBlocks} from '../src/label-sku-copy.mjs';
const substitution=(from='IP26425',to='991067',oldQty=1,newQty=1)=>({originalSku:from,replacementSku:to,replaceQuantity:oldQty,replacementQuantity:newQty});
async function source(){const d=await PDFDocument.create(),p=d.addPage([283,425]),f=await d.embedFont(StandardFonts.Helvetica);p.drawText('TRACKING GFFR26282123772796',{x:20,y:200,font:f,size:10});return Buffer.from(await d.save());}
async function label(sku='IP26425',quantity=1){return addTemuPreparationFooter(await source(),{reference:'PO-069-08009686339191507',scope:'colis',items:[{sku,quantity,source:'erplain'}]});}
async function mentions(pdf){return (await skuTextBlocks(pdf,'temu')).blocks.map(b=>b.value);}
function streams(doc){return doc.context.enumerateIndirectObjects().filter(([,v])=>v instanceof PDFRawStream).map(([,v])=>Buffer.from(decodePDFRawStream(v).decode()).toString('latin1'));}
test('commande signalée : même artwork, dimensions et suivi, édition 991067 (1)',async()=>{
 const before=await label(),after=await renderEquivalentSkuEdition(before,'temu',[substitution()]);
 assert.deepEqual(await mentions(after),['991067 (1)']);
 const a=await PDFDocument.load(before),b=await PDFDocument.load(after);
 assert.deepEqual(b.getPages().map(p=>p.getSize()),a.getPages().map(p=>p.getSize()));
 const changed=streams(a).filter(s=>!streams(b).includes(s));
 assert.equal(changed.length,1);assert.ok(changed[0].includes('BT'));
 const carrier=streams(a).find(s=>s.includes(Buffer.from('TRACKING GFFR26282123772796').toString('hex').toUpperCase()));
 assert.ok(carrier);assert.ok(streams(b).includes(carrier));
 assert.deepEqual(await mentions(before),['IP26425 (1)']);
});
test('quantités proportionnelles par colis et remplacements successifs',async()=>{
 const pdf=await label('A',2),out=await renderEquivalentSkuEdition(pdf,'temu',[substitution('A','B',4,20),substitution('B','C',20,6)]);
 assert.deepEqual(await mentions(out),['C (3)']);
});
test('un SKU long tient dans la même zone, sans refus d’édition',async()=>{
 const to='NEXTECH-LONG-SKU-'.repeat(5);const out=await renderEquivalentSkuEdition(await label(),'temu',[substitution('IP26425',to)]);
 const {blocks}=await skuTextBlocks(out,'temu');assert.equal(blocks[0].value,to+' (1)');assert.ok(blocks[0].size<9.5);
});
test('caractères spéciaux dans le SKU et décimales de quantité',async()=>{
 const out=await renderEquivalentSkuEdition(await label('A+B.[1]',2),'temu',[substitution('A+B.[1]','B',4,3)]);
 assert.deepEqual(await mentions(out),['B (1,5)']);
});
test('aucun bloc SKU correspondant : PDF inchangé et disponible',async()=>{
 const pdf=await label();assert.deepEqual(await renderEquivalentSkuEdition(pdf,'temu',[substitution('ABSENT','B')]),pdf);
});
test('le téléchargement utilise les équivalences enregistrées, aucune écriture ni API externe',async()=>{
 const pdf=await label(),raw=await source(),queries=[];
 const db={query:async(sql,args)=>{queries.push(sql);assert.ok(sql.startsWith('SELECT'));
  if(sql.includes('label_sku_copies'))return {rows:[{pdf,source_hash:digest(raw),order_id:'O',created_at:'2026-10-12'}]};
  if(sql.includes('FROM audit'))return {rows:[{detail:substitution()}]};
  if(sql.includes('FROM orders'))return {rows:[{id:'O',carrier:'temu',partial_mode:false}]};throw Error(sql);
 }};
 assert.deepEqual(await mentions(await savedSkuCopy(db,raw,'temu:REF:PK')),['991067 (1)']);assert.equal(queries.length,3);
});
test('une erreur d’édition ne bloque pas la sortie du PDF existant',async()=>{
 const pdf=await label();assert.deepEqual(await equivalentSkuEdition({query:async()=>{throw Error('indisponible');}},{pdf,order_id:'O'},'temu:REF:PK'),pdf);
});
test('un remplacement du reliquat préserve les mentions des livraisons déjà créées',async()=>{
 const pdf=await label(),db={query:async()=>({rows:[{id:'O',partial_mode:true}]})};
 assert.deepEqual(await equivalentSkuEdition(db,{pdf,order_id:'O'},'carrier:O:0'),pdf);
});
test('une mention agrégée conserve les unités non remplacées',async()=>{
 const out=await renderEquivalentSkuEdition(await label('A',5),'temu',[substitution('A','B',2,6)]);
 assert.deepEqual(await mentions(out),['A (3) ; B (6)']);
});
test('GOFO : seuls les SKU dans la zone V3 changent, préfixe de service conservé',async()=>{
 const doc=await PDFDocument.create(),page=doc.addPage([283.92,425.04]),font=await doc.embedFont(StandardFonts.Helvetica);
 page.drawText('Prime 14/10/2026 IP26425 (1 pcs)',{x:93,y:64,font,size:7});page.drawText('IP26425 (1 pcs)',{x:10,y:200,font,size:7});
 const original=Buffer.from(await doc.save()),after=await renderEquivalentSkuEdition(original,'gofo',[substitution()]);
 assert.equal((await skuTextBlocks(after,'gofo')).blocks[0].value,'Prime 14/10/2026 991067 (1 pcs)');
 const a=await PDFDocument.load(original),b=await PDFDocument.load(after),changes=streams(a).filter(s=>!streams(b).includes(s));assert.equal(changes.length,1);
 const uneditable=Buffer.from('IP26425 (1 pcs)').toString('hex').toUpperCase();assert.ok(streams(b).some(s=>s.includes(uneditable)));
});
