const problemFilter=document.createElement('select');problemFilter.id='problem-type';problemFilter.multiple=true;

// Options are loaded from current diagnostics across all pages.

document.querySelector('#view-orders .filters').append(problemFilter);compactFilter('problem-type','Type de problème');
const typologyBox=compactFilters.find(f=>f.box.previousElementSibling===problemFilter).box;
let typologyRequest=0;
typologyBox.addEventListener('toggle',async()=>{
 if(!typologyBox.open)return;
 const request=++typologyRequest,params=new URLSearchParams(lastOrdersQuery);params.delete('problem-label');params.delete('page');
 const initialScope=params.toString(),search=typologyBox.querySelector('input[type=search]');
 search.disabled=true;search.placeholder='Chargement des problèmes…';
 try{
  const result=await api('/api/order-problem-types?'+params);
  if(request!==typologyRequest||!typologyBox.open)return;
  const currentScope=new URLSearchParams(lastOrdersQuery);currentScope.delete('problem-label');currentScope.delete('page');
  if(currentScope.toString()!==initialScope)return;
  if(!Array.isArray(result.problemTypes))throw Error('Typologies de problèmes indisponibles');
  const chosen=new Set([...problemFilter.selectedOptions].map(o=>o.value)),types=new Map(result.problemTypes.map(t=>[t.label,t.count]));
  for(const label of chosen)if(!types.has(label))types.set(label,0);
  problemFilter.replaceChildren();const list=typologyBox.querySelector('.filter-options div');list.replaceChildren();
  for(const [label,count]of [...types].sort((a,b)=>a[0].localeCompare(b[0],'fr'))){
   const option=new Option(label+' ('+count+')',label);option.selected=chosen.has(label);problemFilter.add(option);
   const item=document.createElement('label'),check=document.createElement('input');check.type='checkbox';check.checked=option.selected;
   check.onchange=()=>{option.selected=check.checked;problemFilter.dispatchEvent(new Event('change'));};
   item.append(check,document.createTextNode(option.textContent));item.hidden=!option.textContent.toLowerCase().includes(search.value.toLowerCase());list.append(item);
  }
  if(!types.size){const empty=document.createElement('p');empty.textContent='Aucun problème observé pour ces filtres.';list.append(empty);}
  compactFilters.forEach(f=>f.sync());
 }catch(error){if(request===typologyRequest)flash('Chargement des problèmes impossible : '+error.message,true);}
 finally{if(request===typologyRequest){search.disabled=false;search.placeholder='Rechercher…';}}
});


problemFilter.onchange=()=>{page=1;selected.clear();show('orders');};

const resetOctober=resetFilters; // the original function is constant; extend the clear action.

$('clear-filters').onclick=()=>{resetOctober();problemFilter.selectedIndex=-1;compactFilters.forEach(x=>x.sync());show('orders');};

function countryLabel(code){try{return new Intl.DisplayNames(['fr'],{type:'region'}).of(code);}catch{return code||'Pays à renseigner';}}

const octoberOrders=orders;orders=async function(){await octoberOrders();for(const row of $('order-rows').rows){const ref=row.querySelector('[data-detail]');if(!ref||preservedOrderRows.has(ref.dataset.detail))continue;const cell=row.cells[6],small=cell?.querySelector('small'),match=small?.textContent.match(/^([A-Z]{2}) · /);if(match&&!ref.parentElement.querySelector('.order-country')){const code=match[1],tag=document.createElement('small');tag.className='order-country';const img=document.createElement('img');img.src='/flags/'+code+'.svg';img.alt='';img.width=20;img.height=14;img.onerror=()=>img.remove();tag.append(img,document.createTextNode(countryLabel(code)));ref.parentElement.append(tag);small.textContent=small.textContent.slice(5);}}};

