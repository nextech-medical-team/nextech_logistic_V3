import test from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument,PDFName,PDFArray,PDFRawStream,decodePDFRawStream} from 'pdf-lib';
import {skuTextBlocks,replaceSkuText} from '../src/label-sku-copy.mjs';

// Resource numbering matches GLS templates where F1 is bold and F2 regular.
async function fixture({name='F2',face='NotoSansDisplayCondensed-Regular',literal=false}={}){
 const doc=await PDFDocument.create(),page=doc.addPage([283.465,425.197]);
 const cmap=doc.context.register(doc.context.flateStream(Buffer.from('1 beginbfrange\n<0000> <007f> <0000>\nendbfrange')));
 const font=type=>doc.context.register(doc.context.obj({Type:'Font',Subtype:'Type0',BaseFont:type,ToUnicode:cmap}));
 page.node.setFontDictionary(PDFName.of('F1'),font('NotoSansDisplayCondensed-Bold'));
 page.node.setFontDictionary(PDFName.of(name),font(face));
 const encode=value=>{const bytes=Buffer.from([...value].flatMap(c=>[0,c.charCodeAt(0)]));return literal?'('+bytes.toString('latin1').replace(/[\\()]/g,'\\$&')+')':'<'+bytes.toString('hex')+'>';};
 const text=`q\n1 0 0 1 0 51.02361 cm\n/${name} 8 Tf\nBT\n70.86614 -22.17323 Td\n${encode('712144 (72 pcs) 1000018225 (100 pcs)')} Tj\nET\nBT\n70.86614 -30.67717 Td\n${encode('17 800 50 (100 pcs)')} Tj\nET\nBT\n70.86614 -13.66929 Td\n${encode('CONTACT (72 pcs)')} Tj\nET\nQ`;
 page.node.set(PDFName.of('Contents'),doc.context.register(doc.context.flateStream(Buffer.from(text,'latin1'))));
 return Buffer.from(await doc.save());
}
for(const name of ['F1','F2','GLSRegular'])for(const literal of [false,true])test(`GLS ${name} ${literal?'literal':'hex'} : discover and edit SKU units only`,async()=>{
 const original=await fixture({name,literal});
 assert.deepEqual((await skuTextBlocks(original,'gls')).blocks.map(b=>b.value),['712144 (72 pcs) 1000018225 (100 pcs)','17 800 50 (100 pcs)']);
 const edited=await replaceSkuText(original,'gls',[{from:'712144',to:'712144',units:48}]);
 assert.equal(edited.changes.length,1);
 assert.deepEqual((await skuTextBlocks(edited.pdf,'gls')).blocks.map(b=>b.value),['712144 (48 pcs) 1000018225 (100 pcs)','17 800 50 (100 pcs)']);
 // An already edited Helvetica annotation remains editable, including another row.
 const second=await replaceSkuText(edited.pdf,'gls',[{from:'712144',to:'712144',units:24},{from:'17 800 50',to:'OTHER',units:50}]);
 assert.deepEqual((await skuTextBlocks(second.pdf,'gls')).blocks.map(b=>b.value),['712144 (24 pcs) 1000018225 (100 pcs)','OTHER (50 pcs)']);
 const a=await PDFDocument.load(original),b=await PDFDocument.load(edited.pdf);
 const stream=d=>{const refs=d.getPage(0).node.Contents();return (refs instanceof PDFArray?refs.asArray():[refs]).map(r=>d.context.lookup(r)).filter(s=>s instanceof PDFRawStream).map(s=>Buffer.from(decodePDFRawStream(s).decode()).toString('latin1')).join('\n');};
 const before=stream(a),after=stream(b),contact=t=>t.slice(t.lastIndexOf('BT'),t.lastIndexOf('ET')+2);
 assert.equal(contact(after),contact(before));
});
test('unknown GLS font is never guessed from another resource',async()=>{
 const bytes=await fixture({face:'OtherFont'});assert.equal((await skuTextBlocks(bytes,'gls')).blocks.length,0);
 await assert.rejects(replaceSkuText(bytes,'gls',[{from:'712144',to:'712144',units:48}]),/introuvable/);
});
