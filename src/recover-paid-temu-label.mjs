// Recover only existing paid packages when the order/quote read is unavailable.
// Parcel ownership and the permanent PDF archive remain the authority here.
export async function recoverPaidTemuLabel(db,service,order,orderReadWarning){
 const reference=order.reference;
 const known=(await db.query('SELECT packages FROM temu_label_jobs WHERE reference=$1',[reference])).rows[0];
 if(!Array.isArray(known?.packages)||!known.packages.length)return null;
 if(known.packages.some(p=>!/^PK-\d+$/.test(p)))throw Error('Colis TEMU enregistré invalide');
 const job=await service.recover(reference,{packages:known.packages});
 if(job.status!=='complete'||job.error)return null;
 const parcels=job.result?.packageInfoResultList;
 if(!Array.isArray(parcels)||parcels.length!==known.packages.length||new Set(parcels.map(p=>p.packageSn)).size!==known.packages.length||parcels.some(p=>!known.packages.includes(p.packageSn)||Number(p.shippingLabelStatus)!==1||!p.orderSendInfoList?.some(l=>l.parentOrderSn===reference)))throw Error('Étiquette payée : identité du colis non confirmée');
 const pdfs=(await db.query("SELECT package FROM temu_label_documents WHERE reference=$1 AND package=ANY($2::text[]) AND octet_length(pdf)>0",[reference,known.packages])).rows;
 if(new Set(pdfs.map(d=>d.package)).size!==known.packages.length)throw Error('Étiquette payée : PDF archivé incomplet');
 const verifiedAt=new Date().toISOString(),warning=String(orderReadWarning||'').slice(0,450);
 await db.transaction(async tx=>{
  const current=(await tx.query('SELECT source_payload,label_status FROM orders WHERE id=$1 FOR UPDATE',[order.id])).rows[0];
  if(!current)throw Error('Commande absente pendant récupération du PDF');
  const proof={source:'temu_direct',state:'verified',scope:'paid_label',verifiedAt,packages:known.packages,orderReadWarning:warning};
  await tx.query("UPDATE orders SET label_status=CASE WHEN label_status='cancelled' THEN label_status ELSE 'ready' END,source_payload=source_payload||$2::jsonb WHERE id=$1",[order.id,JSON.stringify({temuDirect:proof})]);
  await tx.query("INSERT INTO audit(user_email,action,detail) VALUES('system','temu.paid_label_recovered_despite_order_read_error',$1)",[JSON.stringify({orderId:order.id,reference,packages:known.packages,previousLabelStatus:current.label_status,previousDirect:current.source_payload?.temuDirect,orderReadWarning:warning,verifiedAt,purchaseCalls:0})]);
 });
 return {reference,status:'complete',documents:true,error:null,orderReadWarning:warning};
}
