const problemFilter=document.createElement('select');problemFilter.id='problem-type';problemFilter.multiple=true;

for(const [value,title]of [['partial','Quantités restant à allouer'],['mapping','Mapping manquant'],['product','Produit Erplain'],['weight','Poids'],['stock','Stock insuffisant'],['address','Adresse'],['routing','Règle transport'],['api','Erreur API'],['uncertain','Création à vérifier'],['bc','Commande et BC différents'],['relay','Relais GLS'],['pdf','PDF en attente'],['other','Autre erreur']])problemFilter.add(new Option(title,value));

document.querySelector('#view-orders .filters').append(problemFilter);compactFilter('problem-type','Type de problème');

problemFilter.onchange=()=>{page=1;selected.clear();show('orders');};

const resetOctober=resetFilters; // the original function is constant; extend the clear action.

$('clear-filters').onclick=()=>{resetOctober();problemFilter.selectedIndex=-1;compactFilters.forEach(x=>x.sync());show('orders');};

function countryLabel(code){try{return new Intl.DisplayNames(['fr'],{type:'region'}).of(code);}catch{return code||'Pays à renseigner';}}

const octoberOrders=orders;orders=async function(){await octoberOrders();for(const row of $('order-rows').rows){const ref=row.querySelector('[data-detail]');if(!ref)continue;const cell=row.cells[6],small=cell?.querySelector('small'),match=small?.textContent.match(/^([A-Z]{2}) · /);if(match&&!ref.parentElement.querySelector('.order-country')){const code=match[1],tag=document.createElement('small');tag.className='order-country';const img=document.createElement('img');img.src='/flags/'+code+'.svg';img.alt='';img.width=20;img.height=14;img.onerror=()=>img.remove();tag.append(img,document.createTextNode(countryLabel(code)));ref.parentElement.append(tag);small.textContent=small.textContent.slice(5);}}};

