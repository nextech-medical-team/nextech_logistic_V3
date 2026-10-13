import {withShipmentLock} from './shipment-lock.mjs';

// Call only after the shipment result has proved each package belongs to reference.
// The archive is permanent: no provenance flag, refresh or provider status can
// justify downloading a PDF which is already stored. Grouped orders share it.
export async function recoverMissingTemuPdfs(db,api,reference,details){
 const packages=details.map(p=>p.packageSn);
 return withShipmentLock(async()=>{
  const saved=new Set();
  for(const parcel of details){
   const references=[...new Set([reference,...parcel.orderSendInfoList.map(o=>o.parentOrderSn)])];
   const rows=(await db.query('SELECT reference,pdf FROM temu_label_documents WHERE package=$1 ORDER BY reference',[parcel.packageSn])).rows;
   if(!rows.length)continue;
   const local=rows.find(d=>d.reference===reference),document=local||rows.find(d=>references.includes(d.reference));
   if(!document)throw Error('TEMU · PDF déjà archivé pour une autre commande : vérifier le rattachement du colis, sans nouveau téléchargement');
   if(!document.pdf?.length)throw Error('TEMU · PDF archivé illisible : conserver le document et vérifier son archive, sans nouveau téléchargement');
   if(!local)await db.query('INSERT INTO temu_label_documents(reference,package,pdf) VALUES($1,$2,$3) ON CONFLICT(reference,package) DO NOTHING',[reference,parcel.packageSn,document.pdf]);
   saved.add(parcel.packageSn);
  }
  const missing=details.filter(p=>Number(p.shippingLabelStatus)===1&&!saved.has(p.packageSn)).map(p=>p.packageSn);
  let documentWarnings=[];
  if(missing.length){
   const docs=await api.read('bg.logistics.shipment.document.get',{documentType:'SHIPPING_LABEL_PDF',packageSnList:missing});
   documentWarnings=(Array.isArray(docs.warningMessage)?docs.warningMessage:docs.warningMessage?[docs.warningMessage]:[]).map(w=>String(w).slice(0,500));
   for(const document of docs.shippingLabelUrlList||[]){
    if(!missing.includes(document.packageSn)||document.documentType!=='SHIPPING_LABEL_PDF')throw Error('TEMU · Document associé à un autre colis');
    if(saved.has(document.packageSn))continue;
    const pdf=await api.pdf(document.url);
    await db.query('INSERT INTO temu_label_documents(reference,package,pdf) VALUES($1,$2,$3) ON CONFLICT(reference,package) DO NOTHING',[reference,document.packageSn,pdf]);
    saved.add(document.packageSn);
   }
  }
  const count=Number((await db.query('SELECT count(*) n FROM temu_label_documents WHERE reference=$1 AND package=ANY($2::text[]) AND octet_length(pdf)>0',[reference,packages])).rows[0].n);
  return {count,documentWarnings};
 },packages.map(p=>'temu-pdf:'+p));
}
