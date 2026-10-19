import test from 'node:test';
import assert from 'node:assert/strict';
import {currentProblemClassifier} from '../src/problem-typology-reader.mjs';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const presentation=vm.createContext({});
vm.runInContext(readFileSync(new URL('../public/compact-problems.js',import.meta.url),'utf8'),presentation);

test('detailed views retain shortage quantities, provider reasons and HTTP response details',()=>{
 const shortage='Produit de remplacement [B] : stock insuffisant. Quantité totale nécessaire : 96 unités ; stock disponible : 13 unités ; quantité manquante : 83 unités.';
 const detail=presentation.displayErrorDetail(shortage);
 assert.ok(detail.startsWith('Bloqué : stock insuffisant'));
 assert.ok(detail.includes('stock disponible : 13'));assert.ok(detail.includes('quantité manquante : 83'));
 const refusal='TEMU · Étiquette refusée : The shipping address contains non-English characters.';
 assert.ok(presentation.displayErrorDetail(refusal).includes('non-English characters'));
 const error=Object.assign(Error('Erreur de lecture synthétique'),{status:400});
 assert.ok(presentation.displayErrorDetail(error).includes('Erreur de lecture synthétique'));
 assert.equal(error.message,'Erreur de lecture synthétique');assert.equal(error.status,400);
 assert.equal(presentation.displayErrorDetail('Bloqué : stock insuffisant'),'Bloqué : stock insuffisant');
});

test('reported duplicate labels collapse without merging independent causes',()=>{
 const classify=currentProblemClassifier();
 const groups=[
  ['Erplain · Rapprochement requis avant nouvelle création',['rapprochement requis, aucune nouvelle creation automatique','rapprochement requis, aucune nouvelle création automatique']],
  ['GLS · Numéro de suivi à vérifier',['GLS · Aucun numéro de suivi PROD utilisable. Vérifiez le résultat de création existant avant toute nouvelle étiquette.','GLS · Numéro de suivi absent pour le colis principal.']],
  ['Validation stock / BL à actualiser',['Validation stock / BL à effectuer','Validation stock / BL à actualiser','Étiquette bloquée : contrôle du stock et BL validé requis.']]
 ];
 for(const [expected,reasons]of groups)for(const reason of reasons){
  const p=classify({issue:reason})[0];assert.equal(p.label,expected);assert.equal(p.detail,reason);
  assert.equal(presentation.displayErrorMessage(reason),expected);
 }
 assert.equal(classify({issue:'Client Erplain · Création à vérifier'})[0].label,'Client Erplain · Création à vérifier');
 assert.equal(classify({issue:'deadlock detected'})[0].label,'V3 · Conflit temporaire de traitement');
 for(const reason of ['Erplain temporairement limité : vérification et reprise automatiques programmées','Incident temporaire Erplain : rapprochement et reprise automatique en attente (0/3)'])assert.notEqual(classify({issue:reason})[0].type,'api-limit');
 assert.notEqual(classify({issue:'Stock : vérification impossible — Réservation BC sans débit physique non confirmée'})[0].type,'stock');
});

test('all V3 channels and error sources agree with inline and HTML presentation',()=>{
 const classify=currentProblemClassifier();
 const reasons=['Stock insuffisant : ABC','Stock cumulé insuffisant : ABC','HTTP 429','429 Too Many Requests','Too Many Requests','HTTP 401','HTTP 403','HTTP 500','HTTP 502','HTTP 503','HTTP 504','fetch failed','AbortError','Stock non vérifiable','Mapping manquant','Poids non renseigné',
  'Commande annulée sur la plateforme','Commande modifiée sur la plateforme','Commande déjà expédiée sur la plateforme','Réponse API incomplète','SKU en doublon','Produit inactif','Produit introuvable','Poids non exploitable','Unité de poids invalide','Poids ou nombre de colis absent','Catalogue : synchronisation Erplain nécessaire','Commande V3 et BC différents','Règle transport manquante','Aucun point relais','ParcelShopID manquant','City information is incorrect','Informations transport manquantes : téléphone','BC Erplain · Création à vérifier','BL Erplain · Publication à vérifier','Stock Erplain · Mouvement à vérifier','Création incertaine','PDF en attente','Validation de la préparation nécessaire'];
 for(const channel of ['amazon','shopify','temu','tender','samples']){
  for(const source of ['issue','resolution_error','erp_live_job','carrier_job','temu_job']){
   const provider=source==='temu_job'?'TEMU':'Erplain';
   for(const reason of reasons){
    const order={channel,[source]:source.endsWith('_job')?{error:reason}:reason};
    const problem=classify(order)[0];
    assert.equal(presentation.displayErrorMessage(reason,provider),problem.label,`${channel}/${source}/${reason}`);
    assert.ok(presentation.errorDetailsHtml(reason,provider).startsWith(problem.label));
   }
  }
 }
});

test('HTTP status without a textual code is normalized without mutating recovery data',()=>{
 for(const status of [401,403,429,500,502,503,504]){
  const error=Object.assign(Error('Réponse fournisseur'),{status,retryable:true});
  const original=error.message;
  assert.equal(presentation.displayErrorMessage(error),presentation.displayErrorMessage('HTTP '+status));
  assert.equal(error.message,original);assert.equal(error.status,status);assert.equal(error.retryable,true);
 }
 assert.equal(presentation.displayErrorMessage('Motif métier spécifique'),'Motif métier spécifique');
 const html=presentation.errorDetailsHtml('HTTP 429 <script>alert(1)</script>');
 assert.ok(html.includes('Détail de l’erreur'));assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<script>'));
});

test('both V3 entries load the shared formatter before application scripts',()=>{
 for(const [entry,app] of [['index.html','app.js'],['receptions.html','receipt-recovery.js']]){
  const html=readFileSync(new URL('../public/'+entry,import.meta.url),'utf8');
  assert.ok(html.indexOf('/compact-problems.js')>=0);
  assert.ok(html.indexOf('/compact-problems.js')<html.indexOf('/'+app));
 }
});

test('real V3 HTTP helper and notification share the formatter and retain status and detail',async()=>{
 const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
 const flash={};
 const context=vm.createContext({$:()=>flash,warningText:String,setTimeout,clearTimeout});
 vm.runInContext(readFileSync(new URL('../public/compact-problems.js',import.meta.url),'utf8'),context);
 vm.runInContext(source.slice(source.indexOf('async function api('),source.indexOf('function flash(')),context);
 vm.runInContext(source.match(/^function flash\(.*$/m)[0],context);
 for(const path of ['/api/partial/prepare','/api/import','/api/temu/sync','/api/erplain/documents/refresh','/api/orders/processing']){
  for(const status of [401,403,429,500,502,503,504]){
   context.fetch=async()=>({ok:false,status,text:async()=>JSON.stringify({error:'HTTP '+status})});
   await assert.rejects(context.api(path),error=>{
    assert.equal(error.status,status);assert.equal(error.message,'HTTP '+status);
    context.flash(error,true);
    assert.equal(flash.textContent,context.displayErrorMessage(error));
    assert.equal(flash.textContent,context.displayErrorMessage('HTTP '+status,path.includes('/temu/')?'TEMU':'Erplain'));
    assert.equal(flash.title,error.message);
    return true;
   });
  }
 }
});

test('stock shortage variants share a label and retain the original detail',()=>{
 const classify=currentProblemClassifier();
 for(const reason of ['BL bloqué — stock insuffisant : ABC : 2 nécessaires, 0 utilisables, manque 2','Stock cumulé insuffisant : ABC','Produit de remplacement [ABC] : stock insuffisant.']){
  const problems=classify({issue:reason,sku_lines:[{sku:'ABC'}]});
  assert.equal(problems.length,1);
  assert.equal(problems[0].type,'stock');
  assert.equal(problems[0].label,'Bloqué : stock insuffisant');
  assert.equal(problems[0].sku,'ABC');
  assert.equal(problems[0].detail,reason);
 }
 for(const reason of ['Stock non vérifiable','Stock Erplain · Mouvement à vérifier : ABC']){
  assert.notEqual(classify({issue:reason})[0].type,'stock');
 }
});

test('429 formats share a label across job sources and retain provider and detail',()=>{
 const classify=currentProblemClassifier();
 for(const [field,provider] of [['issue','Erplain'],['resolution_error','Erplain'],['erp_live_job','Erplain'],['carrier_job','GLS'],['temu_job','TEMU']]){
  for(const reason of ['HTTP 429','429 Too Many Requests','Too Many Requests','Request failed with status code 429']){
   const order={carrier:'gls',[field]:field.endsWith('_job')?{error:reason}:reason};
   const problems=classify(order);
   assert.equal(problems.length,1);
   assert.equal(problems[0].type,'api-limit');
   assert.equal(problems[0].label,'API '+provider+' · Limite atteinte (429)');
   assert.equal(problems[0].detail,reason);
  }
 }
 assert.notEqual(classify({issue:'Référence 1429 introuvable'})[0].type,'api-limit');
 assert.equal(classify({issue:'Stock insuffisant : 429'})[0].type,'stock');
 assert.notEqual(classify({issue:'Quantité demandée : 429'})[0].type,'api-limit');
});
