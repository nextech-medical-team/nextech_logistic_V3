import {createHash,randomUUID} from 'node:crypto';
import {PDFDocument,PDFArray,PDFRef,PDFRawStream,decodePDFRawStream,PDFName,StandardFonts} from 'pdf-lib';
export const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function pdfToken(bytes){const doc=await PDFDocument.load(bytes,{updateMetadata:false});doc.setCreationDate(new Date(0));doc.setModificationDate(new Date(0));return digest(Buffer.from(await doc.save()));}
export async function currentPartialSkuPdf(db,bytes,id,index){return await savedSkuCopy(db,bytes,'partial:'+id+':'+index)||Buffer.from(bytes);}
export async function initializeSkuCopies(db){await db.exec(`CREATE TABLE IF NOT EXISTS label_sku_copies(id TEXT PRIMARY KEY,document_key TEXT NOT NULL,order_id TEXT NOT NULL,source_hash TEXT NOT NULL,context_hash TEXT NOT NULL,before_pdf BYTEA NOT NULL,pdf BYTEA NOT NULL,replacements JSONB NOT NULL,user_email TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now()); CREATE INDEX IF NOT EXISTS label_sku_copies_document ON label_sku_copies(document_key,created_at DESC);`);}
export async function skuContextHash(db,orderId){
 const r=(await db.query(`SELECT jsonb_build_object(
 'order',jsonb_build_object('reference',o.reference,'carrier',o.carrier,'transport_choice',o.transport_choice,'address',o.address,'parcel_count',o.parcel_count,'partial_mode',o.partial_mode,'bc',jsonb_build_object('id',o.erp_live->'bc'->'id','label',o.erp_live->'bc'->'label'),'bl',jsonb_build_object('id',o.erp_live->'bl'->'id','label',o.erp_live->'bl'->'label'),'equivalentOriginalLines',o.erp_live->'equivalentOriginalLines'),
 'lines',(SELECT jsonb_agg(jsonb_build_object('id',l.id,'source_line',l.source_line,'source_sku',l.source_sku,'quantity',l.quantity,'target_sku',l.target_sku,'target_quantity',l.target_quantity,'mapped_sku',m.target_sku,'source_qty',m.source_qty,'target_qty',m.target_qty) ORDER BY l.id) FROM lines l LEFT JOIN mappings m ON m.channel=o.channel AND m.source_sku=l.source_sku WHERE l.order_id=o.id),
 'carrier',(SELECT jsonb_build_object('carrier',c.carrier,'tracking',c.tracking,'reference',c.reference) FROM carrier_jobs c WHERE c.order_id=o.id),
 'temu',(SELECT j.result->'packageInfoResultList' FROM temu_label_jobs j WHERE j.reference=o.reference),
 'extras',(SELECT jsonb_agg(jsonb_build_object('id',e.id,'carrier',e.carrier,'tracking',e.tracking,'status',e.status) ORDER BY e.created_at,e.id) FROM extra_parcels e WHERE e.order_id=o.id),
 'partials',(SELECT jsonb_agg(jsonb_build_object('id',p.id,'selection',p.selection,'bl',p.bl,'carrier',p.carrier,'tracking',p.tracking) ORDER BY p.id) FROM partial_deliveries p WHERE p.order_id=o.id),
 'documents',(SELECT array_agg(d.document_index ORDER BY d.document_index) FROM carrier_documents d WHERE d.order_id=o.id)
 ) AS context FROM orders o WHERE o.id=$1`,[orderId])).rows[0];
 if(!r)throw Error('Commande introuvable pour vérifier les mentions SKU');return digest(Buffer.from(JSON.stringify(r.context)));
}
export async function savedSkuCopy(db,bytes,key){
 const preserved=(await db.query('SELECT source_hash,pdf,order_id,created_at FROM label_sku_copies WHERE document_key=$1 ORDER BY created_at DESC,id DESC LIMIT 1',['preserved:'+key])).rows[0];
 if(preserved){if(preserved.source_hash!==digest(bytes))throw Error('Source de l’étiquette préservée modifiée : rapprochement requis. Aucun PDF remplacé.');return equivalentSkuEdition(db,preserved,key);}
 const row=(await db.query('SELECT pdf,order_id,context_hash FROM label_sku_copies WHERE document_key=$1 AND source_hash=$2 ORDER BY created_at DESC,id DESC LIMIT 1',[key,digest(bytes)])).rows[0];
 if(!row)return null;if(!row.context_hash||row.context_hash!==await skuContextHash(db,row.order_id))throw Error('Copie SKU devenue obsolète : la commande, le BL ou le colis a changé. Contrôler les mentions avant toute impression. Aucune nouvelle étiquette achetée.');return Buffer.from(row.pdf);
}
function glsNote(doc,page,block,fontName){
 if(Math.abs(page.getWidth()-283.465)>1||Math.abs(page.getHeight()-425.197)>1)return null;
 const td=/70\.86614 (-22\.17323|-30\.67717) Td/.exec(block);if(!td)return null;
 const hex=/<([a-fA-F0-9]+)> Tj/.exec(block),literal=/\(((?:\\[\s\S]|[^\\)])*)\) Tj/.exec(block);if(!hex&&!literal)return null;
 let bytes=hex?Buffer.from(hex[1],'hex'):Buffer.from(literal[1].replace(/\\([0-7]{1,3}|[\s\S])/g,(_,x)=>/^[0-7]/.test(x)?String.fromCharCode(parseInt(x,8)):({n:'\n',r:'\r',t:'\t',b:'\b',f:'\f'})[x]??x),'latin1');
 let value;if(block.includes('/Helvetica-SkuCopy '))value=bytes.toString('latin1');
 else {
  // GLS resource names vary by template (F1 can be bold and F2 regular).
  // Decode with the font active at this text block, never a guessed resource.
  const f=fontName&&page.node.Resources().lookup(PDFName.of('Font'))?.lookup(PDFName.of(fontName));if(!String(f?.get(PDFName.of('BaseFont'))).includes('NotoSansDisplayCondensed-Regular'))return null;
  const cmap=f.lookup(PDFName.of('ToUnicode'));if(!(cmap instanceof PDFRawStream)||bytes.length%2)return null;
  const mapping=new Map(),text=Buffer.from(decodePDFRawStream(cmap).decode()).toString('latin1');
  for(const part of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g))for(const m of part[1].matchAll(/<([\da-f]+)>\s*<([\da-f]+)>\s*<([\da-f]+)>/gi)){const lo=parseInt(m[1],16),hi=parseInt(m[2],16),base=parseInt(m[3],16);if(hi-lo>65536)throw Error('Police GLS invalide');for(let i=lo;i<=hi;i++)mapping.set(i,String.fromCodePoint(base+i-lo));}
  value='';for(let i=0;i<bytes.length;i+=2){const char=mapping.get(bytes.readUInt16BE(i));if(char===undefined)return null;value+=char;}
 }
 return {value,td:td[0],size:8,bold:false,x:70.86614,y:51.023613763775984+Number(td[1]),width:206,gls:true};
}
// Only V3-authored Helvetica text in the SKU area is editable. Embedded carrier
// artwork, tracking, recipient strings are never rewritten. Only the V3 SKU/unit annotation is editable.
export async function skuTextBlocks(bytes,kind){
 const doc=await PDFDocument.load(bytes);const blocks=[];
 for(const [pageIndex,page] of doc.getPages().entries()){
  const contents=page.node.Contents();const refs=contents instanceof PDFArray?contents.asArray():[page.node.get(PDFName.of('Contents'))];
  for(const ref of refs){const stream=doc.context.lookup(ref);if(!(stream instanceof PDFRawStream))continue;
   const text=Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1');
   for(const match of text.matchAll(/BT\b[\s\S]*?\bET/g)){
    if(String(kind).startsWith('gls')){const fontName=[...text.slice(0,match.index+match[0].length).matchAll(/\/((?!Helvetica-SkuCopy\b)[^\s/]+)\s+[\d.]+\s+Tf\b/g)].at(-1)?.[1];const note=glsNote(doc,page,match[0],fontName);if(note&&/ \([\d ,.]+(?: pcs)?\)/.test(note.value))blocks.push({pageIndex,ref,text,block:match[0],...note});continue;}
    const block=match[0],font=/\/(Helvetica(?:-Bold)?-[\d]+) ([\d.]+) Tf/.exec(block),tm=/1 0 0 1 ([\d.]+) ([\d.]+) Tm/.exec(block),hex=/<([A-Fa-f0-9]+)> Tj/.exec(block);
    if(!font||!tm||!hex)continue;const x=Number(tm[1]),y=Number(tm[2]);
    const safe=kind==='gofo'?x===93&&(y===64||y===72):kind==='temu'?x===9&&font[1].startsWith('Helvetica-Bold-'):false;
    if(!safe)continue;const value=Buffer.from(hex[1],'hex').toString('latin1');
    if(!/ \([\d ,.]+(?: pcs)?\)/.test(value))continue;
    blocks.push({pageIndex,ref,text,block,value,hex:hex[1],size:Number(font[2]),bold:font[1].startsWith('Helvetica-Bold-'),x,y,width:kind==='gofo'?128:page.getWidth()-18});
   }
  }
 }
 return {doc,blocks};
}
export async function replaceSkuText(bytes,kind,replacements){
 if(!Array.isArray(replacements)||!replacements.length||replacements.length>100)throw Error('Indiquer au moins un SKU à remplacer.');
 const seen=new Set();for(const r of replacements){if(typeof r.from!=='string'||typeof r.to!=='string'||!r.from.trim()||!r.to.trim()||r.from.length>100||r.to.length>100||/[\x00-\x1f()]/.test(r.from+r.to)||seen.has(r.from))throw Error('Correspondance SKU invalide ou dupliquée.');if(r.units!==undefined&&(!Number.isSafeInteger(r.units)||r.units<=0))throw Error('Nombre d’unités invalide : entier positif requis.');seen.add(r.from);}
 const {doc,blocks}=await skuTextBlocks(bytes,kind);const changes=[],counts=new Map(replacements.map(r=>[r.from,0]));
 const fonts={regular:await doc.embedFont(StandardFonts.Helvetica),bold:await doc.embedFont(StandardFonts.HelveticaBold)};
 const streams=new Map();
 for(const b of blocks){
  // One pass prevents A->B followed by B->C from accidentally becoming A->C.
  const value=b.value.replace(/(^|(?<=\) ))([^()]+?) \(([\d ,.]+)( pcs)?\)/g,(whole,start,sku,units,suffix)=>{
   const r=replacements.find(r=>r.from===sku);if(!r)return whole;counts.set(r.from,counts.get(r.from)+1);return start+r.to+' ('+(r.units===undefined?units:String(r.units))+(suffix||'')+')';
  });
  if(value===b.value)continue;const font=b.bold?fonts.bold:fonts.regular;
  const width=font.widthOfTextAtSize(value,b.size);if(width>b.width)throw Error('SKU trop long pour la zone existante : '+value+'. Aucune modification enregistrée.');
  const encoded=font.encodeText(value).toString().slice(1,-1);
  if(b.gls)doc.getPages()[b.pageIndex].node.setFontDictionary(PDFName.of('Helvetica-SkuCopy'),font.ref);
  const block=b.gls?'q\nBT\n/Helvetica-SkuCopy 8 Tf\n'+b.td+'\n<'+encoded+'> Tj\nET\nQ':b.block.replace('<'+b.hex+'> Tj','<'+encoded+'> Tj');
  streams.set(b.ref,(streams.get(b.ref)||b.text).replace(b.block,block));changes.push({page:b.pageIndex+1,x:b.x,y:b.y,width:b.width,height:b.size*1.5,before:b.value,after:value});
 }
 for(const r of replacements)if(!counts.get(r.from))throw Error('SKU introuvable dans la zone modifiable : '+r.from+'. Le PDF est conservé.');
 for(const [ref,text] of streams){const replacement=doc.context.flateStream(Buffer.from(text,'latin1'));if(!(ref instanceof PDFRef))throw Error('Structure PDF non compatible');doc.context.assign(ref,replacement);}
 if(!changes.length)throw Error('Aucune mention SKU ou unités modifiée.');
 return {pdf:Buffer.from(await doc.save()),changes};
}
export async function saveSkuCopy(db,item,replacements,user){
 if((await db.query('SELECT id FROM label_sku_copies WHERE document_key=$1 LIMIT 1',['preserved:'+item.key])).rows.length)throw Error('Étiquette existante protégée : ses mentions et son suivi doivent rester inchangés.');
 if(item.grouped)throw Error('Colis TEMU partagé entre plusieurs commandes : correction SKU groupée non disponible. Aucune étiquette modifiée.');
 const result=await replaceSkuText(item.current,item.kind,replacements);const id=randomUUID();
 const contextHash=await skuContextHash(db,item.orderId);
 if(item.contextHash&&contextHash!==item.contextHash)throw Error('Commande modifiée pendant la correction : actualisez avant de confirmer.');
 await db.query('INSERT INTO label_sku_copies(id,document_key,order_id,source_hash,context_hash,before_pdf,pdf,replacements,user_email) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id,item.key,item.orderId,digest(item.raw),contextHash,item.current,result.pdf,JSON.stringify(replacements),user]);
 await db.query("INSERT INTO audit(user_email,action,detail) VALUES($1,'label.sku_units.updated',$2)",[user,JSON.stringify({id,orderId:item.orderId,key:item.key,replacements,trackingUnchanged:true,erplainChanged:false,beforeHash:digest(item.current),afterHash:digest(result.pdf)})]);
 return {...result,id};
}



// An edition is derived from the retained PDF and committed substitutions.
// It never writes a carrier document, buys a label or checks Erplain/stock.
export async function equivalentSkuEdition(db,preserved,key){
 const original=Buffer.from(preserved.pdf);
 try{
  const order=(await db.query('SELECT id,carrier,partial_mode FROM orders WHERE id=$1',[preserved.order_id])).rows[0];
  // A replacement of the remainder does not change already delivered parcels.
  if(!order||order.partial_mode||key.startsWith('partial:'))return original;
  let kind=key.startsWith('temu:')?'temu':order.carrier;
  if(key.startsWith('extra:'))kind=(await db.query('SELECT carrier FROM extra_parcels WHERE id=$1',[key.slice(6)])).rows[0]?.carrier||kind;
  const [,reference,packageSn]=key.startsWith('temu:')?key.split(':'):[];
  const substitutions=(await db.query(`SELECT detail FROM audit WHERE action='order.product_substituted' AND created_at >= $2 AND
   (detail->>'orderId'=$1 OR detail->>'orderId' IN (
    SELECT o.id FROM orders o WHERE o.partial_mode=false AND o.reference IN (
     SELECT a->>'parentOrderSn' FROM temu_label_jobs j
     CROSS JOIN LATERAL jsonb_array_elements(coalesce(j.result->'packageInfoResultList','[]'::jsonb)) p
     CROSS JOIN LATERAL jsonb_array_elements(coalesce(p->'orderSendInfoList','[]'::jsonb)) a
     WHERE j.reference=$3 AND p->>'packageSn'=$4))) ORDER BY created_at,id`,[order.id,preserved.created_at,reference||null,packageSn||null])).rows.map(r=>r.detail);
  if(!substitutions.length)return original;
  return await renderEquivalentSkuEdition(original,kind,substitutions);
 }catch{return original;} // Edition errors never become a new shipping gate.
}

export async function renderEquivalentSkuEdition(bytes,kind,substitutions){
 const {doc,blocks}=await skuTextBlocks(bytes,kind),streams=new Map();
 let changed=false;const fonts={};
 const format=n=>new Intl.NumberFormat('fr-FR',{useGrouping:false,maximumFractionDigits:6}).format(n);
 for(const b of blocks){
  let value=b.value;
  for(const r of substitutions){
   const from=String(r.originalSku||''),to=String(r.replacementSku||''),oldQty=Number(r.replaceQuantity),newQty=Number(r.replacementQuantity);
   if(!from||!to||!(oldQty>0)||!(newQty>0)||!Number.isFinite(oldQty+newQty))continue;
   const escaped=from.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
   value=value.replace(new RegExp('(^|[ ;])'+escaped+' \\(([\\d ,.]+)( pcs)?\\)','g'),(all,prefix,units,suffix)=>{
    const quantity=Number(units.replace(/ /g,'').replace(',','.'));
    if(!Number.isFinite(quantity))return all;
    const rest=quantity>oldQty?from+' ('+format(quantity-oldQty)+(suffix||'')+') ; ':'';
    return prefix+rest+to+' ('+format(Math.min(quantity,oldQty)*newQty/oldQty)+(suffix||'')+')';
   });
  }
  if(value===b.value)continue;
  const style=b.bold?'bold':'regular';fonts[style]??=await doc.embedFont(b.bold?StandardFonts.HelveticaBold:StandardFonts.Helvetica);
  const font=fonts[style],size=Math.min(b.size,b.width/Math.max(1,font.widthOfTextAtSize(value,1)));
  const name=b.gls?'Helvetica-SkuCopy':b.bold?'Helvetica-Bold-910141':'Helvetica-910141';
  doc.getPages()[b.pageIndex].node.setFontDictionary(PDFName.of(name),font.ref);
  const encoded=font.encodeText(value).toString().slice(1,-1);
  const block=b.gls?'q\nBT\n/'+name+' '+size+' Tf\n'+b.td+'\n<'+encoded+'> Tj\nET\nQ':b.block.replace(/\/(Helvetica(?:-Bold)?-[\d]+) [\d.]+ Tf/,'/'+name+' '+size+' Tf').replace('<'+b.hex+'> Tj','<'+encoded+'> Tj');
  streams.set(b.ref,(streams.get(b.ref)||b.text).replace(b.block,block));changed=true;
 }
 if(!changed)return Buffer.from(bytes);
 for(const [ref,text] of streams)doc.context.assign(ref,doc.context.flateStream(Buffer.from(text,'latin1')));
 return Buffer.from(await doc.save());
}
