import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {createTemuExcelTestDatabase as database} from './support/temu-excel-db.mjs';
import {randomUUID} from 'node:crypto';
import {temuExcelHeaders,temuExcelDate,parseTemuExcelFiles,previewTemuExcel,confirmTemuExcel,temuExcelImportRoutes} from '../src/temu-excel-import.mjs';

export const row=(reference='PO-TEST-001',overrides={})=>({reference,line:reference+'-ITEM',status:'Non expédié',itemStatus:'Non expédié',sku:'0000123',temuSku:'987654321012345',quantity:'2',remaining:'2',shipped:'0',cancelled:'0',name:'Client fictif',street1:'Rue de test',city:'Ville test',postal:'01000',country:'France',phone:'+33000000000',date:'12 oct. 2026, 07:44 WAT(UTC+1)',...overrides});
export async function file(rows,filename='test.xlsx',{headers=temuExcelHeaders,intro=5,formula=false}={}){
 const book=new ExcelJS.Workbook(),s=book.addWorksheet('Order report');
 for(let i=0;i<intro;i++)s.addRow(['Texte d’introduction']);
 s.addRow(Object.values(headers));
 for(const r of rows)s.addRow(Object.keys(headers).map(k=>r[k]??''));
 if(formula)s.getRow(intro+2).getCell(Object.keys(headers).indexOf('sku')+1).value={formula:'1+1',result:2};
 book.addWorksheet('Approved courier list').addRow(['Ne pas importer cette feuille']);
 return {filename,content:Buffer.from(await book.xlsx.writeBuffer()).toString('base64')};
}
test('un ou plusieurs fichiers : pays depuis les cellules, regroupement produits et SKU conservés',async()=>{
 const france=await file([row(),row('PO-TEST-001',{line:'SECOND',sku:'B',quantity:'1',remaining:'1'})],'nom-libre.xlsx');
 const italy=await file([row('PO-TEST-002',{country:'Italy',postal:1234})],'autre.xlsx');
 const one=await parseTemuExcelFiles([france]);assert.equal(one.orders.length,1);assert.equal(one.orders[0].lines.length,2);
 const result=await parseTemuExcelFiles([france,italy]);assert.deepEqual(result.errors,[]);assert.equal(result.orders.length,2);
 assert.equal(result.orders[0].lines[0].source_sku,'0000123');assert.equal(result.orders[1].address.country,'IT');assert.equal(result.orders[1].address.postal,'01234');
 assert.equal(result.orders[0].source_date,'2026-10-12T06:44:00.000Z');
});
test('28 pays en un seul lot, colonnes réordonnées et sans lignes d’introduction',async()=>{
 const codes=['FR','IT','NL','ES','DE','BE','AT','PL','PT','IE','DK','SE','FI','GR','CZ','SK','SI','HR','HU','RO','BG','EE','LV','LT','LU','MT','CY','GB'];
 const reversed=Object.fromEntries(Object.entries(temuExcelHeaders).reverse());
 const files=await Promise.all(codes.map((country,i)=>file([row('PO-TEST-'+i,{country})],i+'.xlsx',{headers:reversed,intro:0})));
 const result=await parseTemuExcelFiles(files);assert.equal(result.orders.length,28);assert.deepEqual(result.errors,[]);
 assert.deepEqual(result.orders.map(o=>o.country),codes);
});
test('répétitions identiques ignorées, conflits de ligne ou pays bloquent toute la commande',async()=>{
 const first=await file([row()]);
 const repeated=await parseTemuExcelFiles([first,{...first,filename:'copie.xlsx'}]);assert.equal(repeated.orders.length,1);assert.equal(repeated.orders[0].lines.length,1);assert.equal(repeated.repeatedLines,1);
 for(const overrides of [{quantity:'3',remaining:'3'},{country:'Italy'}]){
  const parsed=await parseTemuExcelFiles([first,await file([row('PO-TEST-001',overrides)],'different.xlsx')]);
  assert.ok(parsed.orders[0].issues.length);assert.ok(parsed.errors.length);
 }
});
test('ligne invalide, article annulé, adresse masquée et formule excluent toute leur commande',async()=>{
 for(const overrides of [{sku:''},{quantity:'0'},{quantity:'1.5'},{status:'Expédié'},{cancelled:'1'},{remaining:'1'},{street1:'***'},{country:'Inconnu'},{date:'12/10/2026'}]){
  const parsed=await parseTemuExcelFiles([await file([row(),row('PO-TEST-001',{line:'SECOND',...overrides})])]);assert.ok(parsed.orders[0].issues.length,JSON.stringify(overrides));
 }
 const formula=await parseTemuExcelFiles([await file([row()],undefined,{formula:true})]);assert.ok(formula.errors.length);
 const unreadable=await parseTemuExcelFiles([await file([row(),row('',{line:'OTHER'})])]);assert.ok(unreadable.orders[0].issues.length);
});
test('fichier incorrect signalé sans perdre les fichiers valides ; limites et dates strictes',async()=>{
 const parsed=await parseTemuExcelFiles([{filename:'corrompu.xlsx',content:Buffer.from('invalid').toString('base64')},await file([row()])]);assert.equal(parsed.orders.length,1);assert.equal(parsed.errors.length,1);
 await assert.rejects(parseTemuExcelFiles([]),/1 à 50/);await assert.rejects(parseTemuExcelFiles(Array(51).fill({})),/1 à 50/);
 await assert.rejects(parseTemuExcelFiles([{filename:'a.csv',content:'AAAA'}]),/XLSX/);
 const oversized=Buffer.alloc(12*1024*1024+1).toString('base64');await assert.rejects(parseTemuExcelFiles([{filename:'large.xlsx',content:oversized}]),/12 Mo|invalide/);
 assert.throws(()=>temuExcelDate('31 févr. 2026, 12:00 WAT(UTC+1)'),/invalide/);
 assert.equal(temuExcelDate('12 oct. 2026, 01:30 UTC(UTC-2)'),'2026-10-12T03:30:00.000Z');
});
test('aperçu sans écriture, import sélectionné suspendu, réimport et concurrence sans écrasement',async()=>{
 const db=await database();try{
  const files=[await file([row(),row('PO-TEST-002'),row('PO-TEST-003',{country:'Italy'})])];
  const preview=await previewTemuExcel(db,files);assert.equal(preview.newCount,3);assert.equal((await db.query('SELECT * FROM orders')).rows.length,0);
  const input={files,hash:preview.hash,requestId:randomUUID(),selection:['PO-TEST-001','PO-TEST-002']},user={email:'test@example.invalid'};
  // Another importer inserts one of the orders between preview and confirmation.
  await db.query("INSERT INTO orders(id,channel,reference,source_reference,recipient,archived) VALUES('existing','temu','PO-TEST-002','PO-TEST-002','Ne pas modifier',true)");
  const result=await confirmTemuExcel(db,input,user);assert.equal(result.created,1);assert.equal(result.skipped,1);assert.equal(result.excluded,1);
  const orders=(await db.query('SELECT * FROM orders ORDER BY reference')).rows;assert.equal(orders.length,2);assert.equal(orders[0].suspension.active,true);assert.equal(orders[0].resolution_pending_resume,true);assert.equal(orders[1].recipient,'Ne pas modifier');
  assert.equal((await db.query('SELECT * FROM jobs')).rows.length,0);assert.equal((await db.query('SELECT * FROM lines')).rows.length,1);
  assert.equal((await db.query('SELECT * FROM order_suspension_events')).rows.length,1);
  assert.equal((await confirmTemuExcel(db,input,user)).replayed,true);
  await assert.rejects(confirmTemuExcel(db,{...input,selection:['PO-TEST-003']},user),/autre sélection/);
  await assert.rejects(confirmTemuExcel(db,{...input,hash:'bad'},user),/changé/);
  const next=await previewTemuExcel(db,files);assert.equal(next.duplicateCount,2);assert.equal(next.newCount,1);
  const repeat=await confirmTemuExcel(db,{...input,requestId:randomUUID()},user);assert.equal(repeat.created,0);assert.equal(repeat.skipped,2);
  const all=await db.query('SELECT count(*) AS n FROM orders');assert.equal(Number(all.rows[0].n),2);
 }finally{await db.close();}
});
test('sélection invalide et route non autorisée : aucune écriture',async()=>{
 const db=await database();try{
  const files=[await file([row('PO-TEST-001',{sku:''}),row('PO-TEST-002')])],preview=await previewTemuExcel(db,files),user={email:'test'};
  for(const selection of [[],['PO-TEST-001'],['PO-UNKNOWN']])await assert.rejects(confirmTemuExcel(db,{files,hash:preview.hash,requestId:randomUUID(),selection},user));
  assert.equal((await db.query('SELECT * FROM import_receipts')).rows.length,0);
  await assert.rejects(temuExcelImportRoutes({p:'/api/import/temu/confirm',req:{method:'POST'},user:{role:'viewer'},permitted:(user,roles)=>{assert.ok(!roles.includes(user.role));throw Error('Droits insuffisants');},body:()=>{throw Error('Ne doit pas lire le corps');}}),/Droits/);
 }finally{await db.close();}
});
test('erreur pendant l’enregistrement : annulation de tout le lot et de son reçu',async()=>{
 const db=await database();try{
  await db.exec('ALTER TABLE lines ADD CONSTRAINT test_failure CHECK(quantity<5)');
  const files=[await file([row(),row('PO-TEST-002',{quantity:'6',remaining:'6'})])],preview=await previewTemuExcel(db,files);
  await assert.rejects(confirmTemuExcel(db,{files,hash:preview.hash,requestId:randomUUID(),selection:preview.orders.map(o=>o.reference)},{email:'test'}),/test_failure/);
  for(const table of ['orders','lines','import_receipts','order_suspension_events','audit'])assert.equal((await db.query('SELECT * FROM '+table)).rows.length,0,table);
 }finally{await db.close();}
});

test('formatted empty last Excel row does not reject two real orders; distant data still counts',async()=>{
 const input=await file([row('PO-DK-001',{country:'Denmark'}),row('PO-DK-002',{country:'Denmark'})]);
 const book=new ExcelJS.Workbook();await book.xlsx.load(Buffer.from(input.content,'base64'));
 const sheet=book.worksheets[0];sheet.getRow(1048576).height=18;sheet.getCell('CZ1048576').fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFFFFFFF'}};
 input.content=Buffer.from(await book.xlsx.writeBuffer()).toString('base64');
 const parsed=await parseTemuExcelFiles([input]);assert.deepEqual(parsed.errors,[]);assert.equal(parsed.orders.length,2);assert.equal(parsed.rows,2);
 sheet.getCell('CZ1048576').value='unexpected data';input.content=Buffer.from(await book.xlsx.writeBuffer()).toString('base64');
 const bad=await parseTemuExcelFiles([input]);assert.ok(bad.errors.length);assert.ok(bad.orders.every(o=>o.issues.length));
});
