import test from 'node:test';
import assert from 'node:assert/strict';
import {createTrackingTestDb} from './support/tracking-db.mjs';
import {initializeTrackingSync} from '../src/tracking-sync-history.mjs';
import {loadTrackingExport,trackingWorkbook} from '../src/tracking-sync-export.mjs';
import {trackingSyncRoutes} from '../src/tracking-sync-service.mjs';
const ExcelJS=(await import(process.env.NEXTECH_TEST_EXCELJS_MODULE||'exceljs')).default;

test('Excel : toutes les pages, statuts réels et proposés, historique complet, identifiants texte',async()=>{
 const db=await createTrackingTestDb();
 try{
  await initializeTrackingSync(db);
  await db.exec(`UPDATE orders SET tracking_status='shipped' WHERE id='o1';
   INSERT INTO tracking_sync_observations(target_key,order_id,reference,result)
   SELECT repeat(md5(i::text),2),'o1',CASE WHEN i=1 THEN '=SUM(1,2)' ELSE 'REF-'||i END,
   jsonb_build_object('blId','00020','carrier','gls','tracking',jsonb_build_array('00001234567890123456789'),
    'carrierStatus','delivered','lastKnownErplain','shipped','proposed','delivered','outcome','proposed',
    'carrierObservedAt','2026-10-10T10:00:00Z','error',CASE WHEN i=2 THEN 'Quota API atteint' ELSE null END,
    'events',jsonb_build_array(jsonb_build_object('carrier','gls','tracking','00001234567890123456789','code','DELIVERED','label','=EXTERNAL()','at','2026-10-10T09:00:00Z')))
   FROM generate_series(1,60) i;
   INSERT INTO tracking_sync_changes(target_key,carrier_before,carrier_after,erplain_before,erplain_after)
   SELECT o.target_key,'shipped','delivered','shipped','delivered' FROM tracking_sync_observations o CROSS JOIN generate_series(1,2) i;`);
  const data=await loadTrackingExport(db);
  assert.equal(data.rows.length,60);assert.equal(data.changes.length,120);
  const bytes=await trackingWorkbook(data,ExcelJS);
  const book=new ExcelJS.Workbook();await book.xlsx.load(bytes);
  assert.deepEqual(book.worksheets.map(s=>s.name),['Statuts','Historique','Événements','Informations']);
  const s=book.getWorksheet('Statuts');assert.equal(s.rowCount,61);
  const column=header=>s.getRow(1).values.indexOf(header);
  const formulaRow=s.getRow(2);assert.equal(formulaRow.getCell(1).value,'=SUM(1,2)');assert.equal(formulaRow.getCell(1).formula,undefined);
  assert.equal(formulaRow.getCell(column('BL Erplain')).value,'00020');
  assert.equal(formulaRow.getCell(column('Numéros de suivi')).value,'00001234567890123456789');
  assert.equal(formulaRow.getCell(column('Statut commande V3')).value,'Expédié');
  assert.equal(formulaRow.getCell(column('Statut BL dans V3')).value,'Non vérifié');
  assert.equal(formulaRow.getCell(column('Statut transporteur')).value,'Livré');
  assert.equal(formulaRow.getCell(column('Statut Erplain connu')).value,'Expédié');
  assert.equal(formulaRow.getCell(column('Statut Erplain proposé')).value,'Livré');
  assert.equal(formulaRow.getCell(column('Contrôle transporteur / Erplain')).value,'Écart à vérifier');
  assert.equal(book.getWorksheet('Historique').rowCount,121);
  assert.equal(book.getWorksheet('Événements').getCell('H2').value,'=EXTERNAL()');
  assert.equal(book.getWorksheet('Événements').getCell('H2').formula,undefined);
  const filtered=await loadTrackingExport(db,{search:'REF-2'});
  assert.equal(filtered.rows.length,11);assert.equal(filtered.changes.length,22);
  assert.ok(filtered.rows.every(r=>r.reference.includes('REF-2')));
  const empty=await loadTrackingExport(db,{search:'ABSENT'});
  const emptyBook=new ExcelJS.Workbook();await emptyBook.xlsx.load(await trackingWorkbook(empty,ExcelJS));
  assert.equal(emptyBook.getWorksheet('Statuts').rowCount,1);
 }finally{await db.close();}
});

test('route Excel : téléchargement autorisé au lecteur, filtres transmis, accès anonyme refusé',async()=>{
 let received;const headers={};let bytes;
 const context={p:'/api/tracking-sync/export.xlsx',url:new URL('http://localhost/api/tracking-sync/export.xlsx?search=REF-2'),req:{method:'GET'},res:{setHeader:(k,v)=>headers[k]=v,end:b=>bytes=b},user:{role:'viewer'},
  service:{exportExcel:async options=>{received=options;return Buffer.from('PK-test');}},permitted:(u,roles)=>{if(!u||!roles.includes(u.role))throw Object.assign(Error('Droits insuffisants'),{status:403});}};
 assert.equal(await trackingSyncRoutes(context),true);
 assert.deepEqual(received,{search:'REF-2',runId:null});
 assert.match(headers['Content-Type'],/spreadsheetml/);assert.match(headers['Content-Disposition'],/attachment.*\.xlsx/);
 assert.equal(bytes.toString(),'PK-test');
 await assert.rejects(trackingSyncRoutes({...context,user:null}),{status:403});
});
