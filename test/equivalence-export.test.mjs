import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {shortageRows,exportEquivalences,readExportOrders} from '../src/equivalence-export.mjs';
import {parseEquivalenceFile} from '../src/equivalence-import-file.mjs';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {equivalenceImportService} from '../src/equivalence-import.mjs';
const line=(q,a=0,r=0)=>({type:'normal',quantity:q,available:a,on_hand:100,reserved_quantity:r,location:{id:'L'},variant:{id:'V',sku:'001',track_inventory:true}});
test('export asynchrone privé au compte et erreur lisible sans écriture',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'equivalence-route-'));
 try{
  await writeFile(path.join(directory,'live-workflow-references.json'),JSON.stringify({companyId:100174,locationId:1}));
  const service=equivalenceImportService({async query(sql){assert.match(sql,/^SELECT /);return {rows:[]};}},directory,{api:{async verify(){throw Error('Erplain indisponible');}}});
  let response;const context={req:{method:'GET'},res:{},user:{email:'a@test'},permitted(user,roles){assert.deepEqual(roles,['admin','manager']);},json(res,status,data){response=data;}};
  await service.routes({...context,p:'/api/equivalence-import/shortages'});const id=response.id;assert.equal(response.status,'checking');
  await service.routes({...context,p:'/api/equivalence-import/shortages'});assert.equal(response.id,id,'Reprendre le même export sans dupliquer les lectures');
  await assert.rejects(()=>service.routes({...context,user:{email:'b@test'},p:'/api/equivalence-import/export',url:new URL('http://local/?id='+id)}),/introuvable/);
  for(let i=0;i<100;i++){await new Promise(resolve=>setTimeout(resolve,10));await service.routes({...context,p:'/api/equivalence-import/export',url:new URL('http://local/?id='+id)});if(response.status==='failed')break;}
  assert.equal(response.status,'failed');assert.equal(response.error,'Erplain indisponible');
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('rupture réelle, réservations, regroupement et quantité entière',()=>{
 assert.deepEqual(shortageRows({line_items:[line(10,2,3)]}),[{sku:'001',quantity:10}]);
 assert.deepEqual(shortageRows({line_items:[line(10,7,3)]}),[]);
 assert.deepEqual(shortageRows({line_items:[line(6,10),line(6,10)]}),[{sku:'001',quantity:12}]);
 assert.throws(()=>shortageRows({line_items:[{...line(1),available:null}]}),/vérifiable/);
});
test('export complet, équivalence réciproque, choix humain et panne explicite',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'equivalence-export-'));
 try{
  await writeFile(path.join(directory,'live-workflow-references.json'),JSON.stringify({companyId:100174,locationId:1}));
  const db={async query(sql){assert.match(sql,/^SELECT /);return {rows:sql.includes('product_equivalences')?[{sku_a:'002',sku_b:'001',notes:'Alternative'}]:[{reference:'00042',erp_live:{bc:{id:'42'}}},{reference:'00043',erp_live:{bc:{id:'43'}}}]};}};
  const api={async verify(){},async request(q,v){assert.match(q,/^query /);if(q.includes('V3EquivalenceExportBatch'))return {o0:{id:v.b0,status:'active',line_items:[line(10)],shipping_orders:{data:[],paginatorInfo:{hasMorePages:false}}},o1:null,_v3Errors:[{path:['o1'],message:'Indisponible'}]};return {Variants:{data:[{id:'2',sku:'002',active:true,track_inventory:true,product:{active:true,label:'Alternative'},stock_levels:{data:[{location:{id:'1'},available:20,on_hand:20}],paginatorInfo:{hasMorePages:false}}}],paginatorInfo:{hasMorePages:false}}};}};
  const progress=[];const result=await exportEquivalences(db,api,directory,{onProgress:p=>progress.push({...p})});assert.equal(result.rows,1);assert.equal(result.unverified,1);assert.equal(progress.at(-1).processed,2);assert.equal(progress.at(-1).phase,'workbook');
  const book=new ExcelJS.Workbook();await book.xlsx.load(Buffer.from(result.file,'base64'));const s=book.getWorksheet('Onglet type');assert.equal(s.getCell('A2').value,'00042');assert.equal(s.getCell('C2').value,'');assert.equal(s.getCell('D2').value,10);assert.equal(book.getWorksheet('Équivalents proposés').getCell('D2').value,'002');assert.match(book.getWorksheet('Contrôles').getCell('B4').value,/partielle/);
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('36 BC lus en quatre requêtes avec quota simulé, toutes les lignes conservées',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'equivalence-batch-'));
 try{
  await writeFile(path.join(directory,'live-workflow-references.json'),JSON.stringify({companyId:100174,locationId:1}));
  const orders=Array.from({length:36},(_,i)=>({reference:'TEST-'+i,erp_live:{bc:{id:String(i+1)}}}));let calls=0,read=0;const progress=[];
  const db={async query(sql){return {rows:sql.includes('product_equivalences')?[]:orders};}};
  const api={async verify(){},async request(q,vars,attempt,partial){calls++;assert.equal(partial,true);assert.ok(Object.keys(vars).length<=10);await new Promise(r=>setTimeout(r,20));return Object.fromEntries(Object.entries(vars).map(([key,id])=>{read++;return ['o'+key.slice(1),{id,status:'active',line_items:[line(2)],shipping_orders:{data:[],paginatorInfo:{hasMorePages:false}}}];}));}};
  const result=await exportEquivalences(db,api,directory,{onProgress:p=>progress.push({...p})});assert.equal(calls,4);assert.equal(read,36);assert.equal(result.rows,36);assert.equal(result.unverified,0);assert.equal(progress.at(-1).processed,36);const book=new ExcelJS.Workbook();await book.xlsx.load(Buffer.from(result.file,'base64'));assert.equal(book.getWorksheet('Onglet type').rowCount,37);
  api.request=async()=>{throw Error('Quota indisponible');};const failed=await exportEquivalences(db,api,directory);assert.equal(failed.unverified,36);assert.equal(failed.rows,0);
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('une erreur GraphQL ne masque pas le BC voisin valide',async()=>{
 const rows=await readExportOrders({async request(){return {o0:{id:'1'},o1:null,_v3Errors:[{path:['o1','line_items']}]};}},[{erp_live:{bc:{id:'1'}}},{erp_live:{bc:{id:'2'}}}]);assert.equal(rows[0].error,null);assert.equal(rows[0].bc.id,'1');assert.match(rows[1].error,/partielle/);
});
test('modèle vierge, identifiants texte, compatible import après saisie',async()=>{
 const result=await exportEquivalences({query(){throw Error('DB interdite');}},{verify(){throw Error('API interdite');}},'',{template:true});
 const book=new ExcelJS.Workbook();await book.xlsx.load(Buffer.from(result.file,'base64'));const s=book.getWorksheet('Onglet type');assert.equal(s.rowCount,1);s.addRow(['00042','001','002',10]);
 const parsed=await parseEquivalenceFile(Buffer.from(await book.xlsx.writeBuffer()).toString('base64'));assert.equal(parsed[0].reference,'00042');assert.equal(parsed[0].sku,'001');assert.equal(parsed[0].replacementQuantity,10);
});
