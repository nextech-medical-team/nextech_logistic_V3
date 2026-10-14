(()=>{
 const body=document.getElementById('order-rows'),table=body?.closest('table');if(!table)return;
 const weights={reference:1.35,manager:.9,date:.8,bc:.9,bl:.9,recipient:1.2,sku:1.35,carrier:1.1,label:1.5,tracking:1,'erplain-tracking':1,'platform-status':1,'country-margin':1};
 const modal=document.createElement('dialog');modal.id='order-information-dialog';modal.className='order-information-dialog';modal.setAttribute('aria-labelledby','order-information-title');
 modal.innerHTML='<header><h2 id="order-information-title"></h2><button type="button" data-close-information>Fermer</button></header><p data-information-feedback role="status"></p><div class="order-information-fields"></div>';document.body.append(modal);
 modal.querySelector('[data-close-information]').onclick=()=>modal.close();
 function openInformation(row){
  const reference=row.querySelector('[data-detail],[data-delivery-detail]');if(!reference)return;
  modal.querySelector('h2').textContent='Informations · '+reference.textContent.trim();modal.querySelector('[data-information-feedback]').textContent='';
  const fields=modal.querySelector('.order-information-fields');fields.replaceChildren();
  const headings=[...table.tHead.rows[0].cells];
  for(const [index,cell]of [...row.cells].entries()){
   if(index===0)continue;
   const section=document.createElement('section'),title=document.createElement('h3'),content=document.createElement('div');
   title.textContent=headings[index]?.textContent.replace(/[↕↗]/g,'').trim()||'Informations';
   const copy=cell.cloneNode(true),originalControls=[...cell.querySelectorAll('button,a,input,select,textarea,[role="button"]')],copies=[...copy.querySelectorAll('button,a,input,select,textarea,[role="button"]')],stocks=[...cell.querySelectorAll('[data-stock-information]')],stockCopies=[...copy.querySelectorAll('[data-stock-information]')];
   for(const element of [copy,...copy.querySelectorAll('*')])for(const attr of [...element.attributes])if(attr.name==='id'||attr.name.startsWith('data-')||['aria-controls','aria-labelledby','aria-describedby'].includes(attr.name))element.removeAttribute(attr.name);
   for(const [i,info]of stockCopies.entries())window.V3StockInformation?.populate(info,stocks[i].dataset.stockInformation);
   for(const [i,control]of copies.entries()){
    const original=originalControls[i];
    if(original.matches('[data-order-more-info],.processing-details-toggle')){control.remove();continue;}
    control.addEventListener('click',event=>{
     event.preventDefault();event.stopImmediatePropagation();
     if(!original.isConnected||original.disabled){control.disabled=true;modal.querySelector('[data-information-feedback]').textContent='Cette action a changé. Fermez puis rouvrez les informations pour consulter son état actuel.';return;}
     modal.close();original.click();
    },true);
   }
   while(copy.firstChild)content.append(copy.firstChild);section.append(title,content);fields.append(section);
  }
  if(!modal.open)modal.showModal();
 }
 function layout(){
  const headings=[...table.tHead.rows[0].cells],visible=headings.filter(h=>!h.classList.contains('total-quantity-column'));
  const columns=visible.map(h=>h.dataset.column==='select'?'28px':'minmax(0,'+(weights[h.dataset.column]||1)+'fr)').join(' ');
  if(table.style.getPropertyValue('--order-fixed-columns')!==columns)table.style.setProperty('--order-fixed-columns',columns);
  table.classList.add('orders-fixed-layout');
  for(const row of body.rows){
   const reference=row.querySelector('[data-detail],[data-delivery-detail]');
   if(!reference){for(const cell of row.cells)cell.style.gridColumn='1 / -1';continue;}
   let column=0;
   for(const [index,cell]of [...row.cells].entries()){
    const heading=headings[index];if(!heading)continue;
    cell.dataset.fixedColumn=heading.dataset.column||String(index);cell.dataset.orderColumn=heading.textContent.replace(/[↕↗]/g,'').trim();
    if(heading.classList.contains('total-quantity-column'))continue;
    const position=String(++column);if(cell.style.gridColumn!==position)cell.style.gridColumn=position;
   }
   if(!row.querySelector('[data-order-more-info]')){
    const button=document.createElement('button');button.type='button';button.dataset.orderMoreInfo='';button.className='order-more-information';button.textContent='Plus d’informations';button.setAttribute('aria-haspopup','dialog');button.onclick=()=>openInformation(row);reference.closest('td').append(button);
   }
  }
 }
 // Only structural table changes need layout; ticking durations do not.
 new MutationObserver(records=>{if(records.some(r=>r.target===body||r.target.nodeName==='TR'))layout();}).observe(table,{childList:true,subtree:true});
 layout();
})();
