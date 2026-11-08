// France uses Rozay; other shops retain the TEMU default warehouse selection.
export function selectTemuWarehouse(warehouses=[]){
 const france=warehouses.some(w=>['WH-03738368983180591','WH-07213277470860591'].includes(String(w.warehouseId)));
 if(!france){const usable=warehouses.filter(w=>w.enableBuyShippingLabel!==false),defaults=usable.filter(w=>w.defaultWarehouse);const warehouse=defaults.length===1?defaults[0]:usable.length===1?usable[0]:null;if(!warehouse?.warehouseId)throw Error('TEMU · Entrepôt absent ou ambigu');return warehouse;}
 const matches=warehouses.filter(w=>w.enableBuyShippingLabel!==false&&/(^|[^a-z])ro[sz]ay([^a-z]|$)/.test(String(w.warehouseName||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase()));
 if(matches.length!==1||!matches[0].warehouseId)throw Error('TEMU · Entrepôt Rozay absent, indisponible ou ambigu : configurer Rozay dans cette boutique avant de générer une étiquette');
 return matches[0];
}
