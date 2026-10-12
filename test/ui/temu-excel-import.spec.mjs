import {test,expect} from '@playwright/test';
import ExcelJS from 'exceljs';
import {previewTemuExcel,temuExcelHeaders} from '../../src/temu-excel-import.mjs';

async function excel(reference,country){
 const b=new ExcelJS.Workbook(),s=b.addWorksheet('Order report');
 for(let n=0;n<5;n++)s.addRow(['Introduction TEMU']);
 s.addRow(Object.values(temuExcelHeaders));
 const values={reference,line:reference+'-ITEM',status:'Non expédié',itemStatus:'Non expédié',sku:'000123',quantity:'1',remaining:'1',shipped:'0',cancelled:'0',name:'Client fictif',street1:'Rue test',postal:'01000',city:'Ville test',country,date:'12 oct. 2026, 07:44 WAT(UTC+1)'};
 s.addRow(Object.keys(temuExcelHeaders).map(k=>values[k]||''));
 return {name:country+'.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:Buffer.from(await b.xlsx.writeBuffer())};
}
for(const [device,viewport]of [['desktop',{width:1366,height:900}],['mobile',{width:390,height:844}]]){
 test('import TEMU multi-pays '+device,async({page})=>{
  await page.setViewportSize(viewport);
  const confirmations=[];
  await page.route('**/api/import/temu/preview',async route=>{
   const input=route.request().postDataJSON();
   const response=await previewTemuExcel({query:async()=>({rows:[]})},input.files);
   await route.fulfill({json:response});
  });
  await page.route('**/api/import/temu/confirm',async route=>{
   const input=route.request().postDataJSON();confirmations.push(input);
   await route.fulfill({json:{created:input.selection.length,skipped:0,errors:[],results:input.selection.map(reference=>({reference,country:'FR',status:'created'})),message:input.selection.length+' commandes TEMU importées en attente de validation. Aucune préparation lancée.'}});
  });
  await page.goto('/');await expect(page.locator('#page-info')).toContainText('120 commandes');await page.waitForFunction(()=>typeof show==='function'&&!!document.querySelector('#temu-excel-preview'));
  await page.evaluate(()=>show('imports'));
  await page.locator('#import-kind').selectOption('temu_excel');
  const france=await excel('PO-TEST-FR','France'),italy=await excel('PO-TEST-IT','Italy');
  await page.locator('#import-file').setInputFiles([france,italy]);
  await page.getByRole('button',{name:'Analyser les fichiers',exact:true}).click();
  const preview=page.locator('#temu-excel-preview');await expect(preview).toBeVisible();
  await expect(preview.locator('[data-summary]')).toContainText('2 fichier(s)');
  await expect(preview.locator('[data-countries]')).toContainText('FR');await expect(preview.locator('[data-countries]')).toContainText('IT');
  await expect(preview.locator('[data-orders] input:checked')).toHaveCount(2);expect(confirmations).toHaveLength(0);
  await preview.locator('[data-reference="PO-TEST-IT"]').uncheck();
  await expect(preview.locator('[data-selection]')).toContainText('1 commande(s)');
  await page.screenshot({path:'proofs/temu-excel-'+device+'.png',fullPage:true});
  await preview.getByRole('button',{name:'Importer les commandes sélectionnées'}).click();
  await expect(preview.locator('[data-result]')).toContainText('Aucune préparation lancée');
  expect(confirmations).toHaveLength(1);expect(confirmations[0].selection).toEqual(['PO-TEST-FR']);expect(confirmations[0].files).toHaveLength(2);
  await expect(preview.locator('[data-confirm]')).toBeDisabled();
  // Selecting a single file works too, without submitting until confirmed.
  await page.locator('#import-file').setInputFiles(france);await expect(preview).toBeHidden();
  await page.getByRole('button',{name:'Analyser les fichiers',exact:true}).click();
  await expect(preview.locator('[data-orders] input')).toHaveCount(1);expect(confirmations).toHaveLength(1);
  await page.locator('#import-kind').selectOption('amazon');await expect(preview).toBeHidden();
  await expect(page.locator('#import-button')).toHaveText('Analyser le fichier');
  expect(await page.locator('#import-file').evaluate(e=>e.multiple)).toBe(false);
 });
}
