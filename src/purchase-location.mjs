export const defaultReceptionLocationId='100934';
const normalized=value=>String(value??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().toLowerCase();
export function purchaseReceptionLocation(locations,source,override){
 if(override)return locations.filter(l=>String(l.id)===String(override));
 const name=normalized(source);
 if(!name||['default location','lieu principal','100934','default location [100934]'].includes(name))return locations.filter(l=>String(l.id)===defaultReceptionLocationId);
 return locations.filter(l=>String(l.id)===String(source).trim()||normalized(l.label)===name);
}
