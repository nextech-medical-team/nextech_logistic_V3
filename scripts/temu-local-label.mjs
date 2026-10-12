import {PDFDocument,StandardFonts,rgb} from 'pdf-lib';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import path from 'node:path';
export function labelIdentity(order,state){
 if(state.companyId!==101406||!state.complete||state.version!==2||state.pending||state.error||!state.bc?.id||!state.bl?.id||state.bl.status!=='pending')throw Error('BC et BL Erplain TEST vérifiés requis avant l’étiquette');
 return createHash('sha256').update(JSON.stringify([order.id,order.reference,state.bc.id,state.bl.id,state.fingerprint,state.pricing?.items])).digest('hex');
}
export async function localLabelPdf(order,state){
 const key=labelIdentity(order,state),pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica),bold=await pdf.embedFont(StandardFonts.HelveticaBold);
 const lines=[['ETIQUETTE TEST - NE PAS EXPEDIER',true],['Simulation locale, sans valeur transporteur',false],['TEST-'+key.slice(0,16),false],['Commande : '+order.reference,true],['BC : '+state.bc.label,false],['BL : '+state.bl.label,false],['Destinataire :',true],[order.recipient,false],[order.address.street,false],[order.address.postal+' '+order.address.city,false],[order.address.country,false],['Produits :',true],...(state.pricing?.items||[]).filter(l=>l.variant).map(l=>[l.description+' x '+l.quantity,false]),['Aucun achat ni suivi transporteur reel',true]];
 let page,y=0;for(const [raw,emphasis]of lines){
  const text=Array.from(String(raw)).map(c=>{try{font.encodeText(c);return c;}catch{return c.normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^\x20-\x7e]/g,'?');}}).join('');
  const chunks=text.match(/.{1,48}/g)||[''];for(const chunk of chunks){if(y<35){page=pdf.addPage([340,480]);y=450;}page.drawText(chunk,{x:18,y,size:emphasis?10:9,font:emphasis?bold:font,color:emphasis?rgb(.6,0,0):rgb(0,0,0)});y-=18;}y-=5;
 }
 pdf.setTitle('ETIQUETTE TEST - '+order.reference);pdf.setSubject('Simulation locale uniquement. Ne pas expédier.');return Buffer.from(await pdf.save());
}
export function localLabels({db,documents,directory}){
 async function context(id){const order=(await db.query('SELECT * FROM orders WHERE id=$1',[id])).rows[0];if(!order||order.channel!=='temu')throw Error('Commande TEMU locale introuvable');const state=await documents.state(order.reference);return {order,state,key:labelIdentity(order,state)};}
 async function info(order,state){try{const key=labelIdentity(order,state);await readFile(path.join(directory,key+'.pdf'));return {key,url:'/api/local-erplain/label/'+encodeURIComponent(order.id),environment:'simulation',name:'Étiquette TEST — ne pas expédier'};}catch(e){if(e.code==='ENOENT'||!state.complete||state.pending||state.error)return null;return null;}}
 async function create(id){const {order,state,key}=await context(id);await mkdir(directory,{recursive:true,mode:0o700});const filename=path.join(directory,key+'.pdf');try{await readFile(filename);}catch(e){if(e.code!=='ENOENT')throw e;const temp=filename+'.tmp';await writeFile(temp,await localLabelPdf(order,state),{mode:0o600});await rename(temp,filename);}const label=await info(order,state);await db.query('UPDATE orders SET label_status=$2 WHERE id=$1',[id,'simulated']);return label;}
 async function bytes(id){const {key}=await context(id);return readFile(path.join(directory,key+'.pdf'));}
 return {info,create,bytes};
}
