import {registerExternalLabel} from './temu-external-label.mjs';
import {labelAttachment} from './label-attachment.mjs';
import {relayConfig} from './temu-read-relay.mjs';
import {localTemuRows} from './temu-local.mjs';
import {currentTemuPdf} from './temu-label-pdf.mjs';

export async function temuRoutes({p,req,res,url,db,service,local,sync,user,json,body,permitted,audit}){

 if(!p.startsWith('/api/temu/'))return false;

 if(p==='/api/temu/local'&&req.method==='GET'){json(res,200,{rows:await localTemuRows(db)});return true;}

 if(p==='/api/temu/sync'&&req.method==='POST'){permitted(user,['admin','manager','operator']);const b=await body(req);await sync.enqueue(b.references||null,{force:true});json(res,202,await sync.status());return true;}
 if(p==='/api/temu/sync-status'&&req.method==='GET'){json(res,200,await sync.status());return true;}

 if(p==='/api/temu/status'){const relay=relayConfig();json(res,200,{configured:!!service,mode:'production',automaticPurchase:false,purchaseEnabled:!!service&&(!relay||relay.purchaseEnabled===true)});return true;}

 if(p==='/api/temu/history'){json(res,200,{rows:(await db.query('SELECT *, (SELECT json_agg(package) FROM temu_label_documents d WHERE d.reference=j.reference) documents FROM temu_label_jobs j ORDER BY updated_at DESC LIMIT 100')).rows});return true;}

 if(p==='/api/temu/pdf'&&req.method==='GET'){const reference=url.searchParams.get('reference'),packageSn=url.searchParams.get('package');const d=(await db.query('SELECT pdf FROM temu_label_documents WHERE reference=$1 AND package=$2',[reference,packageSn])).rows[0];if(!d){json(res,404,{error:'PDF indisponible'});return true;}const pdf=await currentTemuPdf(db,d.pdf,reference,packageSn);res.setHeader('Content-Type','application/pdf');res.setHeader('Cache-Control','no-store');await labelAttachment(db,res,'reference',reference,packageSn);res.end(pdf);return true;}

 if(p==='/api/temu/external-label'&&req.method==='POST'){permitted(user,['admin','manager','operator']);const result=await registerExternalLabel(db,await body(req),user);if(sync)await sync.enqueue([result.reference],{force:true}).catch(()=>{});json(res,200,result);return true;}
 if(p==='/api/temu/external-label/pdf'&&req.method==='GET'){const row=(await db.query('SELECT pdf FROM temu_external_label_documents WHERE order_id=$1',[url.searchParams.get('id')])).rows[0];if(!row){json(res,404,{error:'PDF externe absent'});return true;}res.setHeader('Content-Type','application/pdf');res.setHeader('Cache-Control','no-store');res.end(row.pdf);return true;}
 if(!service)throw new Error('Accès privés TEMU non configurés');

 if(p==='/api/temu/orders'&&req.method==='GET'){json(res,200,await local.list());return true;}

 if(req.method!=='POST')throw new Error('Action TEMU inconnue');

 permitted(user,['admin','manager','operator']);const b=await body(req);
 if(p==='/api/temu/prepare'){json(res,200,await local.prepare(b.reference,b.channelId));return true;}

 if(p==='/api/temu/buy'){if(b.confirmPurchase!==true)throw new Error('Confirmation explicite de l’achat requise');await audit(user,'temu.purchase.requested',{reference:b.reference,planId:b.planId,amount:b.amount});json(res,200,await local.buy(b.reference,b.planId,b.amount));return true;}

 if(p==='/api/temu/recover'){json(res,200,await local.recover(b.reference));return true;}

 throw new Error('Action TEMU inconnue');

}
