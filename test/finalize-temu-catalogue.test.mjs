import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import ExcelJS from 'exceljs';
import {finalize} from '../scripts/finalize-temu-catalogue.mjs';
const require=createRequire(import.meta.url);
test('export workbook preserves identifiers, hierarchy, missing categories and coverage',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'temu-catalogue-test-'));
 try{
  const report={startedAt:'2026-10-27T10:00:00Z',finishedAt:'2026-10-27T11:00:00Z',requestedCountries:['FR'],accounts:[{country:'FR',mallId:'670702094848591',products:2,unclassified:1,statuses:[{searchType:1,status:'complete'}]}]};
  await writeFile(path.join(directory,'bilan.json'),JSON.stringify(report));const folder=path.join(directory,'FR-670702094848591');await mkdir(folder);
  const rows=[{goodsId:608937424346592,goodsName:'Produit A',catId:8171,categoryPath:'Medical / Diagnostics / Stethoscopes',searchTypes:[1],skuIdList:[154249455532404]},{goodsId:608937424346593,goodsName:'Produit B',catId:7804,categoryPath:null,searchTypes:[1]}];
  await writeFile(path.join(folder,'produits.jsonl'),rows.map(JSON.stringify).join('\n'));
  const result=await finalize(directory,require.resolve('exceljs'));assert.equal(result.totalProducts,2);assert.equal(result.unclassified,1);assert.equal(result.publishedComplete,true);
  const workbook=new ExcelJS.Workbook();await workbook.xlsx.readFile(path.join(directory,'Catalogue-TEMU-tous-pays.xlsx'));const sheet=workbook.getWorksheet('FR - France');assert.equal(sheet.getCell('D2').value,'608937424346592');assert.equal(sheet.getCell('F2').value,'Medical');assert.equal(sheet.getCell('G2').value,'Diagnostics');assert.equal(sheet.getCell('F3').value,'À classer');assert.ok(sheet.autoFilter);
  const tree=JSON.parse(await readFile(path.join(directory,'categories-par-pays.json'),'utf8'));assert.equal(tree.FR.categories.Medical.subcategories.Diagnostics.count,1);
  report.accounts[0].products=3;await writeFile(path.join(directory,'bilan.json'),JSON.stringify(report));await assert.rejects(finalize(directory,require.resolve('exceljs')),/Nombre de produits incohérent/);
 }finally{await rm(directory,{recursive:true,force:true});}
});
