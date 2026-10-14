import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {shortageRows,exportEquivalences} from '../src/equivalence-export.mjs';
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
  const api={async verify(){},async request(q,v){assert.match(q,/^query /);if(v.id==='43')throw Error('Indisponible');if(v.id)return {Order:{id:v.id,status:'active',line_items:[line(10)],shipping_orders:{data:[],paginatorInfo:{hasMorePages:false}}}};return {Variants:{data:[{id:'2',sku:'002',active:true,track_inventory:true,product:{active:true,label:'Alternative'},stock_levels:{data:[{location:{id:'1'},available:20,on_hand:20}],paginatorInfo:{hasMorePages:false}}}],paginatorInfo:{hasMorePages:false}}};}};
  const result=await exportEquivalences(db,api,directory);assert.equal(result.rows,1);assert.equal(result.unverified,1);
  const book=new ExcelJS.Workbook();await book.xlsx.load(Buffer.from(result.file,'base64'));const s=book.getWorksheet('Onglet type');assert.equal(s.getCell('A2').value,'00042');assert.equal(s.getCell('C2').value,'');assert.equal(s.getCell('D2').value,10);assert.equal(book.getWorksheet('Équivalents proposés').getCell('D2').value,'002');assert.match(book.getWorksheet('Contrôles').getCell('B4').value,/Indisponible/);
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('modèle vierge, identifiants texte, compatible import après saisie',async()=>{
 const result=await exportEquivalences({query(){throw Error('DB interdite');}},{verify(){throw Error('API interdite');}},'',{template:true});
 const book=new ExcelJS.Workbook();await book.xlsx.load(Buffer.from(result.file,'base64'));const s=book.getWorksheet('Onglet type');assert.equal(s.rowCount,1);s.addRow(['00042','001','002',10]);
 const parsed=await parseEquivalenceFile(Buffer.from(await book.xlsx.writeBuffer()).toString('base64'));assert.equal(parsed[0].reference,'00042');assert.equal(parsed[0].sku,'001');assert.equal(parsed[0].replacementQuantity,10);
});
