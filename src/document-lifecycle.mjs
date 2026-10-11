import {aggregateParcels,shippingTransition,automaticBilling,paymentAmount} from './status-policy.mjs';

// Store must persist checkpoints before mutations and lock by company + BL.
// Gateway must be an Erplain LIVE gateway. An uncertain creation is never retried blindly.
export function documentLifecycle({gateway,store,onStatus=async()=>{}}){
 return {async resume(input){
  if(!/^\d+$/.test(String(input.blId)))throw Error('Identifiant BL absent ou invalide');
  return store.withLock(String(input.blId),async()=>{
   await gateway.verifyLive();
   const journal=await store.read(String(input.blId));
   const save=async()=>store.save(String(input.blId),journal);
   let bl=await gateway.readBL(input.blId);
   if(!bl||String(bl.id)!==String(input.blId))throw Error('Erplain · BL non confirmé');
   const cancelledBC=bl.orders?.data?.some(o=>o.status==='cancelled');
   if(input.cancellationConfirmed&&input.bcId){
    if(!bl.orders?.data?.some(o=>String(o.id)===String(input.bcId)))throw Error('Erplain · BC à annuler non rattaché au BL');
    if(!bl.orders.data.find(o=>String(o.id)===String(input.bcId))?.status?.includes('cancelled'))await gateway.cancelOrder(input.bcId);
   }
   if(!['pending','unpublished'].includes(bl.status)&&!journal.readyConsumed){journal.readyConsumed=true;await save();}
   const tracking=aggregateParcels(input.expectedTracking||[],input.events||[]);
   const cancellationConfirmed=input.cancellationConfirmed===true||cancelledBC===true;
   let target=cancellationConfirmed?'cancelled':['shipped','delivered'].includes(tracking.status)?tracking.status:input.preparationComplete?'ready_to_ship':null;
   if(target){
    const decision=shippingTransition({current:bl.status,target,readyConsumed:!!journal.readyConsumed,preparationComplete:input.preparationComplete===true,cancellationConfirmed});
    if(decision.write){
     // Ready is consumed before requesting it: an ambiguous response cannot repeat it.
     if(target==='ready_to_ship')journal.readyConsumed=true;
     journal.statusIntent={from:bl.status,to:target,at:new Date().toISOString()};await save();
     await gateway.setBLStatus(input.blId,target);
     bl=await gateway.readBL(input.blId);
     if(bl?.status!==target)throw Error('Erplain · Statut non confirmé');
     journal.statusConfirmed=journal.statusIntent;delete journal.statusIntent;await save();
    }
   }
   await onStatus(bl,input);
   if(bl.status!=='delivered'||!automaticBilling(input.channel))return {bl,tracking,billing:automaticBilling(input.channel)?'not_due':'manual'};
   // All invoicing is scoped to this BL, never to its parent BC.
   if(!Array.isArray(bl.invoices)||bl.invoicesCount!==bl.invoices.length)throw Error('Erplain · Historique des factures incomplet');
   if(bl.invoices.some(i=>i.status==='cancelled'))throw Error('Erplain · Facture annulée à vérifier');
   if(bl.invoices.length>1)throw Error('Erplain · Plusieurs factures à rapprocher');
   if(bl.invoices[0]?.id&&journal.invoiceId&&String(bl.invoices[0].id)!==String(journal.invoiceId))throw Error('Erplain · Facture différente du traitement précédent');
   // Erplain hides unpublished invoices from BL.invoices. Recover the saved ID
   // and validate Invoice.shipping_orders before publishing; never create again.
   let invoiceId=bl.invoices[0]?.id||journal.invoiceId;
   if(!invoiceId){
    if(journal.invoiceIntent)throw Error('Erplain · Création de facture à rapprocher avant reprise');
    if(gateway.validateBillingSource)await gateway.validateBillingSource(input.blId);
    journal.invoiceIntent={at:new Date().toISOString(),blId:String(input.blId)};await save();
    const created=await gateway.createInvoiceFromBL(input.blId);
    if(!created?.id)throw Error('Erplain · Création de facture non confirmée');
    invoiceId=created.id;journal.invoiceId=String(invoiceId);await save();
   }
   let invoice=await gateway.readInvoice(invoiceId);
   await gateway.validateInvoiceForBL(invoice,bl);
   if(['unpublished','draft'].includes(invoice.status)){
    // Never finalize a document after cancellation discovered during processing.
    if((await gateway.readBL(input.blId)).status!=='delivered')throw Error('Erplain · Livraison modifiée pendant la facturation');
    if(invoice.status==='unpublished'){await gateway.publishInvoiceDraft(invoice);invoice=await gateway.readInvoice(invoiceId);}
    if(invoice.status!=='draft')throw Error('Erplain · Brouillon de facture non confirmé');
    await gateway.finalizeInvoice(invoice,{channel:input.channel,sourcePayload:input.sourcePayload});invoice=await gateway.readInvoice(invoiceId);
   }
   if(!['unpaid','partially_paid','paid'].includes(invoice.status))throw Error('Erplain · Statut facture incompatible');
   bl=await gateway.readBL(input.blId);
   if(bl.status!=='delivered'||bl.invoices?.length!==1||String(bl.invoices[0].id)!==String(invoiceId))throw Error('Erplain · Rattachement facture au BL non confirmé');
   await gateway.validateInvoiceForBL(invoice,bl);
   let remaining=paymentAmount(invoice);
   if(!remaining){if(invoice.status!=='paid')throw Error('Erplain · Paiement non confirmé');journal.completedAt=new Date().toISOString();await save();return {bl,tracking,invoice,billing:'paid'};}
   if(journal.paymentIntent)throw Error('Erplain · Paiement précédent à rapprocher avant reprise');
   if((await gateway.readBL(input.blId)).status!=='delivered')throw Error('Erplain · Livraison modifiée avant paiement');
   // Re-read immediately before payment to account for manual/partial payments.
   invoice=await gateway.readInvoice(invoiceId);remaining=paymentAmount(invoice);
   if(!remaining){if(invoice.status!=='paid')throw Error('Erplain · Paiement non confirmé');return {bl,tracking,invoice,billing:'paid'};}
   const method=await gateway.existingPaymentMethod(invoice);
   journal.paymentIntent={invoiceId:String(invoiceId),amount:remaining,previousPaid:Number(invoice.paid_amount),at:new Date().toISOString()};await save();
   await gateway.createPayment(invoice,{amount:remaining,method,date:input.paymentDate||new Date().toLocaleDateString('sv-SE',{timeZone:'Europe/Paris'})});
   invoice=await gateway.readInvoice(invoiceId);
   if(paymentAmount(invoice)!==0||invoice.status!=='paid')throw Error('Erplain · Paiement non confirmé');
   journal.completedAt=new Date().toISOString();await save();
   return {bl,tracking,invoice,billing:'paid'};
  });
 }};
}
