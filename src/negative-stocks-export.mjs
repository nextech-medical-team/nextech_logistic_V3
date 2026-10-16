import ExcelJS from 'exceljs';

export async function exportNegativeStocks(rows){
 if(!Array.isArray(rows)||rows.length>100000||rows.some(row=>!row||typeof row.sku!=='string'||typeof row.label!=='string'||[row.available,row.onHand].some(value=>value!==null&&(typeof value!=='number'||!Number.isFinite(value)))))throw Error('Résultats de stock invalides');
 const book=new ExcelJS.Workbook(),sheet=book.addWorksheet('Stocks négatifs');
 sheet.columns=[{header:'SKU',key:'sku',width:28},{header:'Produit',key:'label',width:60},{header:'Fournisseur',key:'supplier',width:32},{header:'Disponible',key:'available',width:18},{header:'Physique',key:'onHand',width:18}];
 for(const row of rows)sheet.addRow({sku:row.sku,label:row.label,supplier:typeof row.supplier==='string'&&row.supplier?row.supplier:'Non renseigné',available:row.available??'Non vérifié',onHand:row.onHand??'Non vérifié'});
 sheet.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'}};
 sheet.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF127565'}};
 sheet.views=[{state:'frozen',ySplit:1}];sheet.autoFilter='A1:E'+Math.max(1,sheet.rowCount);
 return Buffer.from(await book.xlsx.writeBuffer());
}
